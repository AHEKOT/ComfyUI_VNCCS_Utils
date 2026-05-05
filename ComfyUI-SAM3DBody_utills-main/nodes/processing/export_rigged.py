"""SAM 3D Body: export a posed character as a rigged FBX (armature + mesh
+ LBS vertex groups + single-frame animation).

The heavy lifting — armature creation, vertex group binding, and FBX
export — happens in a spawned Blender subprocess because ComfyUI's main
venv has no `bpy`. Python builds the geometry/skeleton data here, dumps
it to a temp JSON, invokes `blender.exe --background --python
tools/build_rigged_fbx.py`, then returns the output path.
"""

import os
import json
import tempfile
import subprocess
import time

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


_DEFAULT_BLENDER = "C:/Program Files/Blender Foundation/Blender 4.1/blender.exe"
_UTILS_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_BUILD_SCRIPT = os.path.join(_UTILS_ROOT, "tools", "build_rigged_fbx.py")

# MHR joint index -> human-readable bone name.
_KNOWN_JOINT_NAMES = {
    1:   "pelvis",
    2:   "thigh_l",   3:  "calf_l",   4:  "foot_l",
    18:  "thigh_r",  19:  "calf_r",  20:  "foot_r",
    35:  "spine_01", 36:  "spine_02", 37: "spine_03",
    38:  "clavicle_r", 39: "upperarm_r", 40: "lowerarm_r", 42: "hand_r",
    74:  "clavicle_l", 75: "upperarm_l", 76: "lowerarm_l", 78: "hand_l",
    110: "neck_01",  113: "head",
}


# Slider -> PCA axis normalization / sign, copied from
# SAM3DBodyRenderFromJson so the rigged character's body_params
# produce the exact same shape that the render preview shows.
_SHAPE_SLIDER_NORM = (1.00, 2.78, 4.42, 8.74, 10.82, 11.70, 13.39, 13.83, 16.62)
_SHAPE_SLIDER_SIGN = (+1, -1, +1, +1, -1, +1, -1, +1, +1)


def _unpack_batched(tensor_tuple):
    """Pick (joint_rots [J,3,3], joint_coords [J,3]) from mhr_forward's
    tuple by tensor shape — same pattern used in render."""
    rots = coords = None
    for t in tensor_tuple:
        if t.ndim == 4 and t.shape[-1] == 3 and t.shape[-2] == 3:
            rots = t
        elif t.ndim == 3 and t.shape[-1] == 3 and t.shape[-2] != 3:
            coords = t
    r = rots.detach().cpu().numpy() if rots is not None else None
    c = coords.detach().cpu().numpy() if coords is not None else None
    if r is not None and r.ndim == 4:
        r = r[0]
    if c is not None and c.ndim == 3:
        c = c[0]
    return r, c


