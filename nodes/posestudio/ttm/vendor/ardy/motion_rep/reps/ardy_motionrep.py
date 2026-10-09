# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Ardy motion representation for autoregressive inference."""

from typing import Optional

import einops
import torch
from torch import Tensor

from ...geometry import cont6d_to_matrix, matrix_to_cont6d
from ...skeleton.kinematics import fk
from ...skeleton.transforms import global_rots_to_local_rots
from ...tools import ensure_batched, to_numpy
from ..conditioning import get_unique_index_and_data
from ..feet import foot_detect_from_pos_and_vel
from ..tools import (
    RotateFeatures,
    compute_heading_angle,
    compute_vel_xyz,
)
from .base import MotionRepBase


class ArdyMotionRep(MotionRepBase):
    """Global root / global joint representation used by Ardy inference.

    Feature layout:
    - ``root_pos``: root position ``[x, y, z]``.
    - ``global_root_heading``: root heading as ``[cos(theta), sin(theta)]``.
    - ``local_joints_positions``: non-root joints in root-local coordinates.
    - ``global_rot_data``: global joint rotations in 6D representation.
    - ``velocities``: global joint velocities.
    - ``foot_contacts``: four foot contact channels.
    """

    def __init__(
        self,
        skeleton,
        fps,
        stats_path: Optional[str] = None,
        stats=None,
        name: Optional[str] = None,
        **kwargs,
    ):
        # `stats`, `name`, and **kwargs let ArdyMotionRep be built straight from the
        # training config via Hydra instantiate(), which passes a (core) skeleton, a Stats
        # object (stats=...), a `name`, and possibly extra keys. See _ensure_ardy_skeleton.
        skeleton = self._ensure_ardy_skeleton(skeleton)
        assert skeleton.root_idx == 0, "ArdyMotionRep assumes the skeleton root index is 0."
        self.name = name if name is not None else f"{skeleton.name}_dual_root_global_joints"
        # Stats object (with a .folder) -> reuse ardy's single-folder sliced stats loader.
        if stats_path is None and stats is not None:
            stats_path = getattr(stats, "folder", None)
        nbjoints = skeleton.nbjoints

        self.size_dict = {
            "root_pos": torch.Size([3]),
            "global_root_heading": torch.Size([2]),
            "local_joints_positions": torch.Size([nbjoints - 1, 3]),  # removed the pelvis joint
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

    @staticmethod
    def _ensure_ardy_skeleton(skeleton):
        """Return an ardy.motion_rep skeleton.

        ArdyMotionRep relies on ardy.motion_rep FK/geometry, which require an ardy.motion_rep
        skeleton. When built from the (core) training config the loader passes a core skeleton, so
        rebuild the matching ardy skeleton from the same folder.
        """
        from ...skeleton import SkeletonBase as ArdySkeletonBase

        if isinstance(skeleton, ArdySkeletonBase):
            return skeleton

        from ...skeleton import (
            CoreSkeleton27,
            G1Skeleton34,
            SOMASkeleton30,
            SOMASkeleton77,
        )

        skel_by_njoints = {
            27: CoreSkeleton27,
            34: G1Skeleton34,
            30: SOMASkeleton30,
            77: SOMASkeleton77,
        }
        nbjoints = skeleton.nbjoints
        if nbjoints not in skel_by_njoints:
            raise ValueError(f"No ardy.motion_rep skeleton for nbjoints={nbjoints} (known: {sorted(skel_by_njoints)}).")
        try:
            device = next(skeleton.buffers()).device
        except (StopIteration, AttributeError):
            device = "cpu"
        return skel_by_njoints[nbjoints](
            folder=skeleton.folder,
            load=True,
            t_pose=getattr(skeleton, "t_pose", None),
        ).to(device)

    def recenter_root_motion(
        self,
        root_motion: torch.Tensor,
        center_frame_index: torch.Tensor,
        is_normalized: bool,
        to_normalize: bool,
        return_center_pos: bool = False,
    ):
        """Translate root x/z so a selected frame becomes the local origin."""
        if is_normalized:
            root_motion = self.global_root_stats.unnormalize(root_motion)

        batch_idx = torch.arange(root_motion.shape[0], device=root_motion.device)
        center_pos = root_motion[batch_idx, center_frame_index.long(), :3].clone()
        center_pos[:, 1] = 0
        root_motion = root_motion.clone()
        root_motion[:, :, [0, 2]] -= center_pos[:, None, [0, 2]]

        if to_normalize:
            root_motion = self.global_root_stats.normalize(root_motion)
        if return_center_pos:
            return root_motion, center_pos
        return root_motion

    @ensure_batched(local_joint_rots=5, root_positions=3, lengths=1)
    def __call__(
        self,
        local_joint_rots: torch.Tensor,
        root_positions: torch.Tensor,
        to_normalize: bool,
        to_canonicalize: bool = False,
        lengths: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """Convert local rotations and root positions into Ardy features."""
        device = local_joint_rots.device
        if lengths is None:
            assert local_joint_rots.shape[0] == 1, "If lengths is not provided, the input should not be batched."
            lengths = torch.tensor([local_joint_rots.shape[1]], device=device)

        global_joint_rots, global_positions, local_joints_positions_origin_is_pelvis = fk(
            local_joint_rots,
            root_positions,
            self.skeleton,
        )

        root_heading_angle = compute_heading_angle(global_positions, self.skeleton)
        global_root_heading = torch.stack([torch.cos(root_heading_angle), torch.sin(root_heading_angle)], dim=-1)

        ground_offset = torch.zeros_like(root_positions)
        ground_offset[..., 1] = root_positions[..., 1]
        # remove the pelvis joint (root_idx == 0) and align onto the ground
        local_joints_positions = local_joints_positions_origin_is_pelvis[:, :, 1:] + ground_offset[:, :, None]

        velocities = compute_vel_xyz(global_positions, self.fps, lengths=lengths)
        foot_contacts = foot_detect_from_pos_and_vel(global_positions, velocities, self.skeleton, 0.15, 0.10)
        global_rot_data = matrix_to_cont6d(global_joint_rots)

        features, _ = einops.pack(
            [
                root_positions,
                global_root_heading,
                local_joints_positions,
                global_rot_data,
                velocities,
                foot_contacts,
            ],
            "batch time *",
        )

        assert features.shape[-1] == self.motion_rep_dim

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
            root_pos,
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
                RF.rotate_positions(root_pos),
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
    def translate_2d(self, features: torch.Tensor, translation_2d: torch.Tensor) -> torch.Tensor:
        """Translate root planar position by ``(dx, dz)``."""
        bs = features.shape[0]
        if len(translation_2d.shape) == 1:
            translation_2d = translation_2d.repeat(bs, 1)

        new_features = features.clone()
        new_root_pos = new_features[:, :, self.slice_dict["root_pos"]]
        new_root_pos[:, :, 0] += translation_2d[:, [0]]
        new_root_pos[:, :, 2] += translation_2d[:, [1]]
        return new_features

    @ensure_batched(features=3)
    def inverse(
        self,
        features: torch.Tensor,
        is_normalized: bool,
        posed_joints_from="rotations",
        return_numpy: bool = False,
    ) -> dict:
        """Decode Ardy features into motion tensors."""
        assert posed_joints_from in ["rotations", "positions"], "posed_joints_from should be rotations or positions"

        if is_normalized:
            features = self.unnormalize(features)

        [
            root_positions,
            global_root_heading,
            local_joints_positions,
            global_rot_data,
            velocities,
            foot_contacts,
        ] = einops.unpack(features, self.ps, "batch time *")

        global_rot_mats = cont6d_to_matrix(global_rot_data)
        local_rot_mats = global_rots_to_local_rots(global_rot_mats, self.skeleton)

        if posed_joints_from == "rotations":
            _, posed_joints, _ = fk(local_rot_mats, root_positions, self.skeleton)
        else:
            dummy_root = torch.zeros_like(local_joints_positions[:, :, [0]])
            posed_joints = torch.cat([dummy_root, local_joints_positions], dim=2)
            posed_joints[..., 0] += root_positions[..., None, 0]
            posed_joints[..., 2] += root_positions[..., None, 2]

        output_tensor_dict = {
            "local_rot_mats": local_rot_mats,
            "global_rot_mats": global_rot_mats,
            "posed_joints": posed_joints,
            "root_positions": root_positions,
            "smooth_root_pos": root_positions,
            "foot_contacts": foot_contacts > 0.5,
            "global_root_heading": global_root_heading,
        }
        if return_numpy:
            return to_numpy(output_tensor_dict)
        return output_tensor_dict

    def create_conditions(
        self,
        index_dict: dict,
        data_dict: dict,
        length: int,
        to_normalize: bool,
        device: str,
    ):
        observed_motion = torch.zeros(length, self.motion_rep_dim, device=device)
        motion_mask = torch.zeros(length, self.motion_rep_dim, dtype=bool, device=device)

        self._fill_root_2d_constraints(observed_motion, motion_mask, index_dict, data_dict, device)
        self._fill_global_heading_constraints(observed_motion, motion_mask, index_dict, data_dict, device)
        self._fill_root_y_constraints(observed_motion, motion_mask, index_dict, data_dict, device)
        self._fill_global_rotation_constraints(observed_motion, motion_mask, index_dict, data_dict, device)
        self._fill_global_position_constraints(observed_motion, motion_mask, index_dict, data_dict, device)

        motion_mask = motion_mask.float()
        if to_normalize:
            observed_motion = self.normalize(observed_motion) * motion_mask
        return observed_motion, motion_mask

    def _cat_indices(self, values, device):
        indices = torch.cat([torch.tensor(x) if not isinstance(x, Tensor) else x for x in values])
        return indices.to(device=device, dtype=torch.long)

    def _fill_root_2d_constraints(self, observed_motion, motion_mask, index_dict, data_dict, device):
        fname = "root_2d" if index_dict.get("root_2d") else "smooth_root_2d"
        if fname not in index_dict or not index_dict[fname]:
            return

        indices = self._cat_indices(index_dict[fname], device)
        indices, root_pos_2d = get_unique_index_and_data(indices, torch.cat(data_dict[fname]).to(device))
        f_sliced = observed_motion[:, self.slice_dict["root_pos"]]
        f_sliced[indices, 0] = root_pos_2d[:, 0]
        f_sliced[indices, 2] = root_pos_2d[:, 1]
        m_sliced = motion_mask[:, self.slice_dict["root_pos"]]
        m_sliced[indices, 0] = True
        m_sliced[indices, 2] = True

    def _fill_global_heading_constraints(self, observed_motion, motion_mask, index_dict, data_dict, device):
        fname = "global_root_heading"
        if fname not in index_dict or not index_dict[fname]:
            return

        indices = self._cat_indices(index_dict[fname], device)
        indices, global_root_heading = get_unique_index_and_data(indices, torch.cat(data_dict[fname]).to(device))
        f_sliced = observed_motion[:, self.slice_dict[fname]]
        f_sliced[indices] = global_root_heading
        m_sliced = motion_mask[:, self.slice_dict[fname]]
        m_sliced[indices] = True

    def _fill_root_y_constraints(self, observed_motion, motion_mask, index_dict, data_dict, device):
        fname = "root_y_pos"
        if fname not in index_dict or not index_dict[fname]:
            return

        indices = self._cat_indices(index_dict[fname], device)
        indices, root_y_pos = get_unique_index_and_data(indices, torch.cat(data_dict[fname]).to(device))
        root_y_pos = root_y_pos.reshape(-1)
        f_sliced = observed_motion[:, self.slice_dict["root_pos"]]
        f_sliced[indices, 1] = root_y_pos
        m_sliced = motion_mask[:, self.slice_dict["root_pos"]]
        m_sliced[indices, 1] = True

    def _fill_global_rotation_constraints(self, observed_motion, motion_mask, index_dict, data_dict, device):
        fname = "global_joints_rots"
        if fname not in index_dict or not index_dict[fname]:
            return

        indices_lst = self._cat_indices(index_dict[fname], device)
        indices_lst, global_joints_rots = get_unique_index_and_data(indices_lst, torch.cat(data_dict[fname]).to(device))
        global_rot_data = matrix_to_cont6d(global_joints_rots)

        f_sliced = observed_motion[:, self.slice_dict["global_rot_data"]]
        masking = torch.zeros(len(f_sliced) * self.nbjoints, 6, device=device, dtype=bool)
        masking[indices_lst.T[0] * self.nbjoints + indices_lst.T[1]] = True
        masking = masking.reshape(len(f_sliced), self.nbjoints * 6)
        f_sliced[masking] = global_rot_data.flatten()
        m_sliced = motion_mask[:, self.slice_dict["global_rot_data"]]
        m_sliced[masking] = True

    def _fill_global_position_constraints(self, observed_motion, motion_mask, index_dict, data_dict, device):
        fname = "global_joints_positions"
        if fname not in index_dict or not index_dict[fname]:
            return

        indices_lst = self._cat_indices(index_dict[fname], device)
        indices_lst, global_joints_positions = get_unique_index_and_data(
            indices_lst,
            torch.cat(data_dict[fname]).to(device),
        )

        time_indices = indices_lst[:, 0].contiguous()
        unique_times = time_indices.unique().contiguous()
        value_indices = torch.searchsorted(unique_times, time_indices)
        hips_mask = indices_lst[:, 1] == self.skeleton.root_idx
        assert hips_mask.sum() == len(unique_times)
        assert (indices_lst[hips_mask, 0] == unique_times).all()

        root_positions = global_joints_positions[hips_mask][value_indices].clone()
        root_positions_y = root_positions[:, 1].clone()

        root_test = motion_mask[time_indices, self.slice_dict["root_pos"]]
        if not root_test[:, [0, 2]].all():
            raise ValueError("For constraining global positions, root 2D should also be constrained.")

        ground_offset = torch.zeros_like(root_positions)
        ground_offset[:, 1] = root_positions_y
        local_joints_positions = global_joints_positions - root_positions + ground_offset

        f_sliced = observed_motion[:, self.slice_dict["local_joints_positions"]]
        masking = torch.zeros(len(f_sliced) * (self.nbjoints - 1), 3, device=device, dtype=bool)
        non_root_mask = ~hips_mask
        indices_lst_no_root = indices_lst[non_root_mask]
        local_joints_positions_no_root = local_joints_positions[non_root_mask]
        masking[indices_lst_no_root[:, 0] * (self.nbjoints - 1) + (indices_lst_no_root[:, 1] - 1)] = True
        masking = masking.reshape(len(f_sliced), (self.nbjoints - 1) * 3)
        f_sliced[masking] = local_joints_positions_no_root.flatten()
        m_sliced = motion_mask[:, self.slice_dict["local_joints_positions"]]
        m_sliced[masking] = True
