# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional, Union

import einops
import torch

from ..geometry import cont6d_to_matrix, matrix_to_cont6d
from ..tools import ensure_batched


def diff_angles(angles, fps: float):
    """Computes differences between angles.

    Args:
        angles (Tensor): [..., T] the batched sequences of rotation angles in radians.

    Returns:
        Tensor: [..., T-1] the difference between consecutive angles
    """
    cos = torch.cos(angles)
    sin = torch.sin(angles)

    cos_diff = cos[..., 1:] * cos[..., :-1] + sin[..., 1:] * sin[..., :-1]
    sin_diff = sin[..., 1:] * cos[..., :-1] - cos[..., 1:] * sin[..., :-1]

    # should be close to angles.diff() but more robust
    # multiply by fps = 1 / dt
    angles_diff = fps * torch.arctan2(sin_diff, cos_diff)
    return angles_diff


@ensure_batched(positions=4, lengths=1)
def compute_vel_xyz(
    positions: torch.Tensor,
    fps: float,
    lengths: Optional[torch.Tensor] = None,
):
    """Compute the velocities from positions: dx/dt.

    Works with batches. The last velocity is duplicated to keep the same size.
        Args:
            positions (torch.Tensor): [..., T, J, 3] xyz positions of a human skeleton
            fps (float): frame per seconds
            lengths (Optional[torch.Tensor]): [...] size of each input batched. If not provided, positions should not be batched

        Returns:
            velocity (torch.Tensor): [..., T, J, 3] velocities computed from the positions
    """
    device = positions.device

    if lengths is None:
        assert positions.shape[0] == 1, "If lenghts is not provided, the input should not be batched."
        lengths = torch.tensor([len(positions)], device=device)

    # compute velocities with fps
    velocity = fps * (positions[:, 1:] - positions[:, :-1])
    # pading the velocity vector
    vel_pad = torch.zeros_like(velocity[:, 0])
    velocity, _ = einops.pack([velocity, vel_pad], "batch * nbjoints dim")

    # repeat the last velocities
    # with special care for different lengths with batches
    # Use gather/scatter instead of in-place advanced indexing (TRT-compatible)
    nj, nd = velocity.shape[2], velocity.shape[3]
    # clamp: for length-1 sequences src would be -1 (invalid for gather);
    # index 0 is the zero pad, so the copy is a harmless no-op there
    src_idx = (lengths - 2).clamp(min=0).long().view(-1, 1, 1, 1).expand(-1, 1, nj, nd)
    dst_idx = (lengths - 1).long().view(-1, 1, 1, 1).expand(-1, 1, nj, nd)
    velocity = velocity.scatter(1, dst_idx, torch.gather(velocity, 1, src_idx))
    return velocity


@ensure_batched(root_rot_angles=2, lengths=1)
def compute_vel_angle(
    root_rot_angles: torch.Tensor,
    fps: float,
    lengths: Optional[torch.Tensor] = None,
):
    """Compute the local root rotation velocity: dtheta/dt.

    Args:
        root_rot_angles (torch.Tensor): [..., T] rotation angle (in radian)
        fps (float): frame per seconds
        lengths (Optional[torch.Tensor]): [...] size of each input batched. If not provided, root_rot_angles should not be batched

    Returns:
        local_root_rot_vel (torch.Tensor): [..., T] local root rotation velocity (in radian/s)
    """
    device = root_rot_angles.device
    if lengths is None:
        assert root_rot_angles.shape[0] == 1, "If lenghts is not provided, the input should not be batched."
        lengths = torch.tensor([len(root_rot_angles)], device=device)

    local_root_rot_vel = diff_angles(root_rot_angles, fps)
    pad_rot_vel_angles = torch.zeros_like(root_rot_angles[:, 0])
    local_root_rot_vel, _ = einops.pack(
        [local_root_rot_vel, pad_rot_vel_angles],
        "batch *",
    )
    # repeat the last rotation angle
    # with special care for different lengths with batches
    # Use gather/scatter instead of in-place advanced indexing (TRT-compatible)
    # clamp: for length-1 sequences src would be -1 (invalid for gather);
    # index 0 is the zero pad, so the copy is a harmless no-op there
    src_idx = (lengths - 2).clamp(min=0).unsqueeze(-1).long()  # [B, 1]
    dst_idx = (lengths - 1).unsqueeze(-1).long()  # [B, 1]
    local_root_rot_vel = local_root_rot_vel.scatter(1, dst_idx, torch.gather(local_root_rot_vel, 1, src_idx))
    return local_root_rot_vel


