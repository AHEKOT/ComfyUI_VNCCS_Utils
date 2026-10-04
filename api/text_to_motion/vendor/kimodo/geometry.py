# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Rotation and representation conversions: axis-angle, quaternion, matrix, 6D continuous."""

import torch
import torch.nn.functional as F


def angle_to_Y_rotation_matrix(angle: torch.Tensor) -> torch.Tensor:
    """Build a rotation matrix around the Y axis from a scalar angle (radians).

    Shape: angle.shape + (3, 3).
    """
    cos, sin = torch.cos(angle), torch.sin(angle)
    one, zero = torch.ones_like(angle), torch.zeros_like(angle)
    mat = torch.stack((cos, zero, sin, zero, one, zero, -sin, zero, cos), -1)
    mat = mat.reshape(angle.shape + (3, 3))
    return mat


def matrix_to_cont6d(matrix: torch.Tensor) -> torch.Tensor:
    """Convert rotation matrix to 6D continuous representation (first two columns).

    Shape: (..., 3, 3) -> (..., 6).
    """
    cont_6d = torch.concat([matrix[..., 0], matrix[..., 1]], dim=-1)
    return cont_6d


def cont6d_to_matrix(cont6d: torch.Tensor) -> torch.Tensor:
    """Convert 6D continuous representation to rotation matrix (Gram–Schmidt on two columns).

    Last dim must be 6.
    """
    assert cont6d.shape[-1] == 6, "The last dimension must be 6"
    x_raw = cont6d[..., 0:3]
    y_raw = cont6d[..., 3:6]

    x = x_raw / torch.norm(x_raw, dim=-1, keepdim=True)
    z = torch.cross(x, y_raw, dim=-1)
    z = z / torch.norm(z, dim=-1, keepdim=True)

    y = torch.cross(z, x, dim=-1)

    x = x[..., None]
    y = y[..., None]
    z = z[..., None]

    mat = torch.cat([x, y, z], dim=-1)
    return mat


def axis_angle_to_matrix(axis_angle: torch.Tensor) -> torch.Tensor:
    """Convert axis-angle to rotation matrix.

    Args:
        axis_angle: (..., 3) axis-angle vectors (angle = norm, axis = normalized)
    Returns:
        rotmat: (..., 3, 3) rotation matrices
    """
    eps = 1e-6
    angle = torch.norm(axis_angle, dim=-1, keepdim=True)  # (..., 1)
    axis = axis_angle / (angle + eps)

    x, y, z = axis.unbind(-1)

    zero = torch.zeros_like(x)
    K = torch.stack([zero, -z, y, z, zero, -x, -y, x, zero], dim=-1).reshape(*axis.shape[:-1], 3, 3)

    eye = torch.eye(3, device=axis.device, dtype=axis.dtype)
    eye = eye.expand(*axis.shape[:-1], 3, 3)

    sin = torch.sin(angle)[..., None]
    cos = torch.cos(angle)[..., None]

    R = eye + sin * K + (1 - cos) * (K @ K)
    return R


def matrix_to_axis_angle(R: torch.Tensor) -> torch.Tensor:
    """Convert rotation matrix to axis-angle via quaternions (more numerically stable).

    Args:
        R: (..., 3, 3) rotation matrices
    Returns:
        axis_angle: (..., 3)
    """
    # Go through quaternions for numerical stability
    quat = matrix_to_quaternion(R)  # (..., 4) with (w, x, y, z)
    return quaternion_to_axis_angle(quat)


