import os
import json
import tempfile
import torch
import numpy as np
import cv2

# =============================================================================
# Helper functions (inlined to avoid relative import issues in worker)
# =============================================================================

def comfy_image_to_numpy(image):
    """Convert ComfyUI image tensor [B,H,W,C] to numpy BGR [H,W,C] for OpenCV."""
    img_np = image[0].cpu().numpy()
    img_np = (img_np * 255).astype(np.uint8)
    return img_np[..., ::-1].copy()  # RGB -> BGR


def comfy_mask_to_numpy(mask):
    """Convert ComfyUI mask tensor [N,H,W] to numpy [N,H,W]."""
    return mask.cpu().numpy()


def numpy_to_comfy_image(np_image):
    """Convert numpy BGR [H,W,C] to ComfyUI image tensor [1,H,W,C]."""
    img_rgb = np_image[..., ::-1].copy()  # BGR -> RGB
    img_rgb = img_rgb.astype(np.float32) / 255.0
    return torch.from_numpy(img_rgb).unsqueeze(0)

# Module-level cache for loaded model (persists across calls in worker)
_MODEL_CACHE = {}

# NOTE: older versions of this module selected a per-shape "anchor joint"
# from the shape name prefix (face_* -> head, neck_* -> neck_01, ...) and
# rotated the whole delta by that single joint's rest->posed rotation.
# That broke for shapes spanning multiple independently-rotating bones
# (limb_*, chibi, hand_*, foot_* ...).
#
# The current implementation rotates each vertex's delta by its OWN
# dominant MHR joint (derived from LBS skinning weights). Every shape —
# face, neck, limbs, whole body — is handled the same way.


def _character_presets_dir():
    """Resolves to `presets/<active pack>/chara_settings_presets/` —
    controlled by active_preset.ini at the repo root."""
    from ..preset_pack import chara_settings_dir
    return str(chara_settings_dir())


def _discover_character_presets():
    """Return the preset dropdown options. One entry per JSON file in
    chara_settings_presets/. `autosave` (written at the end of every
    render) is included as a first-class preset and pinned to the top
    so it acts as the default selection. Picking a preset triggers the
    frontend extension to copy its body/bone/blendshape values into the
    slider widgets; the user can then tweak them further. The Python
    side does NOT re-apply the preset at render time, so manual
    adjustments made after selection are respected."""
    options = []
    d = _character_presets_dir()
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if fn.endswith(".json"):
                options.append(fn[:-5])
    if not options:
        # Fallback so the combo widget always has at least one value.
        options = ["default"]
    # Pin autosave to the front so it becomes the default.
    if "autosave" in options:
        options.remove("autosave")
        options.insert(0, "autosave")
    return options


def _autosave_path():
    return os.path.join(_character_presets_dir(), "autosave.json")


def _load_autosave() -> dict:
    """Read chara_settings_presets/autosave.json, which holds the last
    render's body/bone/blendshape values. Used as UI slider defaults
    on ComfyUI start / refresh so the last settings persist across
    sessions. Returns {} if the file is missing or unreadable."""
    path = _autosave_path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        print(f"[SAM3DBody] failed to read autosave.json: {exc}")
        return {}


def _save_autosave(settings: dict) -> None:
    """Write the current render's settings to autosave.json. Silently
    skips on write failure (autosave is best-effort)."""
    path = _autosave_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        print(f"[SAM3DBody] autosave write failed: {exc}")


def _load_character_preset(name: str) -> dict:
    """Load a character preset JSON. Returns an empty dict if the preset
    is 'none' / missing / malformed so the caller can skip the override."""
    if not name or name == "none":
        return {}
    path = os.path.join(_character_presets_dir(), f"{name}.json")
    if not os.path.exists(path):
        print(f"[SAM3DBody] character preset not found: {path}")
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        print(f"[SAM3DBody] failed to read preset '{name}': {exc}")
        return {}


# Canonical UI order for blend-shape sliders. Goes head → neck → chest →
# shoulder → waist → limbs, same top-to-bottom reading order as a body
# layout. Names in this list match the FBX shape-key names (no `bs_`
# prefix); the prefix is added at the INPUT_TYPES layer.
_UI_BLENDSHAPE_ORDER = (
    # face
    "face_big", "face_small", "face_mangabig", "face_manga", "chin_sharp", "face_wide",
    # neck
    "neck_thick", "neck_thin",
    # chest
    "breast_full", "breast_flat", "chest_slim",
    # shoulder
    "shoulder_wide", "shoulder_narrow", "shoulder_slope",
    # waist
    "waist_slim",
    # limbs
    "limb_thick", "limb_thin", "hand_big", "foot_big",
    # other
    "MuscleScale",
)


def _discover_blendshape_names():
    """Read blend-shape names present in the shipped npz. Shapes listed
    in `_UI_BLENDSHAPE_ORDER` come first in that order; any extra shapes
    found in the npz are appended alphabetically so new shape keys
    surface in the UI without code changes.
    """
    from ..preset_pack import npz_path as _pack_npz_path
    npz_path = str(_pack_npz_path())
    shapes = ()
    if not os.path.exists(npz_path):
        return _UI_BLENDSHAPE_ORDER
    try:
        with np.load(npz_path) as npz:
            if "meta_shapes" in npz.files:
                shapes = tuple(str(s) for s in np.asarray(npz["meta_shapes"]))
    except Exception:
        pass
    if not shapes:
        return ()
    shapes_set = set(shapes)
    head = [s for s in _UI_BLENDSHAPE_ORDER if s in shapes_set]
    tail = sorted(s for s in shapes if s not in _UI_BLENDSHAPE_ORDER)
    return tuple(head + tail)

# Axis alignment from FBX world-frame (after Blender's matrix_world has been
# applied in the extraction script) to MHR world frame. Verified against
# MHR head rest-position bounds (Y up):
#   MHR_x =  FBX_world_x
#   MHR_y =  FBX_world_z      (head at world z ~ 1.6 -> MHR y ~ 1.6)
#   MHR_z = -FBX_world_y
# Applied to both `base` positions and blend-shape `delta` vectors.
_FBX_TO_MHR_ROT = np.array(
    [[1.0,  0.0,  0.0],
     [0.0,  0.0,  1.0],
     [0.0, -1.0,  0.0]],
    dtype=np.float32,
)

# Loaded once: blend-shape deltas in MHR index space + precomputed
# head vertex-id array. Keyed by rest-pose vertex count so a model swap
# refreshes the cache.
_FACE_BS_CACHE = {
    "v_count": None,                 # len of MHR rest verts, cache key
    "rest_key": None,                # id(mhr_head), cache key
    "rest_verts": None,              # np.float32 [V, 3]
    "rest_joint_rots": None,         # np.float32 [127, 3, 3]
    "rest_joint_coords": None,       # np.float32 [127, 3]
    "dominant_joint": None,          # np.int32  [V]  per-vertex dominant MHR joint idx
    "lbs_weights": None,             # np.float32 [V, J]  full MHR LBS weight matrix
    "rest_weighted_joint_pos": None, # np.float32 [V, 3]  per-vertex LBS-weighted
                                     #   joint-anchor position at rest
    "rest_offset_len": None,         # np.float32 [V]  |rest_verts - rest_weighted_joint|
    "normalize_mask": None,          # np.bool_ [V]  True for single-joint-dominated
                                     #   verts (max LBS weight > threshold). Only
                                     #   those are bone-length-normalized so joint
                                     #   boundary verts (knee, elbow) stay pure LBS.
    "region_ids": {},                # obj_name -> np.int64 MHR vertex indices
    "region_deltas": {},             # obj_name -> {shape_name: np.float32 [N_region, 3]}
    "joint_parents": None,           # np.int32 [J]  parent index per joint (-1 root)
    "joint_chain_cats": None,        # np.int8 [J]  0=none, 1=torso, 2=neck, 3=arm, 4=leg
}


def _build_lbs_weights(mhr_head, num_verts: int, num_joints: int) -> np.ndarray:
    """Reconstruct the full [V, J] LBS weight matrix from MHR's sparse
    buffers. Returns None-equivalent zero matrix if not available."""
    bufs = dict(mhr_head.mhr.named_buffers())
    key_v = key_j = key_w = None
    for k in bufs:
        lk = k.lower()
        if "vert_indices_flattened" in lk:
            key_v = k
        elif "skin_indices_flattened" in lk:
            key_j = k
        elif "skin_weights_flattened" in lk:
            key_w = k
    W = np.zeros((num_verts, num_joints), dtype=np.float32)
    if not (key_v and key_j and key_w):
        return W
    v_idx = bufs[key_v].detach().cpu().numpy().astype(np.int64)
    j_idx = bufs[key_j].detach().cpu().numpy().astype(np.int64)
    w_val = bufs[key_w].detach().cpu().numpy().astype(np.float32)
    valid = ((v_idx >= 0) & (j_idx >= 0)
             & (v_idx < num_verts) & (j_idx < num_joints))
    np.add.at(W, (v_idx[valid], j_idx[valid]), w_val[valid])
    return W


