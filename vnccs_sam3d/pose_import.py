"""Pose Studio image-to-SAM3D JSON bridge.

The original integration called the external SAM3DBody custom node through
ComfyUI's global node registry. This internal bridge keeps the same output
shape while loading the vendored inference code directly.
"""

from __future__ import annotations

import json

import numpy as np


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
            apply_pose_lean_correction_rig,
        )
    except Exception as exc:
        raise _dependency_error(exc) from exc

    model = LoadSAM3DBodyModel().load_model("Auto")[0]
    pose_json = SAM3DBodyProcessToJson().process_to_json(
        model=model,
        image=image_tensor,
        bbox_threshold=0.8,
        inference_type="full",
    )[0]

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

        try:
            if posed_rots is not None and posed_coords is not None:
                _get_mhr_rest_verts(mhr_head, device)
                parents = _FACE_BS_CACHE.get("joint_parents")
                if parents is not None:
                    corrected_rots, corrected_coords = apply_pose_lean_correction_rig(
                        np.asarray(posed_rots, dtype=np.float32),
                        np.asarray(posed_coords, dtype=np.float32),
                        np.asarray(parents, dtype=np.int32),
                        0.5,
                    )
                    pose_data["joint_rotations"] = corrected_rots.tolist()
                    pose_data["joint_coords"] = corrected_coords.tolist()
                    pose_data["sam3d_pose_postprocess"] = "apply_pose_lean_correction_rig:0.5"
        except Exception as exc:
            print(f"[VNCCS] SAM3D lean-corrected rig export failed: {exc}")

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
        return json.dumps(pose_data, ensure_ascii=False, indent=2)
    except Exception as exc:
        print(f"[VNCCS] SAM3D rest skeleton export failed: {exc}")
        return pose_json
