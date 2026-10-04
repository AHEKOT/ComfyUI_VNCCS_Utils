# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Base motion representation: feature layout, normalization, and conditioning helpers."""

import os
from typing import Optional

import einops
import numpy as np
import torch
from einops import repeat

from ...tools import ensure_batched
from ..conditioning import build_condition_dicts
from ..feature_utils import compute_vel_angle, compute_vel_xyz
from ..stats import Stats


def _require_split_stats_layout(stats_path: str) -> None:
    """Raise if stats_path does not contain the required global_root, local_root, body subdirs."""
    subdirs = ("global_root", "local_root", "body")
    missing = []
    for name in subdirs:
        subpath = os.path.join(stats_path, name)
        mean_path = os.path.join(subpath, "mean.npy")
        if not os.path.isfile(mean_path):
            missing.append(f"{subpath}/ (mean.npy)")
    if missing:
        raise FileNotFoundError(
            f"Checkpoint stats must use the split layout with subfolders "
            f"global_root/, local_root/, and body/ under '{stats_path}'. "
            f"Missing or incomplete: {', '.join(missing)}. "
        )


class MotionRepBase:
    """Base class for motion representations used in generation and conditioning.

    Subclasses define:
    - ``size_dict``: feature blocks and their shapes,
    - ``last_root_feature``: last entry of the root block,
    - ``local_root_size_dict``: local-root feature layout,
    and implement transform-specific methods such as ``__call__``, ``inverse``,
    ``rotate``, ``translate_2d`` and ``create_conditions``.
    """

    def __init__(
        self,
        skeleton,
        fps,
        stats_path: Optional[str] = None,
    ):
        """Initialize feature slicing metadata and optional normalization stats."""

        self.skeleton = skeleton
        self.fps = fps
        self.nbjoints = skeleton.nbjoints

        self.feature_names = list(self.size_dict.keys())
        self.ps = list(self.size_dict.values())
        self.nfeats_dict = {key: val.numel() for key, val in self.size_dict.items()}
        feats_cumsum = np.cumsum([0] + list(self.nfeats_dict.values())).tolist()
        self.slice_dict = {key: slice(feats_cumsum[i], feats_cumsum[i + 1]) for i, key in enumerate(self.feature_names)}

        self.motion_rep_dim = sum(self.nfeats_dict.values())
        self.root_slice = slice(0, self.slice_dict[self.last_root_feature].stop)
        self.body_slice = slice(self.root_slice.stop, self.motion_rep_dim)
        self.body_dim = self.body_slice.stop - self.body_slice.start
        self.global_root_dim = self.root_slice.stop
        self.local_root_dim = sum(val.numel() for val in self.local_root_size_dict.values())

        if stats_path:
            _require_split_stats_layout(stats_path)
            self.global_root_stats = Stats(os.path.join(stats_path, "global_root"))
            self.local_root_stats = Stats(os.path.join(stats_path, "local_root"))
            self.body_stats = Stats(os.path.join(stats_path, "body"))

            # Global stats
            mean = torch.cat([self.global_root_stats.mean, self.body_stats.mean])
            std = torch.cat([self.global_root_stats.std, self.body_stats.std])
            assert len(mean) == len(std) == self.motion_rep_dim, "There is an stat issue."
            self.stats = Stats()
            self.stats.register_from_tensors(mean, std)

    def get_root_pos(self, features: torch.Tensor, fallback_to_smooth: bool = True):
        """Extract root positions from a feature tensor.

        Supports both ``root_pos`` and ``smooth_root_pos`` representations.
        """
        if "root_pos" in self.slice_dict:
            return features[..., self.slice_dict["root_pos"]]

        if "smooth_root_pos" not in self.slice_dict:
            raise TypeError("This motion rep should have either a root_pos or smooth_root_pos field")

        if fallback_to_smooth:
            return features[:, :, self.slice_dict["smooth_root_pos"]]

        # else compute the root pos from the smooth root and local joints offset
        smooth_root_pos = features[:, :, self.slice_dict["smooth_root_pos"]].clone()
        local_joints_positions_flatten = features[..., self.slice_dict["local_joints_positions"]]
        hips_offset = local_joints_positions_flatten[..., self.skeleton.root_idx : self.skeleton.root_idx + 3]
        root_pos = torch.stack(
            [
                smooth_root_pos[..., 0] + hips_offset[..., 0],
                smooth_root_pos[..., 1],
                smooth_root_pos[..., 2] + hips_offset[..., 2],
            ],
            axis=-1,
        )
        return root_pos

    @ensure_batched(root_features=3, lengths=1)
    def global_root_to_local_root(
        self,
        root_features: torch.Tensor,
        normalized: bool,
        lengths: Optional[torch.Tensor],
    ):
        """Convert global root features to local-root motion features.

        Args:
            root_features: Root feature tensor containing root position and
                global heading, shaped ``[B, T, D_root]``.
            normalized: Whether ``root_features`` are normalized.
            lengths: Optional valid lengths per sequence.

        Returns:
            Tensor ``[B, T, 4]`` with local root rotational velocity, planar
            velocity, and global root height.
        """
        if normalized:
            root_features = self.global_root_stats.unnormalize(root_features)

        [root_pos, global_root_heading] = einops.unpack(root_features, self.ps[:2], "batch time *")
        cos, sin = global_root_heading.unbind(-1)
        heading_angle = torch.arctan2(sin, cos)

        local_root_rot_vel = compute_vel_angle(heading_angle, self.fps, lengths=lengths)
        local_root_vel = compute_vel_xyz(
            root_pos[..., None, :],
            self.fps,
            lengths=lengths,
        )[..., 0, [0, 2]]
        global_root_y = root_pos[..., 1]
        local_root_motion = torch.cat(
            [
                local_root_rot_vel[..., None],
                local_root_vel,
                global_root_y[..., None],
            ],
            axis=-1,
        )

        if normalized:
            local_root_motion = self.local_root_stats.normalize(local_root_motion)
        return local_root_motion

    def get_root_heading_angle(self, features: torch.Tensor) -> torch.Tensor:
        """Compute root heading angle from cosine/sine heading features."""
        global_root_heading = features[:, :, self.slice_dict["global_root_heading"]]
        cos, sin = global_root_heading.unbind(-1)
        return torch.arctan2(sin, cos)

    @ensure_batched(features=3)
    def rotate_to(
        self,
        features: torch.Tensor,
        target_angle: torch.Tensor,
        return_delta_angle=False,
    ):
        """Rotate each sequence so frame-0 heading matches ``target_angle``."""
        # rotate so that the first frame angle is the target
        # it put the motion_rep to the angle
        current_first_angle = self.get_root_heading_angle(features)[:, 0]
        delta_angle = target_angle - current_first_angle
        rotated_features = self.rotate(features, delta_angle)
        if return_delta_angle:
            return rotated_features, delta_angle
        return rotated_features

    @ensure_batched(features=3)
    def rotate_to_zero(
        self,
        features: torch.Tensor,
        return_delta_angle=False,
    ):
        """Rotate each sequence so frame-0 heading becomes zero."""
        target_angle = torch.zeros(len(features), device=features.device)
        return self.rotate_to(features, target_angle, return_delta_angle=return_delta_angle)

    @ensure_batched(features=3)
    def randomize_first_heading(
        self,
        features: torch.Tensor,
        return_delta_angle=False,
    ) -> torch.Tensor:
        """Rotate each sequence to a random frame-0 heading."""
        target_heading_angle = torch.rand(features.shape[0]) * 2 * np.pi
        return self.rotate_to(
            features,
            target_heading_angle,
            return_delta_angle=return_delta_angle,
        )

    @ensure_batched(features=3, target_2d_pos=2)
    def translate_2d_to(
        self,
        features: torch.Tensor,
        target_2d_pos: torch.Tensor,
        return_delta_pos: bool = False,
    ) -> torch.Tensor:
        """Translate each sequence so frame-0 root ``(x, z)`` matches a target."""
        root_pos = self.get_root_pos(features)
        current_first_2d_pos = root_pos[:, 0, [0, 2]].clone()
        delta_2d_pos = target_2d_pos - current_first_2d_pos
        translated_features = self.translate_2d(features, delta_2d_pos)
        if return_delta_pos:
            return translated_features, delta_2d_pos
        return translated_features

    @ensure_batched(features=3)
    def translate_2d_to_zero(
        self,
        features: torch.Tensor,
        return_delta_pos: bool = False,
    ) -> torch.Tensor:
        """Translate each sequence so frame-0 root ``(x, z)`` is at the origin."""
        target_2d_pos = torch.zeros(len(features), 2, device=features.device)
        return self.translate_2d_to(features, target_2d_pos, return_delta_pos=return_delta_pos)

    @ensure_batched(features=3)
    def canonicalize(self, features: torch.Tensor, normalized: bool = False):
        """Canonicalize heading and planar position at frame 0."""
        if normalized:
            features = self.unnormalize(features)
        rotated_features = self.rotate_to_zero(features)
        canonicalized_features = self.translate_2d_to_zero(rotated_features)
        if normalized:
            canonicalized_features = self.normalize(canonicalized_features)
        return canonicalized_features

    def normalize(self, features):
        """Normalize features."""
        return self.stats.normalize(features)

    def unnormalize(self, features):
        """Undo feature normalization."""
        return self.stats.unnormalize(features)

    def create_conditions_from_constraints(
        self,
        constraints_lst: list,
        length: int,
        to_normalize: bool,
        device: str,
    ):
        """Create a conditioning tensor and mask from constraint objects."""
        index_dict, data_dict = build_condition_dicts(constraints_lst)
        return self.create_conditions(index_dict, data_dict, length, to_normalize, device)

    def create_conditions_from_constraints_batched(
        self,
        constraints_lst: list | list[list],
        lengths: torch.Tensor,
        to_normalize: bool,
        device: str,
    ):
        """Batched version of ``create_conditions_from_constraints``.

        Supports either one shared constraint list for all batch elements, or a per-sample list of
        constraint lists.
        """
        num_samples = len(lengths)
        if not constraints_lst or not isinstance(constraints_lst[0], list):
            # If no constraints, or constraints are shared across the batch,
            # build once and repeat.
            observed_motion, motion_mask = self.create_conditions_from_constraints(
                constraints_lst, int(lengths.max()), to_normalize, device
            )
            observed_motion = repeat(observed_motion, "t d -> b t d", b=num_samples)
            motion_mask = repeat(motion_mask, "t d -> b t d", b=num_samples)
            return observed_motion, motion_mask

        length = int(lengths.max())
        observed_motion_lst = []
        motion_mask_lst = []
        for constraints_lst_el in constraints_lst:
            observed_motion, motion_mask = self.create_conditions_from_constraints(
                constraints_lst_el,
                length,
                to_normalize,
                device,
            )
            observed_motion_lst.append(observed_motion)
            motion_mask_lst.append(motion_mask)
        observed_motion = torch.stack(observed_motion_lst, axis=0)
        motion_mask = torch.stack(motion_mask_lst, axis=0)
        return observed_motion, motion_mask