def _compute_rest_lbs_anchors(
    rest_verts: np.ndarray,
    rest_joint_coords: np.ndarray,
    W: np.ndarray,
) -> tuple:
    """Compute the LBS-weighted rest anchor (weighted joint position at
    rest) and the rest-frame vertex offset length from that anchor, per
    vertex. These are the targets the renderer normalizes toward — one
    smooth scalar per vertex so joint boundaries stay continuous."""
    Wsum = W.sum(axis=1)                                    # [V]
    Wsum_safe = np.where(Wsum > 1e-6, Wsum, 1.0).astype(np.float32)
    rest_anchor = (W @ rest_joint_coords) / Wsum_safe[:, None]  # [V, 3]
    rest_offset = rest_verts - rest_anchor                  # [V, 3]
    rest_len = np.linalg.norm(rest_offset, axis=1).astype(np.float32)
    return rest_anchor.astype(np.float32), rest_len, Wsum_safe


def _compute_dominant_joints(mhr_head, num_verts: int, num_joints: int = 127):
    """Reconstruct per-vertex dominant joint index from MHR's sparse LBS
    buffers. MHR stores skinning as three flattened arrays:
      linear_blend_skinning.vert_indices_flattened
      linear_blend_skinning.skin_indices_flattened  (joint idx per entry)
      linear_blend_skinning.skin_weights_flattened
    We accumulate a dense [V, J] weight matrix and take argmax per vertex.
    """
    bufs = dict(mhr_head.mhr.named_buffers())
    key_v = key_j = key_w = None
    for k in bufs:
        lk = k.lower()
        if "vert_indices_flattened" in lk:
            key_v = k
        elif "skin_indices_flattened" in lk:
            key_j = k
        elif "skin_weights_flattened" in lk:
            key_w = k
    if not (key_v and key_j and key_w):
        return np.zeros(num_verts, dtype=np.int32)  # all to root as fallback
    v_idx = bufs[key_v].detach().cpu().numpy().astype(np.int64)
    j_idx = bufs[key_j].detach().cpu().numpy().astype(np.int64)
    w_val = bufs[key_w].detach().cpu().numpy().astype(np.float32)
    W = np.zeros((num_verts, num_joints), dtype=np.float32)
    valid = ((v_idx >= 0) & (j_idx >= 0)
             & (v_idx < num_verts) & (j_idx < num_joints))
    np.add.at(W, (v_idx[valid], j_idx[valid]), w_val[valid])
    return np.argmax(W, axis=1).astype(np.int32)


def _get_mhr_rest_verts(mhr_head, device):
    """Cache MHR rest-pose vertices, all 127 joint rotations at rest, and
    the per-vertex dominant joint index (from MHR LBS skinning weights).
    Called once per model instance."""
    key = id(mhr_head)
    if _FACE_BS_CACHE["rest_key"] == key and _FACE_BS_CACHE["rest_verts"] is not None:
        return _FACE_BS_CACHE["rest_verts"]
    zeros3 = torch.zeros((1, 3), dtype=torch.float32, device=device)
    body_p = torch.zeros((1, 133), dtype=torch.float32, device=device)
    hand_p = torch.zeros((1, 108), dtype=torch.float32, device=device)
    scale  = torch.zeros((1, mhr_head.num_scale_comps), dtype=torch.float32, device=device)
    shape  = torch.zeros((1, mhr_head.num_shape_comps), dtype=torch.float32, device=device)
    expr   = torch.zeros((1, mhr_head.num_face_comps), dtype=torch.float32, device=device)
    with torch.no_grad():
        out = mhr_head.mhr_forward(
            zeros3, zeros3, body_p, hand_p, scale, shape, expr,
            return_joint_rotations=True,
            return_joint_coords=True,
        )
    # Return order: verts, joint_rots, joint_coords (per mhr_head.py)
    verts_t = out[0]
    rots_t = None
    coords_t = None
    for t in out[1:]:
        if t.ndim in (3, 4) and t.shape[-1] == 3 and t.shape[-2] == 3:
            rots_t = t
        elif t.ndim in (2, 3) and t.shape[-1] == 3:
            coords_t = t
    v = verts_t.detach().cpu().numpy()
    if v.ndim == 3:
        v = v[0]
    r = rots_t.detach().cpu().numpy() if rots_t is not None else None
    if r is not None and r.ndim == 4:
        r = r[0]
    c = coords_t.detach().cpu().numpy() if coords_t is not None else None
    if c is not None and c.ndim == 3:
        c = c[0]
    v = v.astype(np.float32)
    _FACE_BS_CACHE["rest_key"] = key
    _FACE_BS_CACHE["rest_verts"] = v
    _FACE_BS_CACHE["rest_joint_rots"] = r.astype(np.float32) if r is not None else None
    _FACE_BS_CACHE["rest_joint_coords"] = c.astype(np.float32) if c is not None else None
    dom = _compute_dominant_joints(
        mhr_head, num_verts=v.shape[0],
        num_joints=r.shape[0] if r is not None else 127,
    )
    _FACE_BS_CACHE["dominant_joint"] = dom

    # LBS-weighted rest anchors for the per-vertex bone-length
    # normalization. Only vertices that are overwhelmingly dominated by a
    # single joint (max LBS weight > DOMINANT_THRESHOLD) are eligible for
    # normalization. At joint boundaries (knee, elbow) the LBS-blended
    # output is NOT a rigid motion of the rest vertex, so applying a
    # length-preserving scale there distorts the mesh. Leaving boundary
    # verts as pure LBS output keeps the mesh continuous.
    if c is not None:
        num_joints = r.shape[0] if r is not None else 127
        W = _build_lbs_weights(mhr_head, num_verts=v.shape[0], num_joints=num_joints)
        _FACE_BS_CACHE["lbs_weights"] = W
        anchor, rest_len, _ = _compute_rest_lbs_anchors(v, c, W)
        _FACE_BS_CACHE["rest_weighted_joint_pos"] = anchor
        _FACE_BS_CACHE["rest_offset_len"] = rest_len
        # Correction strength per vertex, smoothly interpolated from the
        # LBS max-weight. w >= HIGH: full correction (safe single-joint
        # region, e.g. middle of the head / middle of the thigh). w <= LOW:
        # no correction (boundary region, e.g. knee crease). Between:
        # linear ramp. This prevents step changes at the boundary that
        # would pinch seams, while still aggressively correcting stable
        # single-joint regions.
        LOW, HIGH = 0.6, 0.9
        max_w = W.max(axis=1)
        strength = np.clip((max_w - LOW) / (HIGH - LOW), 0.0, 1.0).astype(np.float32)
        _FACE_BS_CACHE["normalize_mask"] = strength  # now a [V] float in [0,1]
    else:
        _FACE_BS_CACHE["lbs_weights"] = None
        _FACE_BS_CACHE["rest_weighted_joint_pos"] = None
        _FACE_BS_CACHE["rest_offset_len"] = None
        _FACE_BS_CACHE["normalize_mask"] = None
    # Joint parent hierarchy for bone-length scaling. MHR stores it as a
    # flat tensor in `character_torch.skeleton.joint_parents` on every
    # mhr_head.mhr buffer.
    parents = None
    try:
        bufs = dict(mhr_head.mhr.named_buffers())
        for k in bufs:
            if "joint_parents" in k.lower():
                parents = bufs[k].detach().cpu().numpy().astype(np.int32)
                break
    except Exception:
        parents = None
    _FACE_BS_CACHE["joint_parents"] = parents
    if parents is not None:
        _FACE_BS_CACHE["joint_chain_cats"] = _compute_bone_chain_categories(parents)
    else:
        _FACE_BS_CACHE["joint_chain_cats"] = None

    # Reset region caches when the model changes.
    _FACE_BS_CACHE["v_count"] = None
    _FACE_BS_CACHE["region_ids"] = {}
    _FACE_BS_CACHE["region_deltas"] = {}
    return _FACE_BS_CACHE["rest_verts"]


