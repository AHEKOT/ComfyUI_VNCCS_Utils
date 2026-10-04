# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Rotation-space conversion utilities for skeleton motion data."""

import einops
import torch

from ..tools import ensure_batched
from .kinematics import batch_rigid_transform


def global_rots_to_local_rots(global_joint_rots: torch.Tensor, skeleton):
    """Convert global rotations to local rotations using a skeleton hierarchy.

    Args:
        global_joint_rots: Global rotation matrices with shape `(..., J, 3, 3)`.
        skeleton: Skeleton object exposing `joint_parents` and `root_idx`.

    Returns:
        Local rotation matrices with the same leading shape as the input.
    """
    # Doing big batch
    global_joint_mats, ps = einops.pack(
        [global_joint_rots],
        "* nbjoints dim1 dim2",
    )

    # obtain back the local rotations from the new global rotations
    parent_rot_mats = global_joint_mats[:, skeleton.joint_parents]

    parent_rot_mats[:, skeleton.root_idx] = torch.eye(3)  # the root joint
    parent_rot_mats_inv = parent_rot_mats.transpose(2, 3)
    local_rot_mats = torch.einsum(
        "T N m n, T N n o -> T N m o",
        parent_rot_mats_inv,
        global_joint_mats,
    )
    [local_rot_mats] = einops.unpack(local_rot_mats, ps, "* nbjoints dim1 dim2")
    return local_rot_mats


@ensure_batched(local_rot_mats=4)
def change_tpose(local_rot_mats: torch.Tensor, global_rot_offsets: torch.Tensor, skeleton):
    """Re-express local rotations in another t_pose based on the global rotation offsets.

    Args:
        local_rot_mats: Local rotation matrices with shape `(..., J, 3, 3)`.
        global_rot_offsets: Global rotation offsets with shape `(..., J, 3, 3)`.
        skeleton: Skeleton object exposing `joint_parents`,
            `root_idx`, and `nbjoints`.

    Returns:
        Tuple `(new_local_rot_mats, new_global_rot_mats)` in the standard frame.
    """

    device, dtype = local_rot_mats.device, local_rot_mats.dtype
    global_rot_offsets = global_rot_offsets.to(device=device, dtype=dtype)

    root_idx = skeleton.root_idx
    joint_parents = skeleton.joint_parents
    # These are dummy joint positions, will not be used
    neutral_joints = torch.ones((len(local_rot_mats), skeleton.nbjoints, 3), device=device, dtype=dtype)

    # get the old joint rotations in the same global space as the t-pose
    #   Note: the neutral joints we use here doesn't matter, because we are only using the global rotation outputs
    _, global_rot_mats = batch_rigid_transform(local_rot_mats, neutral_joints, joint_parents, root_idx)  # (T, N, 3, 3)

    # compute the desired joint rotations in the frame of the new t-pose
    new_global_rot_mats = torch.einsum("T N m n, N o n -> T N m o", global_rot_mats, global_rot_offsets)
    # convert back to local rotations
    new_local_rot_mats = global_rots_to_local_rots(new_global_rot_mats, skeleton)
    return new_local_rot_mats, new_global_rot_mats


@ensure_batched(local_rot_mats=4)
def to_standard_tpose(local_rot_mats: torch.Tensor, skeleton):
    """Re-express local rotations in the skeleton's standard T-pose convention.

    Args:
        local_rot_mats: Local rotation matrices with shape `(..., J, 3, 3)`.
        skeleton: Skeleton object exposing `global_rot_offsets`, `joint_parents`,
            `root_idx`, and `nbjoints`.

    Returns:
        Tuple `(new_local_rot_mats, new_global_rot_mats)` in the standard frame.
    """
    global_rot_offsets = skeleton.global_rot_offsets
    return change_tpose(local_rot_mats, global_rot_offsets, skeleton)


@ensure_batched(local_rot_mats=4)
def from_standard_tpose(local_rot_mats: torch.Tensor, skeleton):
    """Re-express local rotations from the skeleton's standard T-pose convention to the original
    formulation.

    Args:
        local_rot_mats: Local rotation matrices with shape `(..., J, 3, 3)`.
        skeleton: Skeleton object exposing `global_rot_offsets`, `joint_parents`,
            `root_idx`, and `nbjoints`.

    Returns:
        Tuple `(new_local_rot_mats, new_global_rot_mats)` in the standard frame.
    """
    global_rot_offsets = skeleton.global_rot_offsets
    global_rot_offsets_T = global_rot_offsets.mT  # do the inverse transform
    return change_tpose(local_rot_mats, global_rot_offsets_T, skeleton)