@ensure_batched(posed_joints=4)
def compute_heading_angle(posed_joints: torch.Tensor, skeleton):
    """Compute the heading direction from the joint positions, by looking at the hip vector.

    Args:
        posed_joints (torch.Tensor): [B, T, J, 3] global positions
        skeleton (SkeletonBase): skeleton of the human, used to find location of hips
    Returns:
        heading (torch.Tensor): [B] heading angle
    """
    # compute root heading for the sequence from hip positions
    r_hip, l_hip = skeleton.hip_joint_idx
    diff = posed_joints[:, :, r_hip] - posed_joints[:, :, l_hip]
    heading_angle = torch.atan2(diff[..., 2], -diff[..., 0])
    return heading_angle


def length_to_mask(
    length: Union[torch.Tensor, List],
    max_len: Optional[int] = None,
    device=None,
) -> torch.Tensor:
    if isinstance(length, list):
        if device is None:
            device = "cpu"
        length = torch.tensor(length, device=device)

    if device is not None:
        assert device == length.device
    device = length.device

    if max_len is None:
        max_len = max(length)

    mask = torch.arange(max_len, device=device).expand(len(length), max_len) < length.unsqueeze(1)
    return mask


class RotateFeatures:
    """Helper that applies a global heading rotation to motion features."""

    def __init__(self, angle: torch.Tensor):
        """Precompute 2D and 3D rotation matrices for a batch of angles.

        Args:
            angle: Rotation angle(s) in radians, shaped ``[B]``.
        """
        self.angle = angle

        cos, sin = torch.cos(angle), torch.sin(angle)
        one, zero = torch.ones_like(angle), torch.zeros_like(angle)

        # 2D rotation transposed (sin are -sin)
        self.corrective_mat_2d_T = torch.stack((cos, sin, -sin, cos), -1).reshape(angle.shape + (2, 2))
        # 3D rotation on Y axis
        self.corrective_mat_Y = torch.stack((cos, zero, sin, zero, one, zero, -sin, zero, cos), -1).reshape(
            angle.shape + (3, 3)
        )
        self.corrective_mat_Y_T = self.corrective_mat_Y.transpose(-2, -1).contiguous()

    def rotate_positions(self, positions: torch.Tensor):
        """Rotate 3D positions around the Y axis."""
        return positions @ self.corrective_mat_Y_T

    def rotate_2d_positions(self, positions_2d: torch.Tensor):
        """Rotate 2D ``(x, z)`` vectors in the ground plane."""
        return positions_2d @ self.corrective_mat_2d_T

    def rotate_rotations(self, rotations: torch.Tensor):
        """Left-multiply global rotation matrices by the heading correction."""
        # "Rotate" the global rotations
        # which means add an extra Y rotation after the transform
        # so at the left R' = R_y R
        # (since we use the convention x' = R x)
        # "bik,btdkj->btdij"
        B, T, J = rotations.shape[:3]
        BTJ = B * T * J
        return (
            self.corrective_mat_Y[:, None, None].expand(B, T, J, 3, 3).reshape(BTJ, 3, 3) @ rotations.reshape(BTJ, 3, 3)
        ).reshape(B, T, J, 3, 3)

    def rotate_6d_rotations(self, rotations_6d: torch.Tensor):
        """Rotate 6D rotation features via matrix conversion."""
        return matrix_to_cont6d(self.rotate_rotations(cont6d_to_matrix(rotations_6d)))