def _normalize_bone_lengths(vertices: np.ndarray,
                            posed_joint_coords: np.ndarray) -> np.ndarray:
    """Bone-length normalization for single-joint-dominated vertices only.

    For each eligible vertex (max LBS weight > 0.9):
      posed_anchor = weighted joint position
      scale        = rest_len / |vertex - posed_anchor|
      new_vertex   = posed_anchor + offset * scale

    Boundary vertices (where multiple joints contribute significantly)
    are LEFT UNTOUCHED. This is because the LBS-blended posed position of
    a boundary vertex is not a rigid motion of its rest-frame offset —
    applying a length-preserving scale there would distort the knee/elbow
    seam even though the normalization formula looks locally sensible.

    Result: head, torso, individual limb bones (distant from joints) are
    corrected to rest bone lengths; knee/elbow/wrist crease regions stay
    as pure LBS output.
    """
    W = _FACE_BS_CACHE.get("lbs_weights")
    rest_len = _FACE_BS_CACHE.get("rest_offset_len")
    strength = _FACE_BS_CACHE.get("normalize_mask")  # [V] float in [0, 1]
    if W is None or rest_len is None or strength is None or not np.any(strength):
        return vertices
    Wsum = W.sum(axis=1)
    Wsum_safe = np.where(Wsum > 1e-6, Wsum, 1.0).astype(np.float32)
    posed_anchor = (W @ posed_joint_coords) / Wsum_safe[:, None]  # [V, 3]
    posed_offset = vertices - posed_anchor                        # [V, 3]
    posed_len = np.linalg.norm(posed_offset, axis=1).astype(np.float32)
    safe_posed = np.where(posed_len > 1e-6, posed_len, 1.0)
    scale = rest_len / safe_posed
    scale = np.where(np.abs(scale - 1.0) < 0.003, 1.0, scale)
    scale = np.clip(scale, 0.7, 1.3).astype(np.float32)
    # Smooth LBS-dominance based strength: 0 at boundaries (knee/elbow),
    # 1 on bone interiors. effective_scale = lerp(1, scale, strength).
    effective_scale = (1.0 + (scale - 1.0) * strength).astype(np.float32)
    out = posed_anchor + posed_offset * effective_scale[:, None]
    return out.astype(vertices.dtype)


def _load_face_blendshapes(mhr_rest_verts: np.ndarray,
                           presets_dir: str,
                           npz_path: str):
    """Load multi-object blend-shape deltas from the npz and align each
    object's vertex data to MHR indices via per-region NN matching.

    Returns (region_ids, region_deltas):
      - region_ids    : { obj_name : np.int64 [N_region] }  MHR indices owned
                         by that region (from presets/<obj>_vertices.json)
      - region_deltas : { obj_name : { shape_name : np.float32 [N_region, 3] } }
                         delta in MHR frame, reindexed to region_ids ordering.
    """
    v_count = int(mhr_rest_verts.shape[0])
    if _FACE_BS_CACHE["v_count"] == v_count and _FACE_BS_CACHE["region_ids"]:
        return _FACE_BS_CACHE["region_ids"], _FACE_BS_CACHE["region_deltas"]
    if not os.path.exists(npz_path):
        _FACE_BS_CACHE["v_count"] = v_count
        _FACE_BS_CACHE["region_ids"] = {}
        _FACE_BS_CACHE["region_deltas"] = {}
        return {}, {}

    npz = np.load(npz_path)
    if "meta_objects" not in npz.files:
        print(f"[SAM3DBody] face_blendshapes.npz has no 'meta_objects' key "
              f"(legacy layout); regenerate with the updated Blender script.")
        _FACE_BS_CACHE["v_count"] = v_count
        _FACE_BS_CACHE["region_ids"] = {}
        _FACE_BS_CACHE["region_deltas"] = {}
        return {}, {}

    object_names = [str(x) for x in np.asarray(npz["meta_objects"])]

    try:
        from scipy.spatial import cKDTree
    except Exception:
        cKDTree = None

    region_ids = {}
    region_deltas = {}
    for obj_name in object_names:
        base_key = f"base__{obj_name}"
        if base_key not in npz.files:
            continue
        fbx_base = np.asarray(npz[base_key], dtype=np.float32)
        fbx_base_mhr = fbx_base @ _FBX_TO_MHR_ROT.T

        # Region membership comes from presets/<obj>_vertices.json — the
        # authoritative MHR partition. Objects without a matching json
        # (e.g. merged meshes) are skipped with a warning.
        json_path = os.path.join(presets_dir, f"{obj_name}_vertices.json")
        if not os.path.exists(json_path):
            print(f"[SAM3DBody] no region JSON for FBX object '{obj_name}' "
                  f"({json_path}); skipping its blend shapes.")
            continue
        with open(json_path, "r", encoding="utf-8") as f:
            mhr_ids = np.asarray(json.load(f), dtype=np.int64)
        mhr_pos = mhr_rest_verts[mhr_ids].astype(np.float32)

        if cKDTree is not None:
            tree = cKDTree(fbx_base_mhr)
            _, fbx_for_mhr = tree.query(mhr_pos, k=1)
        else:
            fbx_for_mhr = np.empty(len(mhr_pos), dtype=np.int64)
            for i, p in enumerate(mhr_pos):
                d2 = ((fbx_base_mhr - p) ** 2).sum(axis=1)
                fbx_for_mhr[i] = int(d2.argmin())

        region_ids[obj_name] = mhr_ids
        region_deltas[obj_name] = {}

        # Iterate every key in the npz to find this object's deltas; supports
        # any shape name (no hardcoded list).
        prefix = f"delta__{obj_name}__"
        for key in npz.files:
            if not key.startswith(prefix):
                continue
            shape_name = key[len(prefix):]
            delta_fbx = np.asarray(npz[key], dtype=np.float32)
            delta_mhr_all = delta_fbx @ _FBX_TO_MHR_ROT.T
            region_deltas[obj_name][shape_name] = delta_mhr_all[fbx_for_mhr].astype(np.float32)

    _FACE_BS_CACHE["v_count"] = v_count
    _FACE_BS_CACHE["region_ids"] = region_ids
    _FACE_BS_CACHE["region_deltas"] = region_deltas
    return region_ids, region_deltas


def _apply_face_blendshapes(vertices: np.ndarray,
                            mhr_rest_verts: np.ndarray,
                            sliders: dict,
                            joint_rots_posed: np.ndarray,
                            presets_dir: str,
                            npz_path: str) -> np.ndarray:
    """Apply blend-shape deltas to the posed mesh using per-vertex rotation.

    Each MHR vertex carries a dominant-joint index (derived from the MHR
    LBS skinning weights). For every non-zero shape slider, that shape's
    rest-frame delta is rotated **per vertex** by the rest->posed relative
    rotation of the vertex's dominant joint, then added to the posed
    position. This way deformations spanning multiple independently
    rotating bones (arms, legs, whole body) all follow their respective
    bones' pose rotations instead of being locked to a single anchor.

    vertices         : [V, 3] posed vertices (not modified in place)
    mhr_rest_verts   : [V, 3] rest-pose reference (for FBX->MHR alignment)
    sliders          : { shape_name : float }  0 = no effect
    joint_rots_posed : [127, 3, 3]  posed joint world rotations
    presets_dir      : dir containing <obj>_vertices.json region files
    npz_path         : path to face_blendshapes.npz
    """
    if not any(float(v) != 0.0 for v in sliders.values()):
        return vertices
    rest_rots = _FACE_BS_CACHE.get("rest_joint_rots")
    W = _FACE_BS_CACHE.get("lbs_weights")
    if rest_rots is None or W is None:
        return vertices

    region_ids, region_deltas = _load_face_blendshapes(
        mhr_rest_verts, presets_dir, npz_path,
    )
    if not region_deltas:
        return vertices

    # Precompute rest->posed relative rotation per joint.
    R_rel_all = np.zeros_like(rest_rots)              # [J, 3, 3]
    for j in range(rest_rots.shape[0]):
        R_posed = joint_rots_posed[j].astype(np.float32)
        R_rest  = rest_rots[j]
        try:
            R_rest_inv = np.linalg.inv(R_rest).astype(np.float32)
        except np.linalg.LinAlgError:
            R_rest_inv = R_rest.T.astype(np.float32)
        R_rel_all[j] = (R_posed @ R_rest_inv).astype(np.float32)

    # Normalize LBS weights once.
    Wsum = W.sum(axis=1, keepdims=True)
    Wsum_safe = np.where(Wsum > 1e-6, Wsum, 1.0).astype(np.float32)
    W_norm = (W / Wsum_safe).astype(np.float32)        # [V, J]

    out = vertices.copy()
    for obj_name, shape_dict in region_deltas.items():
        mhr_ids = region_ids[obj_name]
        if mhr_ids.size == 0:
            continue
        accum = np.zeros((mhr_ids.shape[0], 3), dtype=np.float32)
        had_any = False
        for shape_name, d in shape_dict.items():
            w = float(sliders.get(shape_name, 0.0))
            if w == 0.0:
                continue
            accum += w * d
            had_any = True
        if not had_any:
            continue
        # LBS-weighted rotation per vertex: linear blend of per-joint
        # rest->posed rotations. Raw `R_eff = Σ w_j · R_j` is NOT a valid
        # rotation matrix at joint boundaries (knees / elbows) — its det
        # drops below 1 and columns lose orthogonality, which compresses
        # the delta ("hollow knee" artifact). We project back to the
        # nearest rotation via SVD: U, Σ, Vᵀ = SVD(R_eff), R_ortho = U·Vᵀ.
        # With the mirror-reflection correction this guarantees det=+1 and
        # columns unit-length, so deltas rotate without scale compression.
        region_W = W_norm[mhr_ids]                                      # [N, J]
        R_eff = np.einsum("vj,jab->vab", region_W, R_rel_all)            # [N, 3, 3]
        U, _S, Vt = np.linalg.svd(R_eff)                                 # batched 3×3 SVD
        # Detect reflections (det = -1) and flip last right-singular row.
        det_uvt = np.linalg.det(np.einsum("vij,vjk->vik", U, Vt))
        flip = det_uvt < 0
        if np.any(flip):
            Vt[flip, -1, :] *= -1
        R_ortho = np.einsum("vij,vjk->vik", U, Vt).astype(np.float32)    # [N, 3, 3]
        rotated = np.einsum("vab,vb->va", R_ortho, accum)                # [N, 3]
        out[mhr_ids] = (out[mhr_ids] + rotated).astype(vertices.dtype)
    return out


