# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Forward-kinematics primitives for articulated skeletons."""

from typing import List

import einops
import torch
import torch.nn.functional as F

from ..tools import ensure_batched


@ensure_batched(local_joint_rots=4, root_positions=2)
def fk(
    local_joint_rots: torch.Tensor,
    root_positions: torch.Tensor,
    skeleton,
    root_positions_is_global: bool = True,
):
    """Compute global joint rotations and positions from local rotations.

    Args:
        local_joint_rots: Local rotation matrices with shape `(..., J, 3, 3)`.
        root_positions: Root translations with shape `(..., 3)`.
        skeleton: Skeleton object exposing `neutral_joints`, `joint_parents`, and
            `root_idx`.
        root_positions_is_global: If `True`, neutral joints are recentered so root
            translations are interpreted in world space.

    Returns:
        Tuple `(global_joint_rots, posed_joints, posed_joints_norootpos)`.
    """
    device = local_joint_rots.device
    dtype = local_joint_rots.dtype

    # If skeleton has baked rest (e.g. from XML), identity local = baked rest pose.
    # So training/inference local rotations are in reference to XML rest *orientations*.
    rest_local = getattr(skeleton, "rest_local_rots", None)
    if rest_local is not None:
        rest_local = rest_local.to(device=device, dtype=dtype)
        local_joint_rots = torch.einsum("jmn,...jno->...jmo", rest_local, local_joint_rots)

    # Rest positions for FK. Must be consistent with rest_local: when local = identity,
    # FK(rest_local, neutral_joints) should equal the XML rest pose positions. So
    # neutral_joints are not necessarily the raw XML joint positions; they are the
    # rest layout that, when rotated by rest_local, yields the XML rest positions.
    neutral_joints = skeleton.neutral_joints.to(device=device, dtype=dtype)

    if root_positions_is_global is True:
        # Removing the pelvis offset from the neutral joints
        # as the root positions does not depends on the pelvis offset of the skeleton
        pelvis_offset = neutral_joints[skeleton.root_idx]
        neutral_joints = neutral_joints - pelvis_offset

    # compute joint position and global rotations
    joints = einops.repeat(
        neutral_joints,
        "j k -> b j k",
        b=len(local_joint_rots),
    )
    posed_joints_norootpos, global_joint_rots = batch_rigid_transform(
        local_joint_rots,
        joints,
        skeleton.joint_parents,
        skeleton.root_idx,
    )
    # if root_positions_is_global is True:
    # posed_joints_norootpos always start at zero
    # otherwise it could start with the pelvis offset

    posed_joints = posed_joints_norootpos + root_positions[:, None]
    return global_joint_rots, posed_joints, posed_joints_norootpos


def compute_idx_levels(parents):
    """Group joint indices by hierarchy depth for level-wise FK updates.

    Args:
        parents: Parent index tensor of shape `(J,)` with root parent `-1`.

    Returns:
        List of index tensors, where each tensor contains joints at one depth.
    """
    idx_levs = [[]]
    lev_dicts = {0: -1}
    for i in range(1, parents.shape[0]):
        assert int(parents[i]) in lev_dicts
        lev = lev_dicts[int(parents[i])] + 1
        if lev + 1 > len(idx_levs):
            idx_levs.append([])
        idx_levs[lev].append(int(i))
        lev_dicts[int(i)] = lev
    idx_levs = [torch.tensor(x).long() for x in idx_levs]
    return idx_levs


def batch_rigid_transform(rot_mats, joints, parents, root_idx):
    """Perform batch rigid transformation on a skeletal structure.

    Args:
        rot_mats: Local rotation matrices for each joint: (B, J, 3, 3)
        joints: Initial joint positions: (B, J, 3)
        parents: Tensor indicating the parent of each joint: (J,)
        root_idx (int): index of the root

    Returns:
        Transformed joint positions after applying forward kinematics.
    """

    # Compute the hierarchical levels of joints based on their parent relationships
    idx_levs = compute_idx_levels(parents)

    # Apply forward kinematics to transform the joints
    return forward_kinematics(rot_mats, joints, parents, idx_levs, root_idx)


@torch.jit.script
def transform_mat(R, t):
    """Creates a batch of transformation matrices.

    Args:
        - R: Bx3x3 array of a batch of rotation matrices
        - t: Bx3x1 array of a batch of translation vectors
    Returns:
        - T: Bx4x4 Transformation matrix
    """
    # No padding left or right, only add an extra row
    return torch.cat([F.pad(R, [0, 0, 0, 1]), F.pad(t, [0, 0, 0, 1], value=1.0)], dim=2)


@torch.jit.script
def forward_kinematics(
    rot_mats,
    joints,
    parents: torch.Tensor,
    idx_levs: List[torch.Tensor],
    root_idx: int,
):
    """Perform forward kinematics to compute posed joints and global rotation matrices.

    Args:
        rot_mats: Local rotation matrices for each joint: (B, J, 3, 3)
        joints: Initial joint positions: (B, J, 3)
        parents: Tensor indicating the parent of each joint: (J,)
        idx_levs: Tensors of joint indices grouped by depth in the kinematic tree.
        root_idx (int): index of the root
    Returns:
        Posed joints: (B, J, 3)
        Global rotation matrices: (B, J, 3, 3)
    """

    # Add an extra dimension to joints
    joints = torch.unsqueeze(joints, dim=-1)

    # Compute relative joint positions
    rel_joints = joints.clone()

    mask_no_root = torch.ones(joints.shape[1], dtype=torch.bool)
    mask_no_root[root_idx] = False
    rel_joints[:, mask_no_root] -= joints[:, parents[mask_no_root]].clone()

    # Compute initial transformation matrices
    # (B, J + 1, 4, 4)
    transforms_mat = transform_mat(rot_mats.reshape(-1, 3, 3), rel_joints.reshape(-1, 3, 1)).reshape(
        -1, joints.shape[1], 4, 4
    )

    # Initialize the root transformation matrices
    transforms = torch.zeros_like(transforms_mat)
    transforms[:, root_idx] = transforms_mat[:, root_idx]

    # Compute global transformations level by level
    for indices in idx_levs:
        curr_res = torch.matmul(transforms[:, parents[indices]], transforms_mat[:, indices])
        transforms[:, indices] = curr_res

    # Extract posed joint positions from the transformation matrices
    posed_joints = transforms[:, :, :3, 3]

    # Extract global rotation matrices from the transformation matrices
    global_rot_mat = transforms[:, :, :3, :3]

    return posed_joints, global_rot_mat
