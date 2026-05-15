"""Pose Studio image-to-SAM3D JSON bridge.

The original integration called the external SAM3DBody custom node through
ComfyUI's global node registry. This internal bridge keeps the same output
shape while loading the vendored inference code directly.
"""

from __future__ import annotations

import json

import numpy as np

from . import progress


def _dependency_error(exc: Exception) -> RuntimeError:
    return RuntimeError(
        "[VNCCS] Internal SAM3D import dependencies are missing or incompatible. "
        "Install the optional SAM3D runtime packages in the active ComfyUI "
        "environment, then restart ComfyUI. Original error: "
        f"{type(exc).__name__}: {exc}"
    )


def process_image_to_pose_json(image_tensor):
    try:
        import torch

        from .processing.load_model import LoadSAM3DBodyModel
        from .processing.process import (
            SAM3DBodyProcessToJson,
            _FACE_BS_CACHE,
            _get_mhr_rest_verts,
            _load_sam3d_model,
            _to_batched_tensor,
        )
    except Exception as exc:
        raise _dependency_error(exc) from exc

    progress.update("Step 2/6: Checking SAM 3D Body model files...", 4)
    model = LoadSAM3DBodyModel().load_model("Auto")[0]
    progress.update("Step 4/6: Preparing SAM 3D Body reconstruction...", 55)
    pose_json = SAM3DBodyProcessToJson().process_to_json(
        model=model,
        image=image_tensor,
        bbox_threshold=0.8,
        inference_type="full",
    )[0]
    progress.update("Step 5/6: Building Pose Studio skeleton data...", 82)

    try:
        pose_data = json.loads(pose_json)
    except Exception:
        return pose_json

    try:
        loaded = _load_sam3d_model(model)
        sam_3d_model = loaded["model"]
        device = torch.device(loaded["device"])
        mhr_head = sam_3d_model.head_pose

        global_trans = torch.zeros((1, 3), dtype=torch.float32, device=device)
        rest_global_rot = torch.zeros((1, 3), dtype=torch.float32, device=device)
        rest_body_pose = torch.zeros((1, 133), dtype=torch.float32, device=device)
        rest_hand_pose = torch.zeros((1, 108), dtype=torch.float32, device=device)
        scale_params = torch.zeros((1, mhr_head.num_scale_comps), dtype=torch.float32, device=device)
        shape_params = torch.zeros((1, mhr_head.num_shape_comps), dtype=torch.float32, device=device)
        expr_params = torch.zeros((1, mhr_head.num_face_comps), dtype=torch.float32, device=device)

        with torch.no_grad():
            posed_out = mhr_head.mhr_forward(
                global_trans=global_trans,
                global_rot=_to_batched_tensor(pose_data.get("global_rot"), device, width=3),
                body_pose_params=_to_batched_tensor(pose_data.get("body_pose_params"), device, width=133),
                hand_pose_params=_to_batched_tensor(pose_data.get("hand_pose_params"), device, width=108),
                scale_params=scale_params,
                shape_params=shape_params,
                expr_params=expr_params,
                return_keypoints=True,
                return_joint_rotations=True,
                return_joint_coords=True,
            )
            rest_out = mhr_head.mhr_forward(
                global_trans=global_trans,
                global_rot=rest_global_rot,
                body_pose_params=rest_body_pose,
                hand_pose_params=rest_hand_pose,
                scale_params=scale_params,
                shape_params=shape_params,
                expr_params=expr_params,
                return_joint_rotations=True,
                return_joint_coords=True,
            )

        posed_rots = None
        posed_coords = None
        posed_keypoints = None
        for tensor in posed_out[1:]:
            if tensor.ndim == 4 and tensor.shape[-1] == 3 and tensor.shape[-2] == 3:
                posed_rots = tensor.detach().cpu().numpy()
            elif tensor.ndim == 3 and tensor.shape[-1] == 3 and tensor.shape[-2] > 127:
                posed_keypoints = tensor.detach().cpu().numpy()
            elif tensor.ndim == 3 and tensor.shape[-1] == 3 and tensor.shape[-2] != 3:
                posed_coords = tensor.detach().cpu().numpy()

        if posed_rots is not None:
            if posed_rots.ndim == 4:
                posed_rots = posed_rots[0]
            pose_data["joint_rotations"] = posed_rots.tolist()
        if posed_coords is not None:
            if posed_coords.ndim == 3:
                posed_coords = posed_coords[0]
            pose_data["joint_coords"] = posed_coords.tolist()
        if posed_keypoints is not None:
            if posed_keypoints.ndim == 3:
                posed_keypoints = posed_keypoints[0]
            pose_data["canonical_keypoints_3d"] = posed_keypoints[:70].tolist()

        rest_rots = None
        rest_coords = None
        for tensor in rest_out[1:]:
            if tensor.ndim == 4 and tensor.shape[-1] == 3 and tensor.shape[-2] == 3:
                rest_rots = tensor.detach().cpu().numpy()
            elif tensor.ndim == 3 and tensor.shape[-1] == 3 and tensor.shape[-2] != 3:
                rest_coords = tensor.detach().cpu().numpy()
        if rest_rots is not None:
            if rest_rots.ndim == 4:
                rest_rots = rest_rots[0]
            pose_data["rest_joint_rotations"] = rest_rots.tolist()
        if rest_coords is not None:
            if rest_coords.ndim == 3:
                rest_coords = rest_coords[0]
            pose_data["rest_joint_coords"] = rest_coords.tolist()

        try:
            _get_mhr_rest_verts(mhr_head, device)
            parents = _FACE_BS_CACHE.get("joint_parents")
            if parents is not None:
                pose_data["joint_parents"] = np.asarray(parents, dtype=np.int32).tolist()
        except Exception:
            pass

        num_joints = 0
        for candidate in (
            pose_data.get("joint_rotations"),
            pose_data.get("rest_joint_rotations"),
            pose_data.get("joint_coords"),
        ):
            if isinstance(candidate, list):
                num_joints = max(num_joints, len(candidate))
        known_joint_names = {
            1: "pelvis",
            2: "thigh_l", 3: "calf_l", 4: "foot_l",
            18: "thigh_r", 19: "calf_r", 20: "foot_r",
            35: "spine_01", 36: "spine_02", 37: "spine_03",
            38: "clavicle_r", 39: "upperarm_r", 40: "lowerarm_r", 42: "hand_r",
            74: "clavicle_l", 75: "upperarm_l", 76: "lowerarm_l", 78: "hand_l",
            110: "neck_01", 113: "head",
        }
        pose_data["joint_names"] = [
            known_joint_names.get(index, f"joint_{index:03d}")
            for index in range(num_joints)
        ]
        pose_data["sam3d_pose_space"] = "mhr_forward_canonical"
        progress.finish("Step 6/6: SAM 3D Body import complete.")
        return json.dumps(pose_data, ensure_ascii=False, indent=2)
    except Exception as exc:
        print(f"[VNCCS] SAM3D rest skeleton export failed: {exc}")
        progress.finish("Step 6/6: SAM 3D Body pose reconstructed.")
        return pose_json


