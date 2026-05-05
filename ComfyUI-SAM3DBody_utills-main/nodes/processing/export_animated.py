"""SAM 3D Body: export an animated rigged FBX from a video (a batch of
images, typically produced by ComfyUI-VideoHelperSuite's
`VHS_LoadVideo`).

The character is rigged **once** at its rest pose (body_pose = 0) — the
same bind-pose convention used by `SAM3DBodyExportRiggedFBX`. Every
input frame then contributes a keyframe on the pose bones, producing a
multi-frame animation clip suitable for motion-capture use.

Heavy lifting (armature, vertex groups, FBX export) happens in a
Blender subprocess via `tools/build_animated_fbx.py`.
"""

import os
import json
import tempfile
import subprocess
import time

import cv2
import numpy as np
import torch

from .process import (
    _load_sam3d_model,
    _get_mhr_rest_verts,
    _FACE_BS_CACHE,
    _apply_face_blendshapes,
    _apply_bone_length_scales,
    _to_batched_tensor,
)
from .export_rigged import (
    _KNOWN_JOINT_NAMES,
    _SHAPE_SLIDER_NORM,
    _SHAPE_SLIDER_SIGN,
    _unpack_batched,
    _scale_skeleton_rest,
    _DEFAULT_BLENDER,
)


_UTILS_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_BUILD_SCRIPT = os.path.join(_UTILS_ROOT, "tools", "build_animated_fbx.py")

# MHR joint indices for the feet, used by the ground-lock correction.
# Keep in sync with _KNOWN_JOINT_NAMES in export_rigged.py.
_FOOT_JOINT_L = 4    # foot_l
_FOOT_JOINT_R = 20   # foot_r

_ROOT_MOTION_MODES = ("auto_ground_lock", "free", "xz_only")


def _comfy_frame_to_bgr(image_tensor, frame_idx):
    """Extract frame `frame_idx` from a ComfyUI IMAGE tensor [B,H,W,C]
    (float RGB 0..1) and return an OpenCV-ready uint8 BGR ndarray."""
    frame = image_tensor[frame_idx].detach().cpu().numpy()
    frame = (frame * 255.0).clip(0, 255).astype(np.uint8)
    return frame[..., ::-1].copy()  # RGB -> BGR


def _mask_frame_bbox(mask_np_2d):
    """Derive a single-human bbox [[x1,y1,x2,y2]] from a 2-D mask; return
    None if the mask is empty."""
    rows = np.any(mask_np_2d > 0.5, axis=1)
    cols = np.any(mask_np_2d > 0.5, axis=0)
    if not rows.any() or not cols.any():
        return None
    rmin, rmax = np.where(rows)[0][[0, -1]]
    cmin, cmax = np.where(cols)[0][[0, -1]]
    return np.array([[cmin, rmin, cmax, rmax]], dtype=np.float32)


def _as_vec3(value):
    """Normalise a value-of-unknown-type (torch.Tensor / np.ndarray / list /
    None) into a float32 3-vector, or return None if it can't be
    reduced to three scalars. Used to pull `pred_cam_t` from the raw
    estimator output regardless of how the model packages it."""
    if value is None:
        return None
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    try:
        arr = np.asarray(value, dtype=np.float32).reshape(-1)
    except Exception:
        return None
    if arr.size < 3:
        return None
    return arr[:3].copy()


def _normalise_translations(raw_trans):
    """Turn the list of per-frame cam translations (each either a 3-vec
    or None) into a dense [N, 3] list anchored on the first detected
    frame: before any detection we emit zeros; after that, missing
    detections reuse the most recent known translation; the whole
    trajectory is shifted so the anchor frame sits at the origin."""
    n = len(raw_trans)
    if n == 0:
        return []
    anchor = None
    last_known = np.zeros(3, dtype=np.float32)
    out = []
    for t in raw_trans:
        if t is not None:
            if anchor is None:
                anchor = t.copy()
            last_known = t
        if anchor is None:
            out.append(np.zeros(3, dtype=np.float32))
        else:
            out.append((last_known - anchor).astype(np.float32))
    return [v.tolist() for v in out]


