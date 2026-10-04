# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Post-processing utilities for motion generation output."""

from types import SimpleNamespace
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch

from .constraints import (
    EndEffectorConstraintSet,
    FullBodyConstraintSet,
    Root2DConstraintSet,
)
from .geometry import matrix_to_quaternion, quaternion_to_matrix
from .skeleton import (
    G1Skeleton34,
    SkeletonBase,
    SMPLXSkeleton22,
    SOMASkeleton30,
    SOMASkeleton77,
    fk,
)


def extract_input_motion_from_constraints(
    constraint_lst: List,
    skeleton: SkeletonBase,
    num_frames: int,
    num_joints: int,
) -> Tuple[torch.Tensor, torch.Tensor]:
    """Extract hip translations and local rotations from constraints for postprocessing.

    Args:
        constraint_lst: List of constraints (FullBodyConstraintSet, EndEffectorConstraintSet, etc.)
        skeleton: Skeleton instance
        num_frames: Total number of frames in the motion
        num_joints: Number of joints

    Returns:
        Tuple of (hip_translations_input, rotations_input):
            - hip_translations_input: Hip translations, shape (T, 3)
            - rotations_input: Local joint rotations as quaternions, shape (T, J, 4)
    """
    # Initialize with zeros for all frames
    hip_translations_input = torch.zeros(num_frames, 3)
    rotations_input = torch.zeros(num_frames, num_joints, 4)
    rotations_input[..., 0] = 1.0  # Initialize as identity quaternions (w=1, x=y=z=0)

    def _match_hip_dtype(tensor: torch.Tensor) -> torch.Tensor:
        return tensor.to(device=hip_translations_input.device, dtype=hip_translations_input.dtype)

    def _match_rot_dtype(tensor: torch.Tensor) -> torch.Tensor:
        return tensor.to(device=rotations_input.device, dtype=rotations_input.dtype)

    if not constraint_lst:
        return hip_translations_input, rotations_input

    # Sort constraints to ensure FullBodyConstraintSet is processed last
    #   This ensures it will get the last say on whether hip translations need to be exact root or smoothed root
    sorted_constraints = sorted(constraint_lst, key=lambda c: isinstance(c, FullBodyConstraintSet))
    for constraint in sorted_constraints:
        frame_indices = constraint.frame_indices
        if isinstance(frame_indices, torch.Tensor):
            valid_mask = frame_indices < num_frames
            if valid_mask.sum() == 0:
                continue
            frame_indices = frame_indices[valid_mask]
        else:
            valid_positions = [i for i, idx in enumerate(frame_indices) if idx < num_frames]
            if not valid_positions:
                continue
            frame_indices = [frame_indices[i] for i in valid_positions]

        # Handle Root2DConstraintSet separately - only assign smooth_root_2d at xz dimensions
        if isinstance(constraint, Root2DConstraintSet):
            smooth_root_2d = constraint.smooth_root_2d  # (K, 2) where K = len(frame_indices)
            if isinstance(frame_indices, torch.Tensor):
                smooth_root_2d = smooth_root_2d[valid_mask]
            else:
                smooth_root_2d = smooth_root_2d[valid_positions]
            smooth_root_2d = _match_hip_dtype(smooth_root_2d)
            hip_translations_input[frame_indices, 0] = smooth_root_2d[:, 0]  # x
            hip_translations_input[frame_indices, 2] = smooth_root_2d[:, 1]  # z
            continue
        elif isinstance(constraint, FullBodyConstraintSet) or isinstance(constraint, EndEffectorConstraintSet):
            global_rots = constraint.global_joints_rots  # (K, J, 3, 3) where K = len(frame_indices)
            global_positions = constraint.global_joints_positions  # (K, J, 3)
            if isinstance(frame_indices, torch.Tensor):
                global_rots = global_rots[valid_mask]
                global_positions = global_positions[valid_mask]
                smooth_root_2d = constraint.smooth_root_2d[valid_mask]
            else:
                global_rots = global_rots[valid_positions]
                global_positions = global_positions[valid_positions]
                smooth_root_2d = constraint.smooth_root_2d[valid_positions]

            root_positions = global_positions[:, skeleton.root_idx]  # (K, 3)
            # replace xz with smooth_root_2d values for EE constraints that do not include Hips
            #    since the hips themselves are not actually constrained in the model conditioning
            if isinstance(constraint, EndEffectorConstraintSet) and "Hips" not in constraint.joint_names:
                root_positions[:, 0] = smooth_root_2d[:, 0]  # x
                root_positions[:, 2] = smooth_root_2d[:, 1]  # z

            local_rot_mats = skeleton.global_rots_to_local_rots(global_rots)  # (K, J, 3, 3)
            local_rot_quats = matrix_to_quaternion(local_rot_mats)  # (K, J, 4)

            hip_translations_input[frame_indices] = _match_hip_dtype(root_positions)
            rotations_input[frame_indices] = _match_rot_dtype(local_rot_quats)
        else:
            NotImplementedError(f"Constraint {constraint.name} is not supported")

    return hip_translations_input, rotations_input