class SAM3DBodyExportRiggedFBX:
    """Write a rigged FBX for the character described by
    `preset_json` in the pose described by `pose_json`.

    Typical wiring:
        LoadSAM3DBodyModel  ──► model
        RenderFromJson ──► preset_json   (settings_json output)
        ProcessImageToJson  ──► pose_json     (pose_json output)
    """

    @classmethod
    def INPUT_TYPES(cls):
        # Self-describing placeholder JSON is parked in each multiline
        # widget's `default` so the textarea contents announce which
        # input is which at a glance (ComfyUI's multiline widget hides
        # its name label at small node sizes). Both placeholders parse
        # as empty-but-valid inputs so running the node with defaults
        # untouched still works — it just produces a neutral rest pose.
        character_placeholder = (
            "{\n"
            '  "_slot": "=== CHARACTER JSON ===",\n'
            '  "_hint": "Paste Render node\'s settings_json output here.",\n'
            '  "body_params":   {},\n'
            '  "bone_lengths":  {},\n'
            '  "blendshapes":   {}\n'
            "}"
        )
        pose_placeholder = (
            "{\n"
            '  "_slot": "=== POSE JSON ===",\n'
            '  "_hint": "Paste Process Image to Pose JSON output here.",\n'
            '  "body_pose_params": null,\n'
            '  "hand_pose_params": null,\n'
            '  "global_rot":       null\n'
            "}"
        )
        return {
            "required": {
                "model": ("SAM3D_MODEL", {
                    "tooltip": "Load SAM 3D Body Model ノードの出力",
                }),
                "character_json": ("STRING", {
                    "multiline": True, "default": character_placeholder,
                    "tooltip": "【キャラクター設定 JSON】\n"
                               "Render ノードの settings_json 出力を接続する、"
                               "または chara_settings_presets/*.json の内容を貼り付け。\n"
                               "body_params / bone_lengths / blendshapes を含む JSON。",
                }),
                "pose_json": ("STRING", {
                    "multiline": True, "default": pose_placeholder,
                    "tooltip": "【ポーズ JSON】\n"
                               "Process Image to Pose JSON ノードの pose_json 出力を接続。\n"
                               "body_pose_params / hand_pose_params / global_rot を含む JSON。",
                }),
                "blender_exe": ("STRING", {
                    "default": _DEFAULT_BLENDER,
                    "tooltip": "blender.exe のパス (subprocess 呼び出し)",
                }),
                "output_filename": ("STRING", {
                    "default": "sam3d_rigged.fbx",
                    "tooltip": "出力 FBX のファイル名 (ComfyUI/output/ に保存)。"
                               "空にするとタイムスタンプ付きで自動命名。",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("fbx_path",)
    FUNCTION = "export"
    CATEGORY = "SAM3DBody/export"

    def export(self, model, character_json, pose_json, blender_exe, output_filename):
        import folder_paths

        try:
            preset = json.loads(character_json) if character_json.strip() else {}
        except Exception as exc:
            print(f"[SAM3DBody] character_json parse failed: {exc}; using empty preset")
            preset = {}
        try:
            payload = json.loads(pose_json) if pose_json.strip() else {}
        except Exception as exc:
            print(f"[SAM3DBody] pose_json parse failed: {exc}; using empty pose")
            payload = {}

        loaded = _load_sam3d_model(model)
        sam_3d_model = loaded["model"]
        device = torch.device(loaded["device"])
        mhr_head = sam_3d_model.head_pose

        # Prime caches (rest_verts, rest_joint_rots, rest_joint_coords,
        # lbs_weights, joint_parents, joint_chain_cats).
        _get_mhr_rest_verts(mhr_head, device)
        parents = _FACE_BS_CACHE["joint_parents"].astype(np.int32)
        lbs_weights = _FACE_BS_CACHE["lbs_weights"].astype(np.float32)
        num_joints = parents.shape[0]
        faces = mhr_head.faces.detach().cpu().numpy().astype(np.int32)

        # ============ preset -> MHR forward params ============
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

        # ============ Character REST pose (body_pose = 0) ============
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

        # Apply blend shapes on top of the rest-pose char mesh. _apply_face_blendshapes
        # uses `R_rel = R_posed @ inv(R_rest)` which collapses to identity when we
        # pass rest rotations as "posed" — which is exactly what we want here
        # (add deltas in rest frame).
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
            # Bake the bone-length change into the rest joint positions too —
            # otherwise the armature's rest skeleton won't match the mesh
            # we just warped.
            char_rest_coords = _scale_skeleton_rest(
                char_rest_coords, parents,
                _FACE_BS_CACHE["joint_chain_cats"],
                bone_scales,
            )

        # ============ POSED skeleton (body_pose from pose_json) ============
        global_rot_t = _to_batched_tensor(payload.get("global_rot"), device, width=3)
        body_pose_t  = _to_batched_tensor(payload.get("body_pose_params"), device, width=133)
        hand_pose_t  = _to_batched_tensor(payload.get("hand_pose_params"), device, width=108)
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
        posed_coords = posed_coords.astype(np.float32)

        # Apply the same per-chain bone-length scale to the posed joint
        # positions so the rigged rest <-> pose transform stays
        # consistent with the mesh.
        if any_bone_scaled:
            posed_coords = _scale_skeleton_rest(
                posed_coords, parents,
                _FACE_BS_CACHE["joint_chain_cats"],
                bone_scales,
            )

        # ============ Package for Blender ============
        output_dir = folder_paths.get_output_directory()
        if not output_filename or not output_filename.strip():
            output_filename = f"sam3d_rigged_{int(time.time())}.fbx"
        if not output_filename.lower().endswith(".fbx"):
            output_filename = output_filename + ".fbx"
        output_path = os.path.abspath(os.path.join(output_dir, output_filename))

        names_full = [_KNOWN_JOINT_NAMES.get(i, f"joint_{i:03d}") for i in range(num_joints)]

        # Store LBS as sparse lists so the JSON doesn't blow up to V*J entries.
        nonzero = lbs_weights > 1e-5
        v_idx, j_idx = np.where(nonzero)
        w_val = lbs_weights[nonzero].astype(np.float32)

        # ----- Prune weightless leaf joints -----
        # The raw MHR skeleton has 127 joints but ~27 of them carry zero
        # LBS weight (finger/toe tips, face helpers). Of those, the ones
        # that are NOT ancestors of any skinned joint can be safely
        # dropped — leaving them in produces a cloud of ~1 cm "end bone"
        # stubs in Blender. We keep every joint that either has weight or
        # sits on the hierarchy path to a weighted joint.
        keep = lbs_weights.sum(axis=0) > 1e-6  # starts True for weighted joints
        # Backward sweep (child > parent in MHR ordering) pulls required
        # ancestors into `keep` with a single pass.
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
        rest_coords_out  = char_rest_coords[kept_idx]
        rest_rots_out    = char_rest_rots[kept_idx]
        posed_coords_out = posed_coords[kept_idx]
        posed_rots_out   = posed_rots[kept_idx]

        # Remap sparse LBS joint indices. Weightless joints have no
        # entries in this sparse list so everything should stay valid.
        j_idx_new = j_remap[j_idx]
        valid = j_idx_new >= 0
        v_idx = v_idx[valid]
        j_idx_new = j_idx_new[valid]
        w_val = w_val[valid]

        print(
            f"[SAM3DBody] rigged FBX: kept {len(kept_idx)} / {num_joints} joints "
            f"(dropped {num_joints - len(kept_idx)} weightless leaves)"
        )

        package = {
            "output_path": output_path,
            "rest_verts":         char_rest_verts.tolist(),
            "faces":              faces.tolist(),
            "joint_parents":      new_parents,
            "joint_names":        names,
            "rest_joint_coords":  rest_coords_out.tolist(),
            "rest_joint_rots":    rest_rots_out.tolist(),
            "posed_joint_coords": posed_coords_out.tolist(),
            "posed_joint_rots":   posed_rots_out.tolist(),
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
        print(f"[SAM3DBody] Spawning Blender for rigged FBX export...")
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=600,
            )
            if result.returncode != 0:
                print("[SAM3DBody] Blender stdout:\n" + (result.stdout or ""))
                print("[SAM3DBody] Blender stderr:\n" + (result.stderr or ""))
                raise RuntimeError(
                    f"Blender FBX export failed (exit code {result.returncode}). "
                    "Check the console for details."
                )
            if result.stdout:
                # Print only the last chunk so we don't flood the log.
                print(result.stdout[-800:])
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
        print(f"[SAM3DBody] Rigged FBX: {output_path}")
        return (output_path,)


def _scale_skeleton_rest(joint_coords: np.ndarray,
                         parents: np.ndarray,
                         cats: np.ndarray,
                         bone_scales: dict) -> np.ndarray:
    """Rebuild joint positions after applying per-chain bone-length
    scales. Mirrors the forward sweep inside _apply_bone_length_scales
    but operates on joint positions directly (no LBS, no rotation).
    Needed so the rigged skeleton's rest positions match the mesh that
    was warped by _apply_bone_length_scales above."""
    scale_by_cat = np.array(
        [1.0, bone_scales["torso"], bone_scales["neck"],
         bone_scales["arm"], bone_scales["leg"]],
        dtype=np.float32,
    )
    new_pos = np.zeros_like(joint_coords)
    num_joints = joint_coords.shape[0]
    for j in range(num_joints):
        p = int(parents[j])
        if p < 0:
            new_pos[j] = joint_coords[j]
            continue
        off = joint_coords[j] - joint_coords[p]
        s = float(scale_by_cat[int(cats[j])])
        new_pos[j] = new_pos[p] + s * off
    return new_pos


NODE_CLASS_MAPPINGS = {
    "SAM3DBodyExportRiggedFBX": SAM3DBodyExportRiggedFBX,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAM3DBodyExportRiggedFBX": "SAM 3D Body: Export Rigged FBX",
}