# =========================================================================
# Contact-based ground lock
# =========================================================================
# Per-frame foot-contact detection + anchored Y correction. Replaces the
# naive global-min approach so that walking / running / one-foot balance /
# jumping all produce a grounded trajectory at once. See the README
# section "root_motion_mode" for the design rationale.

# Pose Y threshold: a foot is "low" if its pose-frame Y sits within this
# distance of the rest foot Y. Pose-frame Y is drift-free, so this is a
# tight discriminator between grounded and lifted feet.
_GL_Y_THR = 0.15

# World Y velocity threshold for "still" feet. We use WORLD (not pose)
# Y velocity here: during a straight-body jump the pose Y barely moves
# but the WORLD Y does, so this is the only signal that correctly
# excludes flight frames as non-contact.
_GL_V_THR = 0.03

# Minimum run length for a contact label (debounces single-frame flicker).
_GL_MIN_CONTACT_RUN = 2

# Savitzky-Golay smoothing applied to the final offset curve.
_GL_SMOOTH_WINDOW = 5
_GL_SMOOTH_ORDER = 2

# If fewer than this many frames end up flagged as contact, fall back to
# the simple global-min approach so the pipeline always produces *some*
# correction.
_GL_MIN_CONTACTS_TOTAL = 3


def _y_central_diff(y):
    """Absolute-value central difference along axis 0 of a [N, ...] array.
    Edges use one-sided differences. Returns same shape as input."""
    n = y.shape[0]
    out = np.zeros_like(y)
    if n < 2:
        return out
    out[1:-1] = np.abs(y[2:] - y[:-2]) / 2.0
    out[0] = np.abs(y[1] - y[0])
    out[-1] = np.abs(y[-1] - y[-2])
    return out


def _apply_contact_hysteresis(is_contact_raw, min_run):
    """Zero out contact runs shorter than `min_run` consecutive frames.
    Works column-wise (each foot independently)."""
    n, nf = is_contact_raw.shape
    out = np.zeros_like(is_contact_raw)
    for f in range(nf):
        col = is_contact_raw[:, f]
        i = 0
        while i < n:
            if col[i]:
                j = i
                while j < n and col[j]:
                    j += 1
                if (j - i) >= min_run:
                    out[i:j, f] = True
                i = j
            else:
                i += 1
    return out


def _fill_nan_linear(arr):
    """Linearly interpolate NaNs in a 1-D array. Leading/trailing NaN
    runs get hold-extrapolated to the nearest finite value."""
    arr = arr.copy()
    nan_mask = np.isnan(arr)
    if not nan_mask.any():
        return arr
    if nan_mask.all():
        return np.zeros_like(arr)
    valid_idx = np.where(~nan_mask)[0]
    # np.interp clamps out-of-range x to yp[0] / yp[-1], which is the
    # hold-extrapolation we want for leading/trailing NaN.
    all_idx = np.arange(len(arr))
    arr[nan_mask] = np.interp(all_idx[nan_mask], valid_idx, arr[valid_idx])
    return arr


def _smooth_offset(offset, window, order):
    """Savitzky-Golay smoothing with a moving-average fallback if scipy
    is missing or the signal is too short for the requested window."""
    n = len(offset)
    if n < window or window < 3:
        return offset
    try:
        from scipy.signal import savgol_filter
        return savgol_filter(offset, window_length=window, polyorder=order).astype(np.float32)
    except Exception:
        # Odd-window moving average with edge padding.
        k = window // 2
        padded = np.pad(offset, k, mode='edge')
        kernel = np.ones(window, dtype=np.float32) / float(window)
        return np.convolve(padded, kernel, mode='valid').astype(np.float32)