def create_working_rig_from_skeleton(
    skeleton: SkeletonBase, above_ground_offset: float = 0.007
) -> List[SimpleNamespace]:
    """Create the working rig as a list of SimpleNamespace objects from skeleton.

    Args:
        skeleton: SkeletonBase instance with bone_order_names, neutral_joints, joint_parents
        above_ground_offset: Additional offset to position the rig slightly above ground
    Returns:
        List of SimpleNamespace objects representing the working rig
    """
    working_rig_joints = []

    joint_names = skeleton.bone_order_names
    neutral_positions = skeleton.neutral_joints.cpu().numpy()
    parent_indices = skeleton.joint_parents.cpu().numpy()

    if isinstance(skeleton, (G1Skeleton34, SMPLXSkeleton22)):
        retarget_map = {
            skeleton.bone_order_names[skeleton.root_idx]: "Hips",
            skeleton.left_hand_joint_names[0]: "LeftHand",
            skeleton.right_hand_joint_names[0]: "RightHand",
            skeleton.left_foot_joint_names[0]: "LeftFoot",
            skeleton.right_foot_joint_names[0]: "RightFoot",
        }
    else:
        # works for SOMA
        retarget_map = {
            "Hips": "Hips",
            "Head": "Head",
            "LeftHand": "LeftHand",
            "RightHand": "RightHand",
            "LeftFoot": "LeftFoot",
            "RightFoot": "RightFoot",
        }

    for i, joint_name in enumerate(joint_names):
        parent_name = None if parent_indices[i] == -1 else joint_names[parent_indices[i]]

        # Calculate local translation relative to parent
        if parent_indices[i] == -1:
            # Move the rig so that the lowest point (toe) is at ground level (y=0),
            # plus a small offset to position the rig slightly above ground
            toe_height = neutral_positions[:, 1].min()  # lowest y-coordinate (toe)
            local_translation = (
                neutral_positions[i] + np.array([0.0, -toe_height + above_ground_offset, 0.0])
            ).tolist()
        else:
            parent_idx = parent_indices[i]
            parent_position = neutral_positions[parent_idx]
            joint_position = neutral_positions[i]
            local_translation = (joint_position - parent_position).tolist()

        # Default rotation (identity quaternion: x=0, y=0, z=0, w=1)
        default_rotation = [0.0, 0.0, 0.0, 1.0]

        joint_info = SimpleNamespace(
            name=joint_name,
            parent=parent_name,
            t_pose_rotation=default_rotation,
            t_pose_translation=local_translation,
            retarget_tag=retarget_map.get(joint_name),
        )

        working_rig_joints.append(joint_info)

    return working_rig_joints