def quaternion_to_axis_angle(quat: torch.Tensor) -> torch.Tensor:
    """Convert quaternion to axis-angle representation.

    Args:
        quat: (..., 4) quaternions with real part first (w, x, y, z)
    Returns:
        axis_angle: (..., 3)
    """
    eps = 1e-6

    # Ensure canonical form to avoid sign ambiguity.
    # Primary: prefer w > 0. When w ≈ 0 (angle ≈ π), prefer first nonzero xyz > 0.
    w = quat[..., 0:1]
    xyz = quat[..., 1:]

    # Find first significant component of xyz for tie-breaking when w ≈ 0
    first_significant = xyz[..., 0:1]  # use x component as tie-breaker

    # Flip if: w < 0, OR (w ≈ 0 AND first xyz component < 0)
    should_flip = (w < -eps) | ((w.abs() <= eps) & (first_significant < 0))
    quat = torch.where(should_flip, -quat, quat)

    w = quat[..., 0]
    xyz = quat[..., 1:]

    # sin(angle/2) = ||xyz||
    sin_half_angle = xyz.norm(dim=-1)

    # angle = 2 * atan2(sin(angle/2), cos(angle/2))
    # This is more stable than 2 * acos(w) near angle=0
    angle = 2.0 * torch.atan2(sin_half_angle, w)

    # axis = xyz / sin(angle/2), but handle small angles
    # For small angles: axis-angle ≈ 2 * xyz (since sin(x) ≈ x for small x)
    small_angle = sin_half_angle.abs() < eps

    # Safe division
    scale = torch.where(
        small_angle,
        2.0 * torch.ones_like(angle),  # small angle: axis_angle ≈ 2 * xyz
        angle / sin_half_angle.clamp(min=eps),
    )

    return xyz * scale.unsqueeze(-1)


def _sqrt_positive_part(x: torch.Tensor) -> torch.Tensor:
    """Returns torch.sqrt(torch.max(0, x)) subgradient is zero where x is 0."""
    return torch.sqrt(x * (x > 0).to(x.dtype))


def matrix_to_quaternion(matrix: torch.Tensor) -> torch.Tensor:
    """Convert rotations given as rotation matrices to quaternions.

    Args:
        matrix: Rotation matrices as tensor of shape (..., 3, 3).
    Returns:
        quaternions with real part first, as tensor of shape (..., 4).
    """
    if matrix.size(-1) != 3 or matrix.size(-2) != 3:
        raise ValueError(f"Invalid rotation matrix shape {matrix.shape}.")

    batch_dim = matrix.shape[:-2]
    m00, m01, m02, m10, m11, m12, m20, m21, m22 = torch.unbind(matrix.reshape(batch_dim + (9,)), dim=-1)

    q_abs = _sqrt_positive_part(
        torch.stack(
            [
                1.0 + m00 + m11 + m22,
                1.0 + m00 - m11 - m22,
                1.0 - m00 + m11 - m22,
                1.0 - m00 - m11 + m22,
            ],
            dim=-1,
        )
    )

    quat_by_rijk = torch.stack(
        [
            torch.stack([q_abs[..., 0] ** 2, m21 - m12, m02 - m20, m10 - m01], dim=-1),
            torch.stack([m21 - m12, q_abs[..., 1] ** 2, m10 + m01, m02 + m20], dim=-1),
            torch.stack([m02 - m20, m10 + m01, q_abs[..., 2] ** 2, m12 + m21], dim=-1),
            torch.stack([m10 - m01, m20 + m02, m21 + m12, q_abs[..., 3] ** 2], dim=-1),
        ],
        dim=-2,
    )

    flr = torch.tensor(0.1).to(dtype=q_abs.dtype, device=q_abs.device)
    quat_candidates = quat_by_rijk / (2.0 * q_abs[..., None].max(flr))

    return (
        (F.one_hot(q_abs.argmax(dim=-1), num_classes=4)[..., None] * quat_candidates)
        .sum(dim=-2)
        .reshape(batch_dim + (4,))
    )


def quaternion_to_matrix(quaternions: torch.Tensor) -> torch.Tensor:
    """Convert rotations given as quaternions to rotation matrices.

    Args:
        quaternions: quaternions with real part first,
            as tensor of shape (..., 4).
    Returns:
        Rotation matrices as tensor of shape (..., 3, 3).
    """
    r, i, j, k = torch.unbind(quaternions, -1)
    two_s = 2.0 / (quaternions * quaternions).sum(-1)

    o = torch.stack(
        (
            1 - two_s * (j * j + k * k),
            two_s * (i * j - k * r),
            two_s * (i * k + j * r),
            two_s * (i * j + k * r),
            1 - two_s * (i * i + k * k),
            two_s * (j * k - i * r),
            two_s * (i * k - j * r),
            two_s * (j * k + i * r),
            1 - two_s * (i * i + j * j),
        ),
        -1,
    )
    return o.reshape(quaternions.shape[:-1] + (3, 3))