# =============================================================================
# Bone length scaling
#
# Four sliders (arm / leg / torso / neck) rescale the length of specific
# bone chains in the rest skeleton. A scale of 1.0 = identity; 0.5 shrinks
# the chain to half, 2.0 doubles it. Each joint's "parent -> self" rest
# offset is multiplied by the slider that owns its category, then the
# resulting per-joint rest deltas are applied as an LBS-weighted vertex
# shift (same pattern as blend shapes). Branch joints (clavicle, thigh)
# keep scale 1.0 so shoulder width and hip width stay constant.
#
# Categories (by MHR joint index; verified against rest-pose JSON):
#   TORSO  : {1, 34, 35, 36, 37, 110}
#            pelvis -> joint_034 -> spine_01/02/03 -> neck_01 chain.
#            pelvis (1) is included so vertices skinned primarily to the
#            pelvis joint (lower abdomen / crotch area) move with the
#            torso shrink instead of staying anchored to the hip — that
#            was the reason the belly appeared "uncrushed" while the
#            chest collapsed.
#   NECK   : {113}                            (head joint only; the link
#                                             from neck_01 -> head is the
#                                             actual neck length)
#   ARMS   : descendants of clavicle_l (74) / clavicle_r (38), EXCLUDING
#            clavicles themselves
#   LEGS   : descendants of thigh_l  (2) / thigh_r  (18), EXCLUDING
#            thighs themselves
# =============================================================================

_TORSO_JOINT_IDS = frozenset({1, 34, 35, 36, 37, 110})
_NECK_JOINT_IDS = frozenset({113})
_ARM_BRANCH_IDS = (38, 74)
_LEG_BRANCH_IDS = (2, 18)


def _compute_bone_chain_categories(parents: np.ndarray) -> np.ndarray:
    """Return a per-joint category id array of shape [J], values in
    {0=none, 1=torso, 2=neck, 3=arm, 4=leg}. A joint's category is driven
    by what chain it belongs to; the category selects which slider scales
    the joint's parent->self rest offset.
    """
    J = parents.shape[0]
    cats = np.zeros(J, dtype=np.int8)

    children = {}
    for j in range(J):
        p = int(parents[j])
        if p >= 0:
            children.setdefault(p, []).append(j)

    def _subtree(root):
        out = []
        stack = [root]
        while stack:
            n = stack.pop()
            out.append(n)
            stack.extend(children.get(n, ()))
        return out

    for j in range(J):
        if j in _TORSO_JOINT_IDS:
            cats[j] = 1
        elif j in _NECK_JOINT_IDS:
            cats[j] = 2
    # Arms: subtree of each clavicle, excluding the clavicle itself.
    for branch in _ARM_BRANCH_IDS:
        if 0 <= branch < J:
            for k in _subtree(branch):
                if k != branch:
                    cats[k] = 3
    # Legs: subtree of each thigh, excluding the thigh itself.
    for branch in _LEG_BRANCH_IDS:
        if 0 <= branch < J:
            for k in _subtree(branch):
                if k != branch:
                    cats[k] = 4
    return cats


# Softening factor for the per-joint isotropic MESH scale. The skeleton
# (joint rest positions) is scaled by the full category value, but the
# mesh around each joint only scales by this fraction of the same
# ratio. 0.5 means: if the torso bone shortens by 40%, the torso mesh
# only shrinks by 20% in girth — keeps the character from turning into
# a stick figure while still giving a genuine length change. Raise
# toward 1.0 for more aggressive body shrink, lower for less.
_MESH_SCALE_STRENGTH = 0.5