def _compute_ground_lock_offset(feet_pos_arr, trans_arr, rest_foot_y):
    """Per-frame Y correction using contact-based anchoring.

    feet_pos_arr : [N, 2, 3] pose-frame foot positions (trans=0)
    trans_arr    : [N, 3]    current (uncorrected) root translations
    rest_foot_y  : scalar    rest-pose ground-level foot Y (MHR native)

    Returns a 1-D np.float32 array of length N that should be ADDED to
    trans_arr[:, 1] to pin the currently-supporting foot to the ground.

    Algorithm (see docstring of module-level _GL_* constants):
      1. Contact mask = (low in pose) AND (still in world).
      2. Hysteresis debounce.
      3. Anchor Y per frame = min contact-foot world Y (NaN if no contact).
      4. Linear interp over NaN gaps (flight phases).
      5. offset = rest_foot_y - anchor_y, Savitzky-Golay smoothed.
      6. Fallback: too few contacts -> global-min correction (scalar).
    """
    n = feet_pos_arr.shape[0]
    if n == 0:
        return np.zeros(0, dtype=np.float32)

    pose_feet_y = feet_pos_arr[..., 1].astype(np.float32)  # [N, 2]
    world_feet_y = pose_feet_y + trans_arr[:, 1:2].astype(np.float32)  # [N, 2]

    # 1. Contact detection.
    is_low = pose_feet_y <= (rest_foot_y + _GL_Y_THR)
    world_y_vel = _y_central_diff(world_feet_y)
    is_still = world_y_vel <= _GL_V_THR
    is_contact_raw = is_low & is_still

    # 2. Hysteresis.
    is_contact = _apply_contact_hysteresis(is_contact_raw, _GL_MIN_CONTACT_RUN)

    contact_frame_count = int(is_contact.any(axis=1).sum())
    if contact_frame_count < _GL_MIN_CONTACTS_TOTAL:
        # Fallback: clipwide global min (the old auto_ground_lock).
        min_world = float(world_feet_y.min())
        correction = float(rest_foot_y - min_world)
        print(
            f"[SAM3DBody] ground_lock fallback "
            f"({contact_frame_count}/{n} contact frames < "
            f"{_GL_MIN_CONTACTS_TOTAL}): global min correction={correction:+.3f}"
        )
        return np.full(n, correction, dtype=np.float32)

    # 3. Per-frame anchor Y (NaN where no contact).
    anchor_y = np.full(n, np.nan, dtype=np.float32)
    for i in range(n):
        row_mask = is_contact[i]
        if row_mask.any():
            anchor_y[i] = float(world_feet_y[i, row_mask].min())

    # 4. Fill flight-phase NaN via linear interpolation.
    anchor_y = _fill_nan_linear(anchor_y)

    # 5. Offset + smoothing.
    offset = (rest_foot_y - anchor_y).astype(np.float32)
    offset = _smooth_offset(offset, _GL_SMOOTH_WINDOW, _GL_SMOOTH_ORDER)

    print(
        f"[SAM3DBody] ground_lock contact-based: "
        f"{contact_frame_count}/{n} frames with contact, "
        f"offset range=[{float(offset.min()):+.3f}, {float(offset.max()):+.3f}], "
        f"mean={float(offset.mean()):+.3f}"
    )
    return offset