def post_process_motion(
    local_rot_mats: torch.Tensor,
    root_positions: torch.Tensor,
    contacts: torch.Tensor,
    skeleton: SkeletonBase,
    constraint_lst: Optional[List] = None,
    contact_threshold: float = 0.5,
    root_margin: float = 0.04,
) -> Dict[str, torch.Tensor]:
    """Post-process generated motion to reduce foot skating and improve quality.

    Args:
        local_rot_mats: Local joint rotation matrices, shape (B, T, J, 3, 3)
        root_positions: Root joint positions, shape (B, T, 3)
        contacts: Foot contact labels, shape (B, T, num_contacts)
        skeleton: Skeleton instance
        constraint_lst: Optional list of constraints (or list of lists of constraints for batched inference)(FullBodyConstraintSet, etc.)
        contact_threshold: Threshold for foot contact detection
        root_margin: Margin for root position correction

    Returns:
        Dictionary with corrected motion data:
            - local_rot_mats: Corrected local rotation matrices (B, T, J, 3, 3)
            - root_positions: Corrected root positions (B, T, 3)
            - posed_joints: Corrected global joint positions (B, T, J, 3)
            - global_rot_mats: Corrected global rotation matrices (B, T, J, 3, 3)
    """
    # Ensure batch dimension
    assert local_rot_mats.dim() == 5, "local_rot_mats should be 5D, make sure to include the batch dimension"

    batch_size, num_frames, num_joints = local_rot_mats.shape[:3]

    def _build_constraint_masks_dict(constraints: List) -> Dict[str, torch.Tensor]:
        out = {
            key: torch.zeros(num_frames, dtype=torch.float32)
            for key in [
                "FullBody",
                "LeftFoot",
                "RightFoot",
                "LeftHand",
                "RightHand",
                "Root",
            ]
        }
        for constraint in constraints:
            frame_indices = constraint.frame_indices
            if isinstance(frame_indices, torch.Tensor):
                frame_indices = frame_indices[frame_indices < num_frames]
                if frame_indices.numel() == 0:
                    continue
            else:
                frame_indices = [idx for idx in frame_indices if idx < num_frames]
                if not frame_indices:
                    continue
            if constraint.name == "fullbody":
                out["FullBody"][frame_indices] = 1.0
            elif constraint.name == "left-foot":
                out["LeftFoot"][frame_indices] = 1.0
            elif constraint.name == "right-foot":
                out["RightFoot"][frame_indices] = 1.0
            elif constraint.name == "left-hand":
                out["LeftHand"][frame_indices] = 1.0
            elif constraint.name == "right-hand":
                out["RightHand"][frame_indices] = 1.0
            elif constraint.name == "root2d":
                out["Root"][frame_indices] = 1.0
        return out

    # Create constraint masks from constraint_lst (one dict per batch item when batched)
    batched_constraints = bool(constraint_lst) and isinstance(constraint_lst[0], list)
    if batched_constraints:
        constraint_masks_dict_lst = [_build_constraint_masks_dict(constraint_lst[b]) for b in range(batch_size)]
    else:
        constraint_masks_dict = (
            _build_constraint_masks_dict(constraint_lst)
            if constraint_lst
            else {
                key: torch.zeros(num_frames, dtype=torch.float32)
                for key in [
                    "FullBody",
                    "LeftFoot",
                    "RightFoot",
                    "LeftHand",
                    "RightHand",
                    "Root",
                ]
            }
        )

    # Create working rig
    above_ground_offset = 0.02 if isinstance(skeleton, (SOMASkeleton30, SOMASkeleton77)) else 0.007
    # larger offset for SOMA since model tends to generate lower to the ground
    working_rig = create_working_rig_from_skeleton(skeleton, above_ground_offset=above_ground_offset)
    has_double_ankle_joints = isinstance(skeleton, G1Skeleton34)

    # Prepare input tensors. The generated motion will be modified in place. Clone first.
    neutral_joints_pelvis_offset = skeleton.neutral_joints[0].cpu().clone()
    hip_translations_corrected = root_positions.cpu().clone()
    rotations_corrected = matrix_to_quaternion(local_rot_mats).cpu().clone()  # (B, T, J, 4)
    contacts = contacts.cpu()

    # Extract input motion (target keyframes) from constraints for each batch
    # For constrained keyframes, use the original motion from constraints
    # For non-constrained frames, zeros are used
    hip_translations_input = torch.zeros(batch_size, num_frames, 3)
    rotations_input = torch.zeros(batch_size, num_frames, num_joints, 4)
    rotations_input[..., 0] = 1.0  # Initialize as identity quaternions (w=1, x=y=z=0)

    if constraint_lst:
        for b in range(batch_size):
            # Get constraints for this batch item (if batched) or use the same list
            constraints_lst_el = (
                constraint_lst[b]
                if isinstance(
                    constraint_lst[0], list
                )  # when the constraint_list is in batch format, each item in a list is a constraintlist for one sample
                else constraint_lst  # single constraint list shared for all samples in the batch
            )
            hip_translations_input[b], rotations_input[b] = extract_input_motion_from_constraints(
                constraints_lst_el,
                skeleton,
                num_frames,
                num_joints,
            )

    # Call the motion correction for each batch (optional package)
    try:
        from motion_correction import motion_postprocess
    except ImportError as e:
        raise RuntimeError(
            "Motion correction is required for this postprocessing path but the "
            "motion_correction package is not installed. Install with: pip install -e ."
        ) from e
    for b in range(batch_size):
        masks_b = constraint_masks_dict_lst[b] if batched_constraints else constraint_masks_dict
        motion_postprocess.correct_motion(
            hip_translations_corrected[b : b + 1],
            rotations_corrected[b : b + 1],
            contacts[b : b + 1],
            hip_translations_input[b : b + 1],
            rotations_input[b : b + 1],
            masks_b,
            contact_threshold,
            root_margin,
            working_rig,
            has_double_ankle_joints,
        )

    local_rot_mats_corrected = quaternion_to_matrix(rotations_corrected)

    # Compute posed joints using FK
    device = local_rot_mats.device
    global_rot_mats, posed_joints, _ = fk(
        local_rot_mats_corrected.to(device),
        hip_translations_corrected.to(device),
        skeleton,
    )

    result = {
        "local_rot_mats": local_rot_mats_corrected.to(device),
        "root_positions": hip_translations_corrected.to(device),
        "posed_joints": posed_joints,
        "global_rot_mats": global_rot_mats,
    }

    return result