def _apply_bone_length_scales(vertices: np.ndarray,
                              arm_scale: float,
                              leg_scale: float,
                              torso_scale: float,
                              neck_scale: float,
                              joint_rots_posed: np.ndarray) -> np.ndarray:
    """Per-joint bone-length scaling with separate joint/mesh scale factors.

    Two per-joint scalars drive the deformation:

      joint_scale[j]  = scale_by_cat[cats[j]]
          Drives the rest-pose joint position (link length). 1.0 leaves
          the bone length alone; 0.6 shortens it to 60%.

      mesh_scale[j]  = 1.0 + _MESH_SCALE_STRENGTH * (joint_scale[j] - 1.0)
                       OR parent's mesh_scale when this joint is a
                       "scale 1.0 branch" (clavicle_l/r, thigh_l/r).
          Drives the isotropic local mesh scale around each joint.
          The inheritance for branch joints is what makes the shoulder
          (clavicle area) and hip (thigh area) mesh follow the torso
          shrink — otherwise the bone under them moves but the mesh
          stays full-size and the body looks disproportionately wide
          around the shoulders or hips.

    Extended LBS:
        new_posed_vert = Σ_j w_j [ mesh_scale[j] · R_rel[j]
                                    · (rest_V - rest_joint[j])
                                    + new_posed_joint[j] ]
    with new_posed_joint derived from forward-kinematics on the
    joint-scaled skeleton (uses joint_scale, not mesh_scale).

    Per-vertex delta:
        delta_V = Σ_j w_j (mesh_scale[j] - 1) · R_rel[j] · local_offset
                  + Σ_j w_j posed_delta[j]
    """
    if (arm_scale == 1.0 and leg_scale == 1.0
            and torso_scale == 1.0 and neck_scale == 1.0):
        return vertices
    W = _FACE_BS_CACHE.get("lbs_weights")
    rest_rots = _FACE_BS_CACHE.get("rest_joint_rots")
    rest_coords = _FACE_BS_CACHE.get("rest_joint_coords")
    rest_verts = _FACE_BS_CACHE.get("rest_verts")
    parents = _FACE_BS_CACHE.get("joint_parents")
    cats = _FACE_BS_CACHE.get("joint_chain_cats")
    if (W is None or rest_rots is None or rest_coords is None
            or rest_verts is None or parents is None or cats is None
            or joint_rots_posed is None):
        return vertices
    num_joints = rest_rots.shape[0]

    # Per-joint rest->posed relative rotation.
    R_rel_all = np.zeros_like(rest_rots)
    for j in range(num_joints):
        R_posed = joint_rots_posed[j].astype(np.float32)
        R_rest = rest_rots[j]
        try:
            R_rest_inv = np.linalg.inv(R_rest).astype(np.float32)
        except np.linalg.LinAlgError:
            R_rest_inv = R_rest.T.astype(np.float32)
        R_rel_all[j] = (R_posed @ R_rest_inv).astype(np.float32)

    scale_by_cat = np.array(
        [1.0, float(torso_scale), float(neck_scale),
         float(arm_scale), float(leg_scale)],
        dtype=np.float32,
    )
    joint_scale = scale_by_cat[cats].astype(np.float32)  # [J]

    # Per-joint mesh scale. Rules by category:
    #   NECK (head, cats=2):
    #       mesh_scale = 1.0. Only the joint position shifts (so the
    #       neck_01 -> head link lengthens/shortens), but the head mesh
    #       itself is left un-scaled — otherwise stretching the neck
    #       would also balloon the head.
    #   PELVIS (joint idx 1, cats=1):
    #       Full-strength torso_scale. The lower-belly / crotch mesh is
    #       skinned almost entirely to the pelvis joint, so the softened
    #       scale used elsewhere barely shrinks it — the belly would
    #       just translate downward with the joint and look "uncrushed".
    #       Giving pelvis the full joint_scale collapses the belly at
    #       the same rate the bone shortens.
    #   TORSO (non-pelvis) / ARM / LEG (cats 1/3/4):
    #       Softened isotropic scale (see _MESH_SCALE_STRENGTH) so the
    #       chest / limbs don't over-thin when shortened.
    #   NONE (cats=0) — branch points, root, face joints:
    #       Inherit from parent. If the parent is NECK, inherit its
    #       mesh_scale (=1.0) directly so face joints don't get stretched
    #       by the neck slider. If the parent has a non-trivial
    #       joint_scale, take that scale at FULL strength (this is what
    #       pulls shoulders / hips into the torso shrink). Otherwise
    #       just chain the parent's mesh_scale.
    # MHR joint_parents order guarantees parent < child.
    _PELVIS_ID = 1
    mesh_scale = np.ones(num_joints, dtype=np.float32)
    for j in range(num_joints):
        c = int(cats[j])
        if c == 2:
            mesh_scale[j] = 1.0
        elif c != 0:
            js = float(joint_scale[j])
            if j == _PELVIS_ID:
                mesh_scale[j] = js
            else:
                mesh_scale[j] = 1.0 + _MESH_SCALE_STRENGTH * (js - 1.0)
        else:
            p = int(parents[j])
            if p >= 0:
                if int(cats[p]) == 2:
                    mesh_scale[j] = mesh_scale[p]
                else:
                    parent_js = float(joint_scale[p])
                    if abs(parent_js - 1.0) > 1e-6:
                        mesh_scale[j] = parent_js
                    else:
                        mesh_scale[j] = mesh_scale[p]

    # Forward sweep for posed_delta (uses joint_scale, NOT mesh_scale —
    # the skeleton's bone length change is driven by joint_scale). We
    # sweep twice so we can split out the NECK-category contribution:
    #   posed_delta         — full effect (all sliders)
    #   posed_delta_no_neck — same but with NECK scales clamped to 1.0
    # The difference (posed_delta - posed_delta_no_neck) isolates the
    # neck slider's contribution, which we rebind rigidly onto face
    # vertices below so stretching the neck does not pull the jaw /
    # cheek boundary with it.
    joint_scale_no_neck = joint_scale.copy()
    joint_scale_no_neck[cats == 2] = 1.0
    posed_delta = np.zeros_like(rest_coords)
    posed_delta_no_neck = np.zeros_like(rest_coords)
    for j in range(num_joints):
        p = int(parents[j])
        if p < 0:
            continue
        off = (rest_coords[j] - rest_coords[p]).astype(np.float32)
        link = R_rel_all[p] @ off
        posed_delta[j]         = posed_delta[p]         + (float(joint_scale[j])         - 1.0) * link
        posed_delta_no_neck[j] = posed_delta_no_neck[p] + (float(joint_scale_no_neck[j]) - 1.0) * link

    Wsum = W.sum(axis=1, keepdims=True)
    Wsum_safe = np.where(Wsum > 1e-6, Wsum, 1.0).astype(np.float32)
    W_norm = (W / Wsum_safe).astype(np.float32)  # [V, J]

    # Mesh isotropic scaling term using mesh_scale (not joint_scale).
    # Per-joint loop keeps memory bounded (no [V, J, 3] temporary).
    mesh_delta = np.zeros_like(rest_verts, dtype=np.float32)
    for j in range(num_joints):
        ms = float(mesh_scale[j])
        if abs(ms - 1.0) < 1e-6:
            continue
        local = (rest_verts - rest_coords[j]).astype(np.float32)
        rotated = local @ R_rel_all[j].T
        mesh_delta += (ms - 1.0) * W_norm[:, j:j+1] * rotated

    # Compose term_C. For face-dominant vertices (heavily skinned to
    # head + face sub-joints), replace the LBS-blended NECK contribution
    # with head's own neck shift so the face moves rigidly when the
    # neck lengthens. Fade smoothly to the plain LBS result around the
    # jaw boundary (face_weight 0.5 → 0.9) so there is no visible seam.
    _HEAD_ID = 113
    _FACE_JOINT_RANGE = np.arange(113, min(127, num_joints), dtype=np.int64)
    posed_delta_neck = posed_delta - posed_delta_no_neck  # [J, 3]
    term_C_no_neck   = (W_norm @ posed_delta_no_neck).astype(np.float32)
    term_C_neck_lbs  = (W_norm @ posed_delta_neck).astype(np.float32)

    face_weight = W_norm[:, _FACE_JOINT_RANGE].sum(axis=1).astype(np.float32)
    LOW, HIGH = 0.5, 0.9
    t = np.clip((face_weight - LOW) / (HIGH - LOW), 0.0, 1.0)
    # smoothstep fade: 3t^2 - 2t^3
    face_strength = (t * t * (3.0 - 2.0 * t)).astype(np.float32)

    rigid_neck_shift = posed_delta_neck[_HEAD_ID].astype(np.float32)  # [3]
    term_C_neck = (
        (1.0 - face_strength[:, None]) * term_C_neck_lbs
        + face_strength[:, None] * rigid_neck_shift[None, :]
    ).astype(np.float32)

    term_C = (term_C_no_neck + term_C_neck).astype(np.float32)

    posed_shift = (mesh_delta + term_C).astype(np.float32)
    return (vertices + posed_shift).astype(vertices.dtype)


def _load_sam3d_model(model_config: dict):
    """
    Load SAM 3D Body model from config paths.

    Uses module-level caching to avoid reloading on every call.
    This runs inside the isolated worker subprocess.
    """
    cache_key = model_config["ckpt_path"]

    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]

    # Import heavy dependencies only inside worker
    from ..sam_3d_body import load_sam_3d_body

    ckpt_path = model_config["ckpt_path"]
    device = model_config["device"]
    mhr_path = model_config.get("mhr_path", "")

    # Load model using the library's built-in function
    print(f"[SAM3DBody] Loading model from {ckpt_path}...")
    sam_3d_model, model_cfg, _ = load_sam_3d_body(
        checkpoint_path=ckpt_path,
        device=device,
        mhr_path=mhr_path,
    )

    print(f"[SAM3DBody] Model loaded successfully on {device}")

    # Cache for reuse
    result = {
        "model": sam_3d_model,
        "model_cfg": model_cfg,
        "device": device,
        "mhr_path": mhr_path,
    }
    _MODEL_CACHE[cache_key] = result

    return result



def _to_serializable(value):
    if value is None:
        return None
    if isinstance(value, torch.Tensor):
        value = value.detach().cpu().numpy()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, dict):
        return {k: _to_serializable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_serializable(v) for v in value]
    return value


def _extract_pose_json(mesh_data, image):
    raw_output = mesh_data.get("raw_output", {}) if isinstance(mesh_data, dict) else {}
    img_h = int(image.shape[1]) if hasattr(image, "shape") and len(image.shape) > 1 else 0
    img_w = int(image.shape[2]) if hasattr(image, "shape") and len(image.shape) > 2 else 0
    pose_json = {
        "body_pose_params": _to_serializable(raw_output.get("body_pose_params")),
        "hand_pose_params": _to_serializable(raw_output.get("hand_pose_params")),
        "global_rot": _to_serializable(raw_output.get("global_rot")),
        "camera": _to_serializable(raw_output.get("pred_cam_t")),
        "focal_length": _to_serializable(raw_output.get("focal_length")),
        "bbox": _to_serializable(raw_output.get("bbox")),
        "keypoints_3d": _to_serializable(raw_output.get("pred_keypoints_3d")),
        "joint_coords": _to_serializable(raw_output.get("pred_joint_coords")),
        "joint_rotations": _to_serializable(raw_output.get("pred_global_rots")),
        "shape_params": _to_serializable(raw_output.get("shape_params")),
        "scale_params": _to_serializable(raw_output.get("scale_params")),
        "expr_params": _to_serializable(raw_output.get("expr_params")),
        "image_size": {
            "height": img_h,
            "width": img_w,
        },
    }
    return json.dumps(pose_json, ensure_ascii=False, indent=2)


def _to_batched_tensor(value, device, width=None):
    if value is None:
        if width is None:
            raise ValueError("width is required when creating a default tensor")
        return torch.zeros((1, width), dtype=torch.float32, device=device)
    if isinstance(value, torch.Tensor):
        tensor = value.to(device=device, dtype=torch.float32)
    else:
        tensor = torch.tensor(value, dtype=torch.float32, device=device)
    if tensor.dim() == 1:
        tensor = tensor.unsqueeze(0)
    return tensor