class SAM3DBodyExportAnimatedFBX:
    """Write an animated rigged FBX from a video (IMAGE batch).

    Typical wiring:
        VHS_LoadVideo         ──► images
        LoadSAM3DBodyModel    ──► model
        RenderFromJson   ──► character_json (settings_json output)

    The character_json supplies body shape / bone lengths / blendshapes
    (identical to SAM3DBodyExportRiggedFBX). The rig is created at the
    rest pose, then each input frame is run through SAM 3D Body to
    produce per-frame joint rotations, which Blender bakes into a clip.
    """

    @classmethod
    def INPUT_TYPES(cls):
        character_placeholder = (
            "{\n"
            '  "_slot": "=== CHARACTER JSON ===",\n'
            '  "_hint": "Paste Render node\'s settings_json output here.",\n'
            '  "body_params":   {},\n'
            '  "bone_lengths":  {},\n'
            '  "blendshapes":   {}\n'
            "}"
        )
        return {
            "required": {
                "model": ("SAM3D_MODEL", {
                    "tooltip": "Load SAM 3D Body Model ノードの出力",
                }),
                "images": ("IMAGE", {
                    "tooltip": "【動画フレーム】\n"
                               "VideoHelperSuite の VHS_LoadVideo などで読み込んだ"
                               "連続フレーム ([B,H,W,C] 形式の IMAGE)。",
                }),
                "character_json": ("STRING", {
                    "multiline": True, "default": character_placeholder,
                    "tooltip": "【キャラクター設定 JSON】\n"
                               "Render ノードの settings_json 出力を接続する、"
                               "または chara_settings_presets/*.json の内容を貼り付け。\n"
                               "リグは basic pose (body_pose=0) で生成され、"
                               "フレームごとに関節回転のみキーフレーム化される。",
                }),
                "fps": ("FLOAT", {
                    "default": 30.0, "min": 1.0, "max": 240.0, "step": 1.0,
                    "tooltip": "出力アニメーションのフレームレート。",
                }),
                "bbox_threshold": ("FLOAT", {
                    "default": 0.8, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "人物検出の信頼度しきい値。",
                }),
                "inference_type": (["full", "body", "hand"], {
                    "default": "full",
                    "tooltip": "full: body+hand / body: body のみ / hand: hand のみ",
                }),
                "root_motion_mode": (list(_ROOT_MOTION_MODES), {
                    "default": "auto_ground_lock",
                    "tooltip": "ルート位置 (Y 軸) の補正モード。\n"
                               "auto_ground_lock: クリップ全体の足最下点を rest 足 Y に揃え、"
                               "浮き / 沈みを解消しつつジャンプは保持 (推奨)。\n"
                               "free: pred_cam_t をそのまま使用 (カメラ傾き由来の浮き・沈みが残る)。\n"
                               "xz_only: Y 成分を無効化 (水平移動のみ、ジャンプも失われる)。",
                }),
                "blender_exe": ("STRING", {
                    "default": _DEFAULT_BLENDER,
                    "tooltip": "blender.exe のパス (subprocess 呼び出し)",
                }),
                "output_filename": ("STRING", {
                    "default": "sam3d_animated.fbx",
                    "tooltip": "出力 FBX のファイル名 (ComfyUI/output/ に保存)。"
                               "空にするとタイムスタンプ付きで自動命名。",
                }),
            },
            "optional": {
                "masks": ("MASK", {
                    "tooltip": "任意: フレームごとのセグメンテーションマスク。"
                               "フレーム数が一致する場合のみ使用する。",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("fbx_path",)
    FUNCTION = "export"
    CATEGORY = "SAM3DBody/export"

    def export(self, model, images, character_json, fps,
               bbox_threshold, inference_type,
               blender_exe, output_filename,
               root_motion_mode="auto_ground_lock",
               masks=None):
        import folder_paths
        from ..sam_3d_body import SAM3DBodyEstimator

        if root_motion_mode not in _ROOT_MOTION_MODES:
            print(f"[SAM3DBody] unknown root_motion_mode '{root_motion_mode}', "
                  f"falling back to 'auto_ground_lock'")
            root_motion_mode = "auto_ground_lock"

        try:
            preset = json.loads(character_json) if character_json.strip() else {}
        except Exception as exc:
            print(f"[SAM3DBody] character_json parse failed: {exc}; using empty preset")
            preset = {}

        num_frames = int(images.shape[0])
        if num_frames == 0:
            raise RuntimeError("images batch is empty")

        masks_np = None
        if masks is not None:
            masks_np = masks.detach().cpu().numpy()
            if masks_np.ndim == 2:
                masks_np = masks_np[None, ...]
            if masks_np.shape[0] != num_frames:
                print(f"[SAM3DBody] mask count ({masks_np.shape[0]}) != "
                      f"frame count ({num_frames}); ignoring masks")
                masks_np = None

        loaded = _load_sam3d_model(model)
        sam_3d_model = loaded["model"]
        device = torch.device(loaded["device"])
        mhr_head = sam_3d_model.head_pose

        # Prime caches needed for rigging / blendshape / bone-length math.
        _get_mhr_rest_verts(mhr_head, device)
        parents = _FACE_BS_CACHE["joint_parents"].astype(np.int32)
        lbs_weights = _FACE_BS_CACHE["lbs_weights"].astype(np.float32)
        num_joints = parents.shape[0]
        faces = mhr_head.faces.detach().cpu().numpy().astype(np.int32)

        # ============ Character rest pose (same path as export_rigged.py) ============
        bp = preset.get("body_params", {}) if isinstance(preset, dict) else {}
        bl = preset.get("bone_lengths", {}) if isinstance(preset, dict) else {}
        bs = preset.get("blendshapes",  {}) if isinstance(preset, dict) else {}

        body_shape_ui = [
            float(bp.get("fat", 0.0)),
            float(bp.get("muscle", 0.0)),
            float(bp.get("fat_muscle", 0.0)),
            float(bp.get("limb_girth", 0.0)),
            float(bp.get("limb_muscle", 0.0)),
            float(bp.get("limb_fat", 0.0)),
            float(bp.get("chest_shoulder", 0.0)),
            float(bp.get("waist_hip", 0.0)),
            float(bp.get("thigh_calf", 0.0)),
        ]
        shape_params = torch.zeros(
            (1, mhr_head.num_shape_comps), dtype=torch.float32, device=device,
        )
        for i in range(min(9, mhr_head.num_shape_comps)):
            shape_params[0, i] = (
                body_shape_ui[i] * _SHAPE_SLIDER_NORM[i] * _SHAPE_SLIDER_SIGN[i]
            )
        scale_params = torch.zeros(
            (1, mhr_head.num_scale_comps), dtype=torch.float32, device=device,
        )
        expr_params = torch.zeros(
            (1, mhr_head.num_face_comps), dtype=torch.float32, device=device,
        )

        zeros3 = torch.zeros((1, 3), dtype=torch.float32, device=device)
        body_zero = torch.zeros((1, 133), dtype=torch.float32, device=device)
        hand_zero = torch.zeros((1, 108), dtype=torch.float32, device=device)
        global_trans = torch.zeros((1, 3), dtype=torch.float32, device=device)

        with torch.no_grad():
            rest_out = mhr_head.mhr_forward(
                global_trans=global_trans,
                global_rot=zeros3,
                body_pose_params=body_zero,
                hand_pose_params=hand_zero,
                scale_params=scale_params,
                shape_params=shape_params,
                expr_params=expr_params,
                return_joint_rotations=True,
                return_joint_coords=True,
            )
        char_rest_verts = rest_out[0].detach().cpu().numpy().astype(np.float32)
        if char_rest_verts.ndim == 3:
            char_rest_verts = char_rest_verts[0]
        char_rest_rots, char_rest_coords = _unpack_batched(rest_out[1:])
        char_rest_rots = char_rest_rots.astype(np.float32)
        char_rest_coords = char_rest_coords.astype(np.float32)

        bs_sliders = {str(k): float(v) for k, v in bs.items()}
        if any(v != 0.0 for v in bs_sliders.values()):
            from ..preset_pack import active_pack_dir as _pack_dir
            presets_dir = str(_pack_dir())
            bs_npz = os.path.join(presets_dir, "face_blendshapes.npz")
            mhr_neutral_rest = _FACE_BS_CACHE["rest_verts"]
            char_rest_verts = _apply_face_blendshapes(
                char_rest_verts, mhr_neutral_rest, bs_sliders,
                char_rest_rots, presets_dir, bs_npz,
            )

        bone_scales = {
            "torso": float(bl.get("torso", 1.0)),
            "neck":  float(bl.get("neck",  1.0)),
            "arm":   float(bl.get("arm",   1.0)),
            "leg":   float(bl.get("leg",   1.0)),
        }
        any_bone_scaled = any(v != 1.0 for v in bone_scales.values())
        if any_bone_scaled:
            char_rest_verts = _apply_bone_length_scales(
                char_rest_verts,
                arm_scale=bone_scales["arm"],
                leg_scale=bone_scales["leg"],
                torso_scale=bone_scales["torso"],
                neck_scale=bone_scales["neck"],
                joint_rots_posed=char_rest_rots,
            )
            char_rest_coords = _scale_skeleton_rest(
                char_rest_coords, parents,
                _FACE_BS_CACHE["joint_chain_cats"],
                bone_scales,
            )

        # ============ Per-frame pose estimation ============
        estimator = SAM3DBodyEstimator(
            sam_3d_body_model=sam_3d_model,
            model_cfg=loaded["model_cfg"],
            human_detector=None,
            human_segmentor=None,
            fov_estimator=None,
        )

        frames_posed_rots = []  # [N, J, 3, 3]
        raw_trans = []           # list of 3-vec (MHR native) or None
        frames_feet_pos = []     # [N, 2, 3] — (foot_l, foot_r) MHR native, trans=0
        last_good_pose = None
        last_good_feet_pos = np.stack([
            np.asarray(char_rest_coords[_FOOT_JOINT_L], dtype=np.float32),
            np.asarray(char_rest_coords[_FOOT_JOINT_R], dtype=np.float32),
        ], axis=0)
        skipped = 0
        for f_i in range(num_frames):
            img_bgr = _comfy_frame_to_bgr(images, f_i)
            mask_np = None
            bboxes = None
            if masks_np is not None:
                mask_np = masks_np[f_i]
                bboxes = _mask_frame_bbox(mask_np)

            with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
                cv2.imwrite(tmp.name, img_bgr)
                tmp_path = tmp.name
            try:
                outputs = estimator.process_one_image(
                    tmp_path,
                    bboxes=bboxes,
                    masks=mask_np,
                    bbox_thr=bbox_threshold,
                    use_mask=(mask_np is not None),
                    inference_type=inference_type,
                )
            finally:
                if os.path.exists(tmp_path):
                    try:
                        os.unlink(tmp_path)
                    except Exception:
                        pass

            if not outputs:
                # No person detected this frame — reuse the previous frame's
                # pose + feet so the clip stays contiguous. If the very
                # first frame has no detection we bake an identity (rest)
                # pose for it. Root translation gets the same treatment
                # inside _normalise_translations() after the loop.
                skipped += 1
                if last_good_pose is None:
                    print(f"[SAM3DBody] frame {f_i+1}: no detection, using rest pose")
                    posed_rots = char_rest_rots.copy()
                else:
                    print(f"[SAM3DBody] frame {f_i+1}: no detection, reusing prev pose")
                    posed_rots = last_good_pose
                frames_posed_rots.append(posed_rots)
                frames_feet_pos.append(last_good_feet_pos.copy())
                raw_trans.append(None)
                continue

            raw = outputs[0]
            body_pose_t  = _to_batched_tensor(raw.get("body_pose_params"), device, width=133)
            hand_pose_t  = _to_batched_tensor(raw.get("hand_pose_params"), device, width=108)
            global_rot_t = _to_batched_tensor(raw.get("global_rot"),       device, width=3)

            with torch.no_grad():
                posed_out = mhr_head.mhr_forward(
                    global_trans=global_trans,
                    global_rot=global_rot_t,
                    body_pose_params=body_pose_t,
                    hand_pose_params=hand_pose_t,
                    scale_params=scale_params,
                    shape_params=shape_params,
                    expr_params=expr_params,
                    return_joint_rotations=True,
                    return_joint_coords=True,
                )
            posed_rots, posed_coords = _unpack_batched(posed_out[1:])
            posed_rots = posed_rots.astype(np.float32)
            last_good_pose = posed_rots
            frames_posed_rots.append(posed_rots)

            # Per-frame feet 3D position (MHR native, with global_trans=0)
            # for the contact-based ground-lock correction. Full 3D is
            # needed so the solver can reason about foot motion in both
            # pose space (for Y threshold) and world space (for stillness
            # detection, once trans is layered on).
            if posed_coords is not None:
                pc = np.asarray(posed_coords, dtype=np.float32)
                feet_pos = np.stack([
                    pc[_FOOT_JOINT_L],
                    pc[_FOOT_JOINT_R],
                ], axis=0)  # [2, 3]
                last_good_feet_pos = feet_pos
            else:
                feet_pos = last_good_feet_pos.copy()
            frames_feet_pos.append(feet_pos)

            # Root translation — capture pred_cam_t (MHR-native world
            # position of the subject relative to the fixed camera). Any
            # of pred_cam_t / camera / global_trans may be the populated
            # key depending on the SAM3D model variant, so check them in
            # priority order. Note: can't use `a or b or c` here because
            # _as_vec3 returns numpy arrays, which raise on `bool(arr)`.
            cam_vec = None
            for key in ("pred_cam_t", "camera", "global_trans"):
                cam_vec = _as_vec3(raw.get(key))
                if cam_vec is not None:
                    break
            raw_trans.append(cam_vec)

            if (f_i + 1) % 10 == 0 or f_i == num_frames - 1:
                print(f"[SAM3DBody] pose estimation {f_i+1}/{num_frames}")

        if skipped:
            print(f"[SAM3DBody] {skipped}/{num_frames} frames fell back to a reused pose")

        # ============ Prune weightless leaf joints (same policy as export_rigged.py) ============
        names_full = [_KNOWN_JOINT_NAMES.get(i, f"joint_{i:03d}") for i in range(num_joints)]
        nonzero = lbs_weights > 1e-5
        v_idx, j_idx = np.where(nonzero)
        w_val = lbs_weights[nonzero].astype(np.float32)

        keep = lbs_weights.sum(axis=0) > 1e-6
        for j in range(num_joints - 1, -1, -1):
            if keep[j]:
                p = int(parents[j])
                if p >= 0:
                    keep[p] = True
        kept_idx = np.where(keep)[0]
        old_to_new = {int(o): n for n, o in enumerate(kept_idx)}
        j_remap = np.full(num_joints, -1, dtype=np.int32)
        for old, new in old_to_new.items():
            j_remap[old] = new

        new_parents = [
            int(j_remap[int(parents[o])]) if int(parents[o]) >= 0 else -1
            for o in kept_idx
        ]
        names = [names_full[o] for o in kept_idx]
        rest_coords_out = char_rest_coords[kept_idx]
        rest_rots_out   = char_rest_rots[kept_idx]
        frames_posed_rots_out = [pr[kept_idx].tolist() for pr in frames_posed_rots]

        j_idx_new = j_remap[j_idx]
        valid = j_idx_new >= 0
        v_idx = v_idx[valid]
        j_idx_new = j_idx_new[valid]
        w_val = w_val[valid]

        # Per-frame root translation (MHR native, anchored to first
        # detected frame so the clip starts at the origin). Rotation
        # around the vertical axis is already baked into
        # frames_posed_joint_rots[root] via the global_rot the estimator
        # feeds into mhr_forward; this `frames_root_trans` carries the
        # remaining position delta so Blender can keyframe location on
        # the root bone.
        frames_root_trans = _normalise_translations(raw_trans)
        detected_trans = sum(1 for t in raw_trans if t is not None)

        # Apply the user-selected vertical correction. `auto_ground_lock`
        # solves the most common "character floats above the ground" bug
        # that comes from pred_cam_t depth jitter; `xz_only` kills
        # vertical motion entirely (in-place walking); `free` preserves
        # the raw pred_cam_t for callers that want to post-process
        # themselves.
        if frames_root_trans:
            trans_arr = np.asarray(frames_root_trans, dtype=np.float32)
            if root_motion_mode == "xz_only":
                trans_arr[:, 1] = 0.0
                print("[SAM3DBody] root_motion_mode=xz_only: zeroed Y component")
            elif root_motion_mode == "auto_ground_lock" and frames_feet_pos:
                feet_pos_arr = np.stack(frames_feet_pos, axis=0)  # [N, 2, 3]
                rest_feet_y = float(min(
                    char_rest_coords[_FOOT_JOINT_L][1],
                    char_rest_coords[_FOOT_JOINT_R][1],
                ))
                offset = _compute_ground_lock_offset(
                    feet_pos_arr, trans_arr, rest_feet_y
                )
                trans_arr[:, 1] += offset
            else:
                print(f"[SAM3DBody] root_motion_mode={root_motion_mode}: no Y correction")
            frames_root_trans = trans_arr.tolist()

        print(
            f"[SAM3DBody] animated FBX: kept {len(kept_idx)} / {num_joints} joints, "
            f"{len(frames_posed_rots_out)} frames "
            f"(pred_cam_t captured on {detected_trans}/{num_frames} frames)"
        )

        # ============ Output path ============
        output_dir = folder_paths.get_output_directory()
        if not output_filename or not output_filename.strip():
            output_filename = f"sam3d_animated_{int(time.time())}.fbx"
        if not output_filename.lower().endswith(".fbx"):
            output_filename = output_filename + ".fbx"
        output_path = os.path.abspath(os.path.join(output_dir, output_filename))

        package = {
            "output_path": output_path,
            "fps": float(fps),
            "rest_verts":        char_rest_verts.tolist(),
            "faces":             faces.tolist(),
            "joint_parents":     new_parents,
            "joint_names":       names,
            "rest_joint_coords": rest_coords_out.tolist(),
            "rest_joint_rots":   rest_rots_out.tolist(),
            "frames_posed_joint_rots": frames_posed_rots_out,
            "frames_root_trans":       frames_root_trans,
            "lbs_v_idx":  v_idx.astype(np.int32).tolist(),
            "lbs_j_idx":  j_idx_new.astype(np.int32).tolist(),
            "lbs_weight": w_val.tolist(),
        }

        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8",
        ) as tmp:
            json.dump(package, tmp)
            tmp_json = tmp.name

        cmd = [
            blender_exe, "--background", "--python", _BUILD_SCRIPT,
            "--", "--input", tmp_json,
        ]
        print(f"[SAM3DBody] Spawning Blender for animated FBX export "
              f"({len(frames_posed_rots_out)} frames)...")
        try:
            # Timeout scales with frame count — long clips legitimately
            # take longer to bake.
            timeout_s = max(600, 30 + 2 * len(frames_posed_rots_out))
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout_s,
            )
            if result.returncode != 0:
                print("[SAM3DBody] Blender stdout:\n" + (result.stdout or ""))
                print("[SAM3DBody] Blender stderr:\n" + (result.stderr or ""))
                raise RuntimeError(
                    f"Blender animated FBX export failed "
                    f"(exit code {result.returncode})."
                )
            if result.stdout:
                print(result.stdout[-1200:])
        finally:
            if os.path.exists(tmp_json):
                try:
                    os.unlink(tmp_json)
                except Exception:
                    pass

        if not os.path.exists(output_path):
            raise RuntimeError(
                f"Blender reported success but {output_path} was not created."
            )
        print(f"[SAM3DBody] Animated FBX: {output_path}")
        return (output_path,)


NODE_CLASS_MAPPINGS = {
    "SAM3DBodyExportAnimatedFBX": SAM3DBodyExportAnimatedFBX,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAM3DBodyExportAnimatedFBX": "SAM 3D Body: Export Animated FBX",
}
