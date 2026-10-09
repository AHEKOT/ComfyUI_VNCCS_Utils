# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import torch


def foot_detect_from_pos_and_vel(
    positions: torch.Tensor,
    velocity: torch.Tensor,
    skeleton,
    vel_thres: float,
    height_thresh: float,
) -> torch.Tensor:
    """Compute foot contact labels using heuristics combining joint height and velocities.

    Args:
        positions (torch.Tensor): [X, T, J, 3] global joint positions
        velocity (torch.Tensor): [X, T, J, 3] velocities (already padded correctly), already multiplied by 1 / dt
        skeleton: skeleton providing left/right foot joint indices
        vel_thres (float): threshold for joint velocity
        height_thresh (float): threshold for joint height

    Returns:
        torch.Tensor: [X, T, 4] contact labels (left heel, left toe, right heel,
        right toe), 1 for foot plant
    """
    device = positions.device
    fid_l = skeleton.left_foot_joint_idx
    fid_r = skeleton.right_foot_joint_idx

    velfactor, heightfactor = (
        torch.tensor([vel_thres, vel_thres], device=device),
        torch.tensor([height_thresh, height_thresh], device=device),
    )

    feet_l_v = torch.linalg.norm(velocity[:, :, fid_l], axis=-1)
    feet_l_h = positions[:, :, fid_l, 1]

    feet_l = torch.logical_and(
        feet_l_v < velfactor,
        feet_l_h < heightfactor,
    ).to(positions.dtype)

    feet_r_v = torch.linalg.norm(velocity[:, :, fid_r], axis=-1)
    feet_r_h = positions[:, :, fid_r, 1]

    feet_r = torch.logical_and(
        feet_r_v < velfactor,
        feet_r_h < heightfactor,
    ).to(positions.dtype)

    foot_contacts = torch.cat((feet_l, feet_r), axis=-1)
    return foot_contacts