def _render_mesh_software(vertices, faces, cam_t, focal_length, image):
    h, w = image.shape[:2]
    verts = np.asarray(vertices, dtype=np.float32).copy()
    if verts.ndim == 3:
        verts = verts[0]
    if verts.ndim != 2 or verts.shape[-1] != 3:
        raise ValueError(f"Expected vertices with shape [V,3], got {verts.shape}")
    cam = np.asarray(cam_t, dtype=np.float32).reshape(3)
    faces = np.asarray(faces, dtype=np.int32)

    # Match the original SAM3DBody viewer convention.
    verts[:, 1] *= -1.0
    verts[:, 2] *= -1.0

    verts[:, 0] += cam[0]
    verts[:, 1] += cam[1]
    verts[:, 2] += cam[2]

    z = np.maximum(verts[:, 2], 1e-4)
    x = (verts[:, 0] * focal_length / z) + (w * 0.5)
    y = (verts[:, 1] * focal_length / z) + (h * 0.5)
    pts2d = np.stack([x, y], axis=1)

    out = image.astype(np.float32).copy()
    light_dir = np.array([0.25, -0.35, 1.0], dtype=np.float32)
    light_dir /= np.linalg.norm(light_dir) + 1e-8
    base_color = np.array([198, 214, 220], dtype=np.float32)

    face_depth = verts[faces][:, :, 2].mean(axis=1)
    order = np.argsort(face_depth)[::-1]

    for idx in order:
        tri = faces[idx]
        tri_3d = verts[tri]
        tri_2d = pts2d[tri]

        if np.any(~np.isfinite(tri_2d)):
            continue

        v1 = tri_3d[1] - tri_3d[0]
        v2 = tri_3d[2] - tri_3d[0]
        normal = np.cross(v1, v2)
        n_norm = np.linalg.norm(normal)
        if n_norm < 1e-8:
            continue
        normal /= n_norm

        # Cull backfaces.
        if normal[2] >= 0:
            continue

        shade = np.clip(-float(np.dot(normal, light_dir)), 0.15, 1.0)
        color = np.clip(base_color * (0.55 + 0.45 * shade), 0, 255).astype(np.uint8)

        poly = np.round(tri_2d).astype(np.int32).reshape((-1, 1, 2))
        if np.all(poly[:, 0, 0] < 0) or np.all(poly[:, 0, 0] >= w) or np.all(poly[:, 0, 1] < 0) or np.all(poly[:, 0, 1] >= h):
            continue
        cv2.fillConvexPoly(out, poly, color=tuple(int(c) for c in color.tolist()), lineType=cv2.LINE_AA)

    return np.clip(out, 0, 255).astype(np.uint8)