def process_pose_json_to_overlay_mesh(pose_data, body_preset=None, pose_adjust=0.0):
    """Build the same postprocessed MHR mesh used by the SAM render node.

    This returns geometry only, so Pose Studio can overlay it in Three.js
    without relying on a 2D render screenshot.
    """
    try:
        import os
        import torch

        from .processing.load_model import LoadSAM3DBodyModel
        from .processing.process import (
            _FACE_BS_CACHE,
            _apply_bone_length_scales,
            _apply_face_blendshapes,
            _get_mhr_rest_verts,
            _load_sam3d_model,
            _normalize_bone_lengths,
            _to_batched_tensor,
            apply_pose_lean_correction_mesh,
        )
    except Exception as exc:
        raise _dependency_error(exc) from exc

    payload = pose_data if isinstance(pose_data, dict) else {}
    preset = body_preset if isinstance(body_preset, dict) else {}
    body_params = preset.get("body_params") or {}
    bone_lengths = preset.get("bone_lengths") or {}
    blendshape_sliders = {
        str(k): float(v) for k, v in (preset.get("blendshapes") or {}).items()
    }

    model = LoadSAM3DBodyModel().load_model("Auto")[0]
    loaded = _load_sam3d_model(model)
    sam_3d_model = loaded["model"]
    device = torch.device(loaded["device"])
    mhr_head = sam_3d_model.head_pose

    global_rot = _to_batched_tensor(payload.get("global_rot"), device, width=3)
    body_pose = _to_batched_tensor(payload.get("body_pose_params"), device, width=133)
    hand_pose = _to_batched_tensor(payload.get("hand_pose_params"), device, width=108)
    expr_params = torch.zeros((1, mhr_head.num_face_comps), dtype=torch.float32, device=device)
    global_trans = torch.zeros((1, 3), dtype=torch.float32, device=device)

    shape_axes = [
        float(body_params.get("fat", 0.0)),
        float(body_params.get("muscle", 0.0)),
        float(body_params.get("fat_muscle", 0.0)),
        float(body_params.get("limb_girth", 0.0)),
        float(body_params.get("limb_muscle", 0.0)),
        float(body_params.get("limb_fat", 0.0)),
        float(body_params.get("chest_shoulder", 0.0)),
        float(body_params.get("waist_hip", 0.0)),
        float(body_params.get("thigh_calf", 0.0)),
    ]
    shape_norm = (1.00, 2.78, 4.42, 8.74, 10.82, 11.70, 13.39, 13.83, 16.62)
    shape_sign = (+1, -1, -1, +1, -1, +1, -1, +1, +1)
    shape_params = torch.zeros((1, mhr_head.num_shape_comps), dtype=torch.float32, device=device)
    for i in range(min(len(shape_axes), mhr_head.num_shape_comps)):
        shape_params[0, i] = shape_axes[i] * shape_norm[i] * shape_sign[i]
    scale_params = torch.zeros((1, mhr_head.num_scale_comps), dtype=torch.float32, device=device)

    with torch.no_grad():
        mhr_out = mhr_head.mhr_forward(
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

    verts = mhr_out[0]
    joint_rots = None
    joint_coords = None
    for tensor in mhr_out[1:]:
        if tensor.ndim == 4 and tensor.shape[-1] == 3 and tensor.shape[-2] == 3:
            joint_rots = tensor
        elif tensor.ndim == 3 and tensor.shape[-1] == 3 and tensor.shape[-2] != 3:
            joint_coords = tensor

    vertices = verts.detach().cpu().numpy()
    if vertices.ndim == 3:
        vertices = vertices[0]
    rots_np = joint_rots.detach().cpu().numpy() if joint_rots is not None else None
    if rots_np is not None and rots_np.ndim == 4:
        rots_np = rots_np[0]
    coords_np = joint_coords.detach().cpu().numpy() if joint_coords is not None else None
    if coords_np is not None and coords_np.ndim == 3:
        coords_np = coords_np[0]

    vertices_before_post = vertices.astype(np.float32, copy=True)
    if coords_np is not None:
        _get_mhr_rest_verts(mhr_head, device)
        vertices = _normalize_bone_lengths(vertices, coords_np)

    if blendshape_sliders and any(v != 0.0 for v in blendshape_sliders.values()):
        from .preset_pack import active_pack_dir

        presets_dir = str(active_pack_dir())
        rest_verts = _get_mhr_rest_verts(mhr_head, device)
        vertices = _apply_face_blendshapes(
            vertices,
            rest_verts,
            blendshape_sliders,
            rots_np,
            presets_dir,
            os.path.join(presets_dir, "face_blendshapes.npz"),
        )

    bone_torso = float(bone_lengths.get("torso", 1.0))
    bone_neck = float(bone_lengths.get("neck", 1.0))
    bone_arm = float(bone_lengths.get("arm", 1.0))
    bone_leg = float(bone_lengths.get("leg", 1.0))
    if rots_np is not None and (
        bone_arm != 1.0 or bone_leg != 1.0 or bone_torso != 1.0 or bone_neck != 1.0
    ):
        _get_mhr_rest_verts(mhr_head, device)
        vertices = _apply_bone_length_scales(
            vertices,
            arm_scale=bone_arm,
            leg_scale=bone_leg,
            torso_scale=bone_torso,
            neck_scale=bone_neck,
            joint_rots_posed=rots_np,
        )

    try:
        lean_strength = float(pose_adjust)
    except (TypeError, ValueError):
        lean_strength = 0.0
    if coords_np is not None and lean_strength > 1e-6:
        vertices = apply_pose_lean_correction_mesh(vertices, coords_np, lean_strength)

    fitted_coords = None
    if coords_np is not None:
        fitted_coords = coords_np.astype(np.float32, copy=True)
        weights = _FACE_BS_CACHE.get("lbs_weights")
        if weights is not None:
            delta = vertices.astype(np.float32) - vertices_before_post.astype(np.float32)
            normalize_strength = _FACE_BS_CACHE.get("normalize_mask")
            num_joints = min(fitted_coords.shape[0], weights.shape[1])
            for joint_index in range(num_joints):
                w = weights[:, joint_index].astype(np.float32)
                if normalize_strength is not None:
                    effective = w * normalize_strength.astype(np.float32)
                    strong = effective > 1e-5
                    ww = effective[strong]
                else:
                    strong = w > 0.08
                    ww = w[strong]
                if not np.any(strong):
                    continue
                denom = float(ww.sum())
                if denom > 1e-6:
                    fitted_coords[joint_index] += (delta[strong] * ww[:, None]).sum(axis=0) / denom

    faces = sam_3d_model.head_pose.faces.detach().cpu().numpy().astype(np.int32)
    render_frame = None
    try:
        render_h = int((payload.get("image_size") or {}).get("height") or 1024)
        render_w = int((payload.get("image_size") or {}).get("width") or 1024)
        fval = payload.get("focal_length")
        if isinstance(fval, list):
            focal_length = float(fval[0]) if fval else None
        elif fval is not None:
            focal_length = float(np.asarray(fval, dtype=np.float32).reshape(-1)[0])
        else:
            focal_length = None
        if not focal_length or focal_length <= 0:
            focal_length = max(render_w, render_h) * 1.2

        camera = None
        orig_cam = payload.get("camera")
        pred_vertices_bounds = payload.get("pred_vertices_bounds") or {}
        if orig_cam is not None:
            try:
                orig_center = pred_vertices_bounds.get("center")
                orig_extent = pred_vertices_bounds.get("extent")
                if orig_center is None or orig_extent is None:
                    kpts = np.asarray(payload.get("keypoints_3d"), dtype=np.float32).reshape(-1, 3)
                    if kpts.shape[0] >= 2:
                        kmin = kpts.min(axis=0)
                        kmax = kpts.max(axis=0)
                        orig_center = ((kmin + kmax) * 0.5).tolist()
                        orig_extent = (kmax - kmin).tolist()
                orig_center = np.asarray(orig_center, dtype=np.float32).reshape(3)
                orig_extent = np.asarray(orig_extent, dtype=np.float32).reshape(3)
                orig_h = float(orig_extent[1])
                mhr_mins = vertices.min(axis=0)
                mhr_maxs = vertices.max(axis=0)
                mhr_center = (mhr_mins + mhr_maxs) * 0.5
                mhr_h = float(mhr_maxs[1] - mhr_mins[1])
                if orig_h > 1e-4 and mhr_h > 1e-4:
                    ratio = mhr_h / orig_h
                    c = np.asarray(orig_cam, dtype=np.float32).reshape(3)
                    camera = np.array([
                        ratio * (float(orig_center[0]) + float(c[0])) - float(mhr_center[0]),
                        ratio * (float(orig_center[1]) + float(c[1])) + float(mhr_center[1]),
                        ratio * (float(orig_center[2]) + float(c[2])) + float(mhr_center[2]),
                    ], dtype=np.float32)
            except Exception:
                camera = None

        if camera is None:
            mins = vertices.min(axis=0)
            maxs = vertices.max(axis=0)
            center = (mins + maxs) * 0.5
            w_extent = float(maxs[0] - mins[0])
            h_extent = float(maxs[1] - mins[1])
            margin = 0.9
            cam_z_v = float(center[2]) + h_extent * focal_length / (margin * render_h)
            cam_z_h = float(center[2]) + w_extent * focal_length / (margin * render_w)
            camera = np.array([
                -float(center[0]),
                float(center[1]),
                float(max(cam_z_v, cam_z_h, 0.5)),
            ], dtype=np.float32)

        projected = vertices.astype(np.float32, copy=True)
        projected[:, 1] *= -1.0
        projected[:, 2] *= -1.0
        projected += camera.reshape(1, 3)
        z = np.maximum(projected[:, 2], 1e-4)
        px = projected[:, 0] * focal_length / z + render_w * 0.5
        py = projected[:, 1] * focal_length / z + render_h * 0.5
        finite = np.isfinite(px) & np.isfinite(py)
        if np.count_nonzero(finite) >= 16:
            xs = np.sort(px[finite])
            ys = np.sort(py[finite])
            pick = lambda values, q: float(values[int(np.clip(np.floor((len(values) - 1) * q), 0, len(values) - 1))])
            render_frame = {
                "image_size": {"width": render_w, "height": render_h},
                "focal_length": float(focal_length),
                "camera": camera.astype(np.float32).tolist(),
                "projected_bounds": {
                    "x1": pick(xs, 0.01),
                    "y1": pick(ys, 0.01),
                    "x2": pick(xs, 0.99),
                    "y2": pick(ys, 0.99),
                },
            }
    except Exception as exc:
        print(f"[VNCCS] SAM3D overlay render frame export failed: {exc}")

    return {
        "vertices": vertices.astype(np.float32).reshape(-1, 3).tolist(),
        "faces": faces.reshape(-1, 3).tolist(),
        "joint_coords": coords_np.astype(np.float32).tolist() if coords_np is not None else None,
        "fitted_joint_coords": fitted_coords.astype(np.float32).tolist() if fitted_coords is not None else None,
        "render_frame": render_frame,
    }
