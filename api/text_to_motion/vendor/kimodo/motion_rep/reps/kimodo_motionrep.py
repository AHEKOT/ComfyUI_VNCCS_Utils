# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

import einops
import torch
from torch import Tensor

from ...tools import to_numpy

from ...geometry import cont6d_to_matrix, matrix_to_cont6d
from ...skeleton.kinematics import fk
from ...skeleton.transforms import global_rots_to_local_rots
from ...tools import ensure_batched
from ..conditioning import get_unique_index_and_data
from ..feature_utils import RotateFeatures, compute_heading_angle, compute_vel_xyz
from ..feet import foot_detect_from_pos_and_vel
from ..smooth_root import get_smooth_root_pos
from .base import MotionRepBase


class KimodoMotionRep(MotionRepBase):
    """Global root / global joints rotations representation, relative to a smooth root."""

    def __init__(
        self,
        skeleton,
        fps,
        stats_path: Optional[str] = None,
    ):
        nbjoints = skeleton.nbjoints

        self.size_dict = {
            "smooth_root_pos": torch.Size([3]),
            "global_root_heading": torch.Size([2]),
            "local_joints_positions": torch.Size([nbjoints, 3]),
            "global_rot_data": torch.Size([nbjoints, 6]),
            "velocities": torch.Size([nbjoints, 3]),
            "foot_contacts": torch.Size([4]),
        }
        self.last_root_feature = "global_root_heading"
        self.local_root_size_dict = {
            "local_root_rot_vel": torch.Size([1]),
            "local_root_vel": torch.Size([2]),
            "global_root_y": torch.Size([1]),
        }
        super().__init__(skeleton, fps, stats_path)

    @ensure_batched(local_joint_rots=5, root_positions=3, lengths=1)
    def __call__(
        self,
        local_joint_rots: torch.Tensor,
        root_positions: torch.Tensor,
        to_normalize: bool,
        to_canonicalize: bool = False,
        lengths: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """Convert local rotations and root trajectory into smooth-root features.

        Args:
            local_joint_rots: Local joint rotation matrices ``[B, T, J, 3, 3]``.
            root_positions: Root positions ``[B, T, 3]``.
            to_normalize: Whether to normalize output features.
            to_canonicalize: Whether to canonicalize output features (False by default).
            lengths: Optional valid lengths for variable-length batches.

        Returns:
            Motion features with shape ``[B, T, motion_rep_dim]``.
        """
        device = local_joint_rots.device
        if lengths is None:
            assert local_joint_rots.shape[0] == 1, "If lenghts is not provided, the input should not be batched."
            lengths = torch.tensor([local_joint_rots.shape[1]], device=device)

        (
            global_joints_rots,
            global_joints_positions,
            local_joints_positions_origin_is_pelvis,
        ) = fk(local_joint_rots, root_positions, self.skeleton)

        root_heading_angle = compute_heading_angle(global_joints_positions, self.skeleton)
        global_root_heading = torch.stack([torch.cos(root_heading_angle), torch.sin(root_heading_angle)], dim=-1)

        smooth_root_pos = get_smooth_root_pos(root_positions)
        hips_offset = root_positions - smooth_root_pos
        hips_offset[..., 1] = root_positions[..., 1]
        local_joints_positions = local_joints_positions_origin_is_pelvis + hips_offset[:, :, None]

        velocities = compute_vel_xyz(global_joints_positions, self.fps, lengths=lengths)
        foot_contacts = foot_detect_from_pos_and_vel(global_joints_positions, velocities, self.skeleton, 0.15, 0.10)
        global_rot_data = matrix_to_cont6d(global_joints_rots)

        features, _ = einops.pack(
            [
                smooth_root_pos,
                global_root_heading,
                local_joints_positions,
                global_rot_data,
                velocities,
                foot_contacts,
            ],
            "batch time *",
        )

        if to_canonicalize:
            features = self.canonicalize(features, normalized=False)

        if to_normalize:
            features = self.normalize(features)
        return features

    @ensure_batched(features=3, angle=1)
    def rotate(self, features: torch.Tensor, angle: torch.Tensor):
        """Rotate root/joint positional and rotational features by heading."""
        # assume it is not normalized
        bs = features.shape[0]
        device = features.device
        [
            smooth_root_pos,
            global_root_heading,
            local_joints_positions,
            global_rot_data,
            velocities,
            foot_contacts,
        ] = einops.unpack(features, self.ps, "batch time *")

        if not isinstance(angle, torch.Tensor):
            angle = torch.tensor(angle, device=device)
        if len(angle.shape) == 0:
            angle = angle.repeat(bs)

        RF = RotateFeatures(angle)
        new_features, _ = einops.pack(
            [
                RF.rotate_positions(smooth_root_pos),
                RF.rotate_2d_positions(global_root_heading),
                RF.rotate_positions(local_joints_positions),
                RF.rotate_6d_rotations(global_rot_data),
                RF.rotate_positions(velocities),
                foot_contacts,
            ],
            "batch time *",
        )
        return new_features

    @ensure_batched(features=3, translation_2d=2)
    def translate_2d(
        self,
        features: torch.Tensor,
        translation_2d: torch.Tensor,
    ) -> torch.Tensor:
        """Translate smooth root planar position by ``(dx, dz)``."""
        # only move on the ground
        # If we need a translate_3D function, we should not forget to move the local_joints_positions as well
        bs = features.shape[0]
        if len(translation_2d.shape) == 1:
            translation_2d = translation_2d.repeat(bs, 1)

        new_features = features.clone()
        new_smooth_root_pos = new_features[:, :, self.slice_dict["smooth_root_pos"]]
        new_smooth_root_pos[:, :, 0] += translation_2d[:, [0]]
        new_smooth_root_pos[:, :, 2] += translation_2d[:, [1]]
        return new_features

    @ensure_batched(features=3)
    def inverse(
        self,
        features: torch.Tensor,
        is_normalized: bool,
        posed_joints_from="rotations",
        return_numpy: bool = False,
    ) -> torch.Tensor:
        """Decode smooth-root features into motion tensors."""
        assert posed_joints_from in [
            "rotations",
            "positions",
        ], "posed_joints_from should 'rotations' or 'positions'"

        if is_normalized:
            features = self.unnormalize(features)

        [
            smooth_root_pos,
            global_root_heading,
            local_joints_positions,
            global_rot_data,
            velocities,
            foot_contacts,
        ] = einops.unpack(features, self.ps, "batch time *")

        global_rot_mats = cont6d_to_matrix(global_rot_data)
        local_rot_mats = global_rots_to_local_rots(global_rot_mats, self.skeleton)

        posed_joints_from_pos = local_joints_positions.clone()
        posed_joints_from_pos[..., 0] += smooth_root_pos[..., None, 0]
        posed_joints_from_pos[..., 2] += smooth_root_pos[..., None, 2]
        root_positions = posed_joints_from_pos[..., self.skeleton.root_idx, :]
        foot_contacts = foot_contacts > 0.5

        if posed_joints_from == "rotations":
            _, posed_joints, _ = self.skeleton.fk(
                local_rot_mats,
                root_positions,
            )
        else:
            posed_joints = posed_joints_from_pos

        output_tensor_dict = {
            "local_rot_mats": local_rot_mats,
            "global_rot_mats": global_rot_mats,
            "posed_joints": posed_joints,
            "root_positions": root_positions,
            "smooth_root_pos": smooth_root_pos,
            "foot_contacts": foot_contacts,
            "global_root_heading": global_root_heading,
        }
        if return_numpy:
            return to_numpy(output_tensor_dict)
        return output_tensor_dict

    def create_conditions(
        self,
        index_dict: dict[Tensor],
        data_dict: dict[Tensor],
        length: int,
        to_normalize: bool,
        device: str,
    ):
        """Build sparse conditioning tensors for smooth-root representation."""
        # create empty features and mask to be filled in
        observed_motion = torch.zeros(length, self.motion_rep_dim, device=device)
        motion_mask = torch.zeros(length, self.motion_rep_dim, dtype=bool, device=device)

        def _cat_indices(indices_list: list[Tensor]) -> Tensor:
            indices = torch.cat([torch.tensor(x) if not isinstance(x, Tensor) else x for x in indices_list])
            return indices.to(device=device, dtype=torch.long)

        def _match_obs_dtype(tensor: Tensor) -> Tensor:
            return tensor.to(device=device, dtype=observed_motion.dtype)

        if (fname := "smooth_root_2d") in index_dict and index_dict[fname]:
            indices = _cat_indices(index_dict[fname])
            indices, smooth_root_2d = get_unique_index_and_data(indices, torch.cat(data_dict[fname]))
            smooth_root_2d = _match_obs_dtype(smooth_root_2d)
            f_sliced = observed_motion[:, self.slice_dict["smooth_root_pos"]]
            f_sliced[indices, 0] = smooth_root_2d[:, 0]
            f_sliced[indices, 2] = smooth_root_2d[:, 1]
            m_sliced = motion_mask[:, self.slice_dict["smooth_root_pos"]]
            m_sliced[indices, 0] = True
            m_sliced[indices, 2] = True

        if (fname := "root_y_pos") in index_dict and index_dict[fname]:
            indices = _cat_indices(index_dict[fname])
            indices, root_pos_Y = get_unique_index_and_data(indices, torch.cat(data_dict[fname]))
            root_pos_Y = _match_obs_dtype(root_pos_Y)
            f_sliced = observed_motion[:, self.slice_dict["smooth_root_pos"]]
            f_sliced[indices, 1] = root_pos_Y
            m_sliced = motion_mask[:, self.slice_dict["smooth_root_pos"]]
            m_sliced[indices, 1] = True

        if (fname := "global_root_heading") in index_dict and index_dict[fname]:
            indices = _cat_indices(index_dict[fname])
            indices, global_root_heading = get_unique_index_and_data(indices, torch.cat(data_dict[fname]))
            global_root_heading = _match_obs_dtype(global_root_heading)
            f_sliced = observed_motion[:, self.slice_dict[fname]]
            f_sliced[indices] = global_root_heading
            m_sliced = motion_mask[:, self.slice_dict[fname]]
            m_sliced[indices] = True

        if (fname := "global_joints_rots") in index_dict and index_dict[fname]:
            indices_lst = _cat_indices(index_dict[fname])
            indices_lst, global_joints_rots = get_unique_index_and_data(indices_lst, torch.cat(data_dict[fname]))
            global_joints_rots = _match_obs_dtype(global_joints_rots)
            global_rot_data = matrix_to_cont6d(global_joints_rots)
            f_sliced = observed_motion[:, self.slice_dict["global_rot_data"]]
            masking = torch.zeros(len(f_sliced) * self.nbjoints, 6, device=device, dtype=bool)
            masking[indices_lst.T[0] * self.nbjoints + indices_lst.T[1]] = True
            masking = masking.reshape(len(f_sliced), self.nbjoints * 6)
            f_sliced[masking] = global_rot_data.flatten()
            m_sliced = motion_mask[:, self.slice_dict["global_rot_data"]]
            m_sliced[masking] = True

        if (fname := "global_joints_positions") in index_dict and index_dict[fname]:
            indices_lst = _cat_indices(index_dict[fname])
            indices_lst, global_joints_positions = get_unique_index_and_data(indices_lst, torch.cat(data_dict[fname]))
            global_joints_positions = _match_obs_dtype(global_joints_positions)
            T_indices = indices_lst[:, 0].contiguous()
            _test = motion_mask[T_indices, self.slice_dict["smooth_root_pos"]]
            if not _test[:, [0, 2]].all():
                raise ValueError("For constraining global positions, the smooth root should also be constrained.")
            smooth_root_pos = observed_motion[T_indices, self.slice_dict["smooth_root_pos"]].clone()
            local_reference = smooth_root_pos.clone()
            local_reference[..., 1] = 0.0
            local_joints_positions = global_joints_positions - local_reference
            f_sliced = observed_motion[:, self.slice_dict["local_joints_positions"]]
            masking = torch.zeros(len(f_sliced) * self.nbjoints, 3, device=device, dtype=bool)
            masking[indices_lst.T[0] * self.nbjoints + indices_lst.T[1]] = True
            masking = masking.reshape(len(f_sliced), self.nbjoints * 3)
            f_sliced[masking] = local_joints_positions.flatten()
            m_sliced = motion_mask[:, self.slice_dict["local_joints_positions"]]
            m_sliced[masking] = True

        if to_normalize:
            observed_motion = self.normalize(observed_motion)
        return observed_motion, motion_mask