class SAM3DBodyProcessToJson:
    """Run SAM 3D Body on an image and emit the predicted pose as JSON
    (consumed by the `Render Human From Pose JSON` node).
    The mesh, skeleton, and intermediate visualization produced internally
    are discarded — only the pose parameters reach the downstream nodes."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("SAM3D_MODEL", {
                    "tooltip": "Loaded SAM 3D Body model from Load node",
                }),
                "image": ("IMAGE", {
                    "tooltip": "Input image containing human subject",
                }),
                "bbox_threshold": ("FLOAT", {
                    "default": 0.8, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "Confidence threshold for human detection bounding boxes",
                }),
                "inference_type": (["full", "body", "hand"], {
                    "default": "full",
                    "tooltip": "full: body+hand decoders, body: body decoder only, hand: hand decoder only",
                }),
            },
            "optional": {
                "mask": ("MASK", {
                    "tooltip": "Optional segmentation mask to guide reconstruction",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE")
    RETURN_NAMES = ("pose_json", "image")
    FUNCTION = "process_to_json"
    CATEGORY = "SAM3DBody/processing"

    @staticmethod
    def _bbox_from_mask(mask):
        rows = np.any(mask > 0.5, axis=1)
        cols = np.any(mask > 0.5, axis=0)
        if not rows.any() or not cols.any():
            return None
        rmin, rmax = np.where(rows)[0][[0, -1]]
        cmin, cmax = np.where(cols)[0][[0, -1]]
        return np.array([[cmin, rmin, cmax, rmax]], dtype=np.float32)

    def process_to_json(self, model, image, bbox_threshold=0.8,
                        inference_type="full", mask=None):
        from ..sam_3d_body import SAM3DBodyEstimator

        loaded = _load_sam3d_model(model)
        estimator = SAM3DBodyEstimator(
            sam_3d_body_model=loaded["model"],
            model_cfg=loaded["model_cfg"],
            human_detector=None,
            human_segmentor=None,
            fov_estimator=None,
        )

        img_bgr = comfy_image_to_numpy(image)
        mask_np = None
        bboxes = None
        if mask is not None:
            mask_np = comfy_mask_to_numpy(mask)
            if mask_np.ndim == 3:
                mask_np = mask_np[0]
            bboxes = self._bbox_from_mask(mask_np)

        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            cv2.imwrite(tmp.name, img_bgr)
            tmp_path = tmp.name
        try:
            outputs = estimator.process_one_image(
                tmp_path,
                bboxes=bboxes,
                masks=mask_np,
                bbox_thr=bbox_threshold,
                use_mask=(mask is not None),
                inference_type=inference_type,
            )
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

        if not outputs:
            raise RuntimeError("No people detected in image")

        mesh_data = {"raw_output": outputs[0]}
        pose_json = _extract_pose_json(mesh_data, image)
        return (pose_json, numpy_to_comfy_image(img_bgr))


class SAM3DBodyRenderFromJson:
    @classmethod
    def INPUT_TYPES(cls):
        # UI layout (top to bottom):
        #   1. Core inputs & camera
        #   2. body_*     — PCA body shape (9 axes)
        #   3. bone_*     — bone length scales (4 chains)
        #   4. bs_*       — blend shapes, ordered head->neck->chest->shoulder
        #                   ->waist->limbs
        #
        # Per-slider default values are taken from
        # chara_settings_presets/autosave.json (written at the end of
        # every render call) so the last render's settings persist
        # across ComfyUI restarts. ComfyUI's workflow JSON still takes
        # precedence over these defaults for nodes that already have an
        # explicit value saved — autosave only fills in fresh nodes and
        # first-time loads.
        autosave = _load_autosave()
        body_auto = autosave.get("body_params", {}) if isinstance(autosave, dict) else {}
        bone_auto = autosave.get("bone_lengths", {}) if isinstance(autosave, dict) else {}
        bs_auto   = autosave.get("blendshapes", {}) if isinstance(autosave, dict) else {}

        def _body(key):
            return {"default": float(body_auto.get(key, 0.0)),
                    "min": -5.0, "max": 5.0, "step": 0.01}

        def _bone(key, max_v=2.0):
            return {"default": float(bone_auto.get(key, 1.0)),
                    "min": 0.3, "max": max_v, "step": 0.01}

        def _bs(raw_name):
            return {"default": float(bs_auto.get(raw_name, 0.0)),
                    "min": 0.0, "max": 1.0, "step": 0.01}

        required = {
            # Core
            "model":        ("SAM3D_MODEL",),
            "pose_json":    ("STRING", {"default": "{}"}),
            "preset":       (_discover_character_presets(),
                             {"default": "autosave"}),
            # Camera (intentionally NOT restored from autosave — these
            # are per-shot controls, not part of the character identity)
            "offset_x":     ("FLOAT", {"default": 0.0, "min": -5.0, "max": 5.0, "step": 0.01}),
            "offset_y":     ("FLOAT", {"default": 0.0, "min": -5.0, "max": 5.0, "step": 0.01}),
            "scale_offset": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 5.0, "step": 0.01}),
            # Orbit camera around the subject (always pointing at it).
            # camera_yaw_deg:   horizontal orbit. + = camera moves to the
            #                   viewer's right (subject appears to turn left).
            # camera_pitch_deg: vertical orbit. + = camera moves up (looking
            #                   down at the subject); - = looking up.
            "camera_yaw_deg":   ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 1.0}),
            "camera_pitch_deg": ("FLOAT", {"default": 0.0, "min": -89.0,  "max": 89.0,  "step": 1.0}),
            "width":        ("INT",   {"default": 0,   "min": 0,    "max": 8192}),
            "height":       ("INT",   {"default": 0,   "min": 0,    "max": 8192}),
            # Body (MHR 45-dim PCA, first 9 axes)
            "body_fat":              ("FLOAT", _body("fat")),
            "body_muscle":           ("FLOAT", _body("muscle")),
            "body_fat_muscle":       ("FLOAT", _body("fat_muscle")),
            "body_limb_girth":       ("FLOAT", _body("limb_girth")),
            "body_limb_muscle":      ("FLOAT", _body("limb_muscle")),
            "body_limb_fat":         ("FLOAT", _body("limb_fat")),
            "body_chest_shoulder":   ("FLOAT", _body("chest_shoulder")),
            "body_waist_hip":        ("FLOAT", _body("waist_hip")),
            "body_thigh_calf":       ("FLOAT", _body("thigh_calf")),
            # Bone length (torso range is narrower — extreme stretch is
            # unnatural for the whole pelvis->neck chain)
            "bone_torso":  ("FLOAT", _bone("torso", max_v=1.8)),
            "bone_neck":   ("FLOAT", _bone("neck")),
            "bone_arm":    ("FLOAT", _bone("arm")),
            "bone_leg":    ("FLOAT", _bone("leg")),
        }
        # Blend-shape sliders (discovered from npz; `bs_` prefix added here).
        for bs_name in _discover_blendshape_names():
            required[f"bs_{bs_name}"] = ("FLOAT", _bs(bs_name))
        return {
            "required": required,
            "optional": {
                "background_image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "settings_json")
    FUNCTION = "render"
    CATEGORY = "SAM3DBody/render"

    def render(self, model, pose_json, preset="none",
                     offset_x=0.0, offset_y=0.0, scale_offset=1.0,
                     camera_yaw_deg=0.0, camera_pitch_deg=0.0,
                     width=1024, height=1024,
                     body_fat=0.0, body_muscle=0.0, body_fat_muscle=0.0,
                     body_limb_girth=0.0, body_limb_muscle=0.0, body_limb_fat=0.0,
                     body_chest_shoulder=0.0, body_waist_hip=0.0,
                     body_thigh_calf=0.0,
                     bone_torso=1.0, bone_neck=1.0, bone_arm=1.0, bone_leg=1.0,
                     background_image=None, **bs_kwargs):
        # Strip the `bs_` prefix on the way in — `_apply_face_blendshapes`
        # keys by the FBX shape name, not the UI slider name.
        blendshape_sliders = {}
        for k, v in bs_kwargs.items():
            if k.startswith("bs_"):
                blendshape_sliders[k[3:]] = float(v)

        # The `preset` widget is purely a frontend convenience — selecting
        # one writes that preset's values into the slider widgets via JS
        # (/sam3d/preset/{name}). We deliberately do NOT re-apply the
        # preset here, so any manual tweaks the user makes after picking
        # a preset survive to the render. The only thing we still check
        # on the Python side is the preset NAME: rendering with the
        # `reset` preset selected must NOT overwrite autosave.json (the
        # user is explicitly discarding state, not capturing it).
        active_preset = str(preset)

        # settings_json is intentionally a drop-in character preset. It can
        # be copied into chara_settings_presets/<name>.json as-is to lock
        # the current body shape. Camera offsets and the active preset
        # name are omitted on purpose — those are per-render controls,
        # not part of a saved character identity.
        settings = {
            "body_params": {
                "fat":            float(body_fat),
                "muscle":         float(body_muscle),
                "fat_muscle":     float(body_fat_muscle),
                "limb_girth":     float(body_limb_girth),
                "limb_muscle":    float(body_limb_muscle),
                "limb_fat":       float(body_limb_fat),
                "chest_shoulder": float(body_chest_shoulder),
                "waist_hip":      float(body_waist_hip),
                "thigh_calf":     float(body_thigh_calf),
            },
            "bone_lengths": {
                "torso": float(bone_torso),
                "neck":  float(bone_neck),
                "arm":   float(bone_arm),
                "leg":   float(bone_leg),
            },
            "blendshapes": {k: float(v) for k, v in sorted(blendshape_sliders.items())},
        }

        try:
            payload = json.loads(pose_json) if pose_json else {}
        except Exception:
            payload = {}
        loaded = _load_sam3d_model(model)
        sam_3d_model = loaded["model"]
        device = torch.device(loaded["device"])

        mhr_head = sam_3d_model.head_pose
        global_rot = _to_batched_tensor(payload.get("global_rot"), device, width=3)
        body_pose = _to_batched_tensor(payload.get("body_pose_params"), device, width=133)
        hand_pose = _to_batched_tensor(payload.get("hand_pose_params"), device, width=108)
        # expr_params (72-dim MHR facial-expression basis) is intentionally
        # zeroed: SAM3D's estimate leaks body-type cues (big anime eyes,
        # round chibi face, etc.) through face blend shapes, which makes
        # the head appear larger or smaller on the MHR neutral body. With
        # zeros the head is always the MHR rest-pose head.
        expr_params = torch.zeros(
            (1, mhr_head.num_face_comps), dtype=torch.float32, device=device,
        )
        global_trans = torch.zeros((1, 3), dtype=torch.float32, device=device)

        # Body-shape policy:
        #   The 9 shape_* UI sliders drive the first 9 components of MHR's
        #   45-dim PCA shape basis (shape_params[0..8]). Remaining components
        #   stay at 0. scale_params is held at 0 (MHR default skeleton scale).
        #
        # The character's predicted shape from pose_json is intentionally
        # ignored so that, with all sliders at 0, the output is MHR's neutral
        # body regardless of the input image.
        #
        # Per-axis normalization: PCA basis magnitudes shrink rapidly after
        # PC0 (~16x smaller by PC8). These factors (= basis_rms[0] /
        # basis_rms[i], measured from the MHR shape_vectors buffer) rescale
        # each UI slider so the visible deformation per unit is comparable
        # across all 9 axes.
        shape_axes = [
            float(body_fat),
            float(body_muscle),
            float(body_fat_muscle),
            float(body_limb_girth),
            float(body_limb_muscle),
            float(body_limb_fat),
            float(body_chest_shoulder),
            float(body_waist_hip),
            float(body_thigh_calf),
        ]
        SHAPE_SLIDER_NORM = (
            1.00, 2.78, 4.42, 8.74, 10.82, 11.70, 13.39, 13.83, 16.62,
        )
        # Per-axis sign correction. MHR's PCA basis has arbitrary sign
        # conventions, so some UI sliders map to the inverse direction of
        # their name. +1 keeps the axis as-is; -1 flips so that positive UI
        # values match the slider's semantic label.
        SHAPE_SLIDER_SIGN = (
            +1,  # 0 body_fat
            -1,  # 1 body_muscle: flip so +=muscular, -=slim (README semantics)
            -1,  # 2 body_fat_muscle: flip so +=fatter / -=leaner-muscular
            +1,  # 3 body_limb_girth
            -1,  # 4 body_limb_muscle: flip so +=muscular limbs
            +1,  # 5 body_limb_fat
            -1,  # 6 body_chest_shoulder: PCA points the other way, flip so +=wider
            +1,  # 7 body_waist_hip
            +1,  # 8 body_thigh_calf
        )
        shape_params = torch.zeros(
            (1, mhr_head.num_shape_comps), dtype=torch.float32, device=device,
        )
        n_axes = min(len(shape_axes), mhr_head.num_shape_comps)
        for i in range(n_axes):
            shape_params[0, i] = (
                shape_axes[i] * SHAPE_SLIDER_NORM[i] * SHAPE_SLIDER_SIGN[i]
            )
        scale_params = torch.zeros(
            (1, mhr_head.num_scale_comps), dtype=torch.float32, device=device,
        )

        with torch.no_grad():
            mhr_out = sam_3d_model.head_pose.mhr_forward(
                global_trans=global_trans,
                global_rot=global_rot,
                body_pose_params=body_pose,
                hand_pose_params=hand_pose,
                scale_params=scale_params,
                shape_params=shape_params,
                expr_params=expr_params,
                return_joint_rotations=True,
                return_joint_coords=True,
            )
        # mhr_forward returns a tuple (verts, ...) with extras in the order
        # they were requested. We asked for both rotations and coords; pick
        # them by tensor shape rather than index to stay robust.
        verts = mhr_out[0]
        joint_rots = None
        joint_coords = None
        for t in mhr_out[1:]:
            if t.ndim == 4 and t.shape[-1] == 3 and t.shape[-2] == 3:
                joint_rots = t
            elif t.ndim == 3 and t.shape[-1] == 3 and t.shape[-2] != 3:
                joint_coords = t

        vertices = verts.detach().cpu().numpy()
        if vertices.ndim == 3:
            vertices = vertices[0]
        rots_np = joint_rots.detach().cpu().numpy() if joint_rots is not None else None
        if rots_np is not None and rots_np.ndim == 4:
            rots_np = rots_np[0]
        coords_np = joint_coords.detach().cpu().numpy() if joint_coords is not None else None
        if coords_np is not None and coords_np.ndim == 3:
            coords_np = coords_np[0]
        faces = sam_3d_model.head_pose.faces.detach().cpu().numpy()

        # Normalize each bone's vertex cloud back to its rest size. MHR
        # pose correctives (and any non-rotation content in body_pose_params)
        # otherwise stretch the head / torso / limbs based on the input
        # character's body type. Must run BEFORE blend shapes so shape-key
        # deltas apply to a canonical-sized body.
        if coords_np is not None:
            _get_mhr_rest_verts(mhr_head, device)  # ensure metrics cached
            vertices = _normalize_bone_lengths(vertices, coords_np)

        # Face / neck blend-shapes (FBX-derived morph targets). Shapes may
        # span multiple FBX objects (e.g. neck_lengthen on head+neck+chest);
        # each object's delta is applied to its corresponding MHR region.
        from ..preset_pack import active_pack_dir as _pack_dir
        presets_dir = str(_pack_dir())
        bs_npz_path = os.path.join(presets_dir, "face_blendshapes.npz")
        bs_sliders = {k: float(v) for k, v in blendshape_sliders.items()}
        if any(v != 0.0 for v in bs_sliders.values()):
            rest_verts = _get_mhr_rest_verts(mhr_head, device)
            vertices = _apply_face_blendshapes(
                vertices, rest_verts, bs_sliders, rots_np,
                presets_dir, bs_npz_path,
            )

        # Bone-length scaling. Each slider scales the parent->self rest
        # offset of every joint in its category (torso / neck / arm / leg)
        # and applies the resulting per-joint rest deltas as an
        # LBS-weighted, posed-frame vertex shift.
        if rots_np is not None and (
            float(bone_arm) != 1.0
            or float(bone_leg) != 1.0
            or float(bone_torso) != 1.0
            or float(bone_neck) != 1.0
        ):
            _get_mhr_rest_verts(mhr_head, device)  # ensure caches ready
            vertices = _apply_bone_length_scales(
                vertices,
                arm_scale=float(bone_arm),
                leg_scale=float(bone_leg),
                torso_scale=float(bone_torso),
                neck_scale=float(bone_neck),
                joint_rots_posed=rots_np,
            )

        if background_image is not None:
            bg_bgr = comfy_image_to_numpy(background_image)
            render_h, render_w = bg_bgr.shape[:2]
        else:
            render_h = int(payload.get("image_size", {}).get("height") or height or 1024)
            render_w = int(payload.get("image_size", {}).get("width") or width or 1024)
            bg_bgr = np.zeros((render_h, render_w, 3), dtype=np.uint8)

        # Camera + focal: preserve the pose_json's original composition
        # while neutralizing its body-type dependence.
        #
        # pose_json's `pred_cam_t` was tuned so that the ORIGINAL subject
        # (chibi / adult / etc.) fills the frame the way the input image
        # shows. Using it verbatim makes a chibi pose_json zoom in tightly
        # on the MHR neutral body's head. But reverting to a fixed camera
        # loses the original framing (center offset, tilt, crop).
        #
        # Strategy: scale the original camera vector by the body-size
        # ratio `MHR_height / original_height`. A pure uniform scaling
        # preserves angular position (center stays centered) and angular
        # size (body fills the frame the same way), regardless of whether
        # the original subject was a chibi or a tall adult. The MHR body
        # proportions come from the mesh itself (shape_params stay fixed),
        # so the head-to-body ratio on screen is what the settings say.
        #
        # If pose_json has no camera/keypoints, fall back to auto-framing
        # based on the MHR body's own bounding box.
        focal_length = None
        fval = payload.get("focal_length")
        if isinstance(fval, list):
            focal_length = float(fval[0]) if fval else None
        elif isinstance(fval, np.ndarray):
            focal_length = float(fval.reshape(-1)[0]) if fval.size else None
        elif fval is not None:
            focal_length = float(fval)
        if not focal_length or focal_length <= 0:
            focal_length = max(render_w, render_h) * 1.2

        orig_cam = payload.get("camera")
        kpts_3d = payload.get("keypoints_3d")

        # Current MHR mesh bounds (after pose + bone normalization + blend shapes).
        mhr_mins = vertices.min(axis=0)
        mhr_maxs = vertices.max(axis=0)
        mhr_cx = float((mhr_mins[0] + mhr_maxs[0]) * 0.5)
        mhr_cy = float((mhr_mins[1] + mhr_maxs[1]) * 0.5)
        mhr_cz = float((mhr_mins[2] + mhr_maxs[2]) * 0.5)
        mhr_h_extent = float(mhr_maxs[1] - mhr_mins[1])

        camera = None
        if orig_cam is not None and kpts_3d is not None:
            try:
                kpts = np.asarray(kpts_3d, dtype=np.float32).reshape(-1, 3)
                if kpts.shape[0] >= 2:
                    kmin = kpts.min(axis=0)
                    kmax = kpts.max(axis=0)
                    orig_cx = float((kmin[0] + kmax[0]) * 0.5)
                    orig_cy = float((kmin[1] + kmax[1]) * 0.5)
                    orig_cz = float((kmin[2] + kmax[2]) * 0.5)
                    orig_h = float(kmax[1] - kmin[1])
                    if orig_h > 1e-4 and mhr_h_extent > 1e-4:
                        ratio = mhr_h_extent / orig_h
                        c = np.asarray(orig_cam, dtype=np.float32).reshape(3)
                        # Preserve the original image's composition: match
                        # each axis's pixel projection of the subject's
                        # centroid. Derivation (all in camera/flipped frame):
                        #   orig px = (orig_c + orig_cam) * focal / (orig_cz + orig_cam_z)
                        #   mhr  px = (mhr_c_flipped + cam) * focal / (mhr_cz_flipped + cam_z)
                        # Angular-size match fixes the denominator ratio, then:
                        #   cam = ratio * (orig_c + orig_cam) - mhr_c_flipped
                        # MHR vertices are in MHR native (unflipped) frame,
                        # the renderer flips Y/Z before adding cam, so
                        # mhr_c_flipped = (mhr_cx, -mhr_cy, -mhr_cz) relative
                        # to the native centroid computed above.
                        cam_x = ratio * (orig_cx + float(c[0])) - mhr_cx
                        cam_y = ratio * (orig_cy + float(c[1])) + mhr_cy
                        cam_z = ratio * (orig_cz + float(c[2])) + mhr_cz
                        camera = np.array([cam_x, cam_y, cam_z], dtype=np.float32)
            except Exception:
                camera = None

        if camera is None:
            # Fallback auto-framing from MHR body bounds.
            mins = vertices.min(axis=0)
            maxs = vertices.max(axis=0)
            cx = float((mins[0] + maxs[0]) * 0.5)
            cy = float((mins[1] + maxs[1]) * 0.5)
            cz = float((mins[2] + maxs[2]) * 0.5)
            w_extent = float(maxs[0] - mins[0])
            h_extent = float(maxs[1] - mins[1])
            MARGIN = 0.9
            cam_z_v = cz + h_extent * focal_length / (MARGIN * render_h)
            cam_z_h = cz + w_extent * focal_length / (MARGIN * render_w)
            camera = np.array(
                [-cx, cy, float(max(cam_z_v, cam_z_h, 0.5))],
                dtype=np.float32,
            )

        # UI overrides apply on top.
        camera[0] += float(offset_x)
        camera[1] += float(offset_y)
        # Intuitive scale: larger value = closer / subject bigger.
        # Camera z is divided by the slider so +1 = identity, 2.0 pulls
        # camera to half distance, 0.5 pushes it to double.
        s = float(scale_offset)
        if abs(s) > 1e-6:
            camera[2] /= s

        # Orbit camera around the MHR mesh center. Rather than moving the
        # camera (which would also require updating the look direction),
        # rotate the vertices around the subject centroid by the inverse
        # rotation. Because the renderer flips Y/Z internally, the rotation
        # matrix is built in MHR-native frame (before the flip):
        #   yaw  > 0 → camera moves to viewer's right → R_y(-yaw_rad)
        #   pitch> 0 → camera moves up (looks down)   → R_x(+pitch_rad)
        # Composition is pitch * yaw (turntable: yaw around world up first,
        # then pitch tilts), applied to the vertex offset from the centroid.
        # The framing (camera distance, scale) is preserved because the
        # centroid is invariant under this rotation.
        yaw_rad = float(np.deg2rad(camera_yaw_deg))
        pitch_rad = float(np.deg2rad(camera_pitch_deg))
        if abs(yaw_rad) > 1e-6 or abs(pitch_rad) > 1e-6:
            cos_y, sin_y = np.cos(yaw_rad), np.sin(yaw_rad)
            R_yaw_mhr = np.array(
                [[ cos_y, 0.0, -sin_y],
                 [   0.0, 1.0,    0.0],
                 [ sin_y, 0.0,  cos_y]], dtype=np.float32,
            )
            cos_p, sin_p = np.cos(pitch_rad), np.sin(pitch_rad)
            R_pitch_mhr = np.array(
                [[1.0,   0.0,    0.0],
                 [0.0, cos_p, -sin_p],
                 [0.0, sin_p,  cos_p]], dtype=np.float32,
            )
            R_orbit = (R_pitch_mhr @ R_yaw_mhr).astype(np.float32)
            O_mhr = np.array([mhr_cx, mhr_cy, mhr_cz], dtype=np.float32)
            vertices = (vertices - O_mhr) @ R_orbit.T + O_mhr

        rendered_bgr = _render_mesh_software(
            vertices=vertices,
            faces=faces,
            cam_t=camera,
            focal_length=focal_length,
            image=bg_bgr,
        )
        # Persist the current settings as defaults for the next ComfyUI
        # start / refresh (best effort — failures don't block rendering).
        # Rendering with `preset=reset` is a "discard state" action, so
        # autosave is intentionally skipped — otherwise selecting reset
        # would clobber the previous character's saved values.
        if active_preset != "reset":
            _save_autosave(settings)
        return (numpy_to_comfy_image(rendered_bgr), json.dumps(settings, ensure_ascii=False, indent=2))


# Register nodes
NODE_CLASS_MAPPINGS = {
    "SAM3DBodyProcessToJson": SAM3DBodyProcessToJson,
    "SAM3DBodyRenderFromJson": SAM3DBodyRenderFromJson,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SAM3DBodyProcessToJson": "SAM 3D Body: Process Image to Pose JSON",
    "SAM3DBodyRenderFromJson": "SAM 3D Body: Render Human From Pose JSON",
}
