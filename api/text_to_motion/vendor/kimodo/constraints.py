# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Constraint sets for conditioning motion generation (root 2D, full body, end-effectors)."""

from typing import Optional, Union

import torch
from torch import Tensor

from .motion_rep.feature_utils import compute_heading_angle
from .skeleton import SkeletonBase, SOMASkeleton30, SOMASkeleton77
from .tools import ensure_batched, load_json, save_json

from .geometry import axis_angle_to_matrix, matrix_to_axis_angle


def _convert_constraint_local_rots_to_skeleton(local_rot_mats: Tensor, skeleton: SkeletonBase) -> Tensor:
    """Convert loaded local rotation matrices to match the skeleton's joint count.

    Handles SOMA 30↔77: constraint files may have been saved with 30 or 77 joints while the session
    skeleton (e.g. from the SOMA30 model) uses SOMASkeleton77.
    """
    n_joints = local_rot_mats.shape[-3]
    skeleton_joints = skeleton.nbjoints
    if n_joints == skeleton_joints:
        return local_rot_mats
    if n_joints == 77 and skeleton_joints == 30 and isinstance(skeleton, SOMASkeleton30):
        return skeleton.from_SOMASkeleton77(local_rot_mats)
    if n_joints == 30 and skeleton_joints == 77 and isinstance(skeleton, SOMASkeleton77):
        skel30 = SOMASkeleton30()
        return skel30.to_SOMASkeleton77(local_rot_mats)
    raise ValueError(
        f"Constraint joint count ({n_joints}) does not match skeleton joint count "
        f"({skeleton_joints}). Only SOMA 30↔77 conversion is supported."
    )


def create_pairs(tensor_A: Tensor, tensor_B: Tensor) -> Tensor:
    """Form all (a, b) pairs from two 1D tensors; output shape (len(A)*len(B), 2)."""
    pairs = torch.stack(
        (
            tensor_A[:, None].expand(-1, len(tensor_B)),
            tensor_B.expand(len(tensor_A), -1),
        ),
        dim=-1,
    ).reshape(-1, 2)
    return pairs


def compute_global_heading(global_joints_positions: Tensor, skeleton: SkeletonBase) -> Tensor:
    """Compute global root heading (cos, sin) from global joint positions using skeleton."""
    root_heading_angle = compute_heading_angle(global_joints_positions, skeleton)
    global_root_heading = torch.stack([torch.cos(root_heading_angle), torch.sin(root_heading_angle)], dim=-1)
    return global_root_heading


def _tensor_to(
    t: Tensor,
    device: Optional[Union[str, torch.device]] = None,
    dtype: Optional[torch.dtype] = None,
) -> Tensor:
    """Move tensor to device and/or dtype.

    Returns same tensor if no args.
    """
    if device is not None and dtype is not None:
        return t.to(device=device, dtype=dtype)
    if device is not None:
        return t.to(device=device)
    if dtype is not None:
        return t.to(dtype=dtype)
    return t


class Root2DConstraintSet:
    """Constraint set fixing root (x, z) trajectory and optionally global heading on given
    frames."""

    name = "root2d"

    def __init__(
        self,
        skeleton: SkeletonBase,
        frame_indices: Tensor,
        smooth_root_2d: Tensor,
        to_crop: bool = False,
        global_root_heading: Optional[Tensor] = None,
    ) -> None:
        self.skeleton = skeleton

        # if we pass the full smooth root 3D as input
        if smooth_root_2d.shape[-1] == 3:
            smooth_root_2d = smooth_root_2d[..., [0, 1]]

        if to_crop:
            smooth_root_2d = smooth_root_2d[frame_indices]
            if global_root_heading is not None:
                global_root_heading = global_root_heading[frame_indices]
        else:
            assert len(smooth_root_2d) == len(
                frame_indices
            ), "The number of smooth root 2d should be match the number of frames"
            if global_root_heading is not None:
                assert len(global_root_heading) == len(
                    frame_indices
                ), "The number of global root heading should be match the number of frames"

        self.smooth_root_2d = smooth_root_2d
        self.global_root_heading = global_root_heading
        self.frame_indices = frame_indices

    def update_constraints(self, data_dict: dict, index_dict: dict) -> None:
        """Append this constraint's smooth_root_2d (and optional global_root_heading) to data/index
        dicts."""
        data_dict["smooth_root_2d"].append(self.smooth_root_2d)
        index_dict["smooth_root_2d"].append(self.frame_indices)

        if self.global_root_heading is not None:
            # constraint the global heading
            data_dict["global_root_heading"].append(self.global_root_heading)
            index_dict["global_root_heading"].append(self.frame_indices)

    def crop_move(self, start: int, end: int) -> "Root2DConstraintSet":
        """Return a new constraint set for the cropped frame range [start, end)."""
        mask = (self.frame_indices >= start) & (self.frame_indices < end)

        if self.global_root_heading is not None:
            masked_global_root_heading = self.global_root_heading[mask]
        else:
            masked_global_root_heading = None

        return Root2DConstraintSet(
            self.skeleton,
            self.frame_indices[mask] - start,
            self.smooth_root_2d[mask],
            global_root_heading=masked_global_root_heading,
        )

    def get_save_info(self) -> dict:
        """Return a dict suitable for JSON serialization (frame_indices, smooth_root_2d, optional
        global_root_heading)."""
        out = {
            "type": self.name,
            "frame_indices": self.frame_indices,
            "smooth_root_2d": self.smooth_root_2d,
        }
        if self.global_root_heading is not None:
            out["global_root_heading"] = self.global_root_heading
        return out

    def to(
        self,
        device: Optional[Union[str, torch.device]] = None,
        dtype: Optional[torch.dtype] = None,
    ) -> "Root2DConstraintSet":
        self.smooth_root_2d = _tensor_to(self.smooth_root_2d, device, dtype)
        self.frame_indices = _tensor_to(self.frame_indices, device, dtype)
        if self.global_root_heading is not None:
            self.global_root_heading = _tensor_to(self.global_root_heading, device, dtype)
        if device is not None and hasattr(self.skeleton, "to"):
            self.skeleton = self.skeleton.to(device)
        return self

    @classmethod
    def from_dict(cls, skeleton: SkeletonBase, dico: dict) -> "Root2DConstraintSet":
        """Build a Root2DConstraintSet from a dict (e.g. loaded from JSON)."""
        device = skeleton.device if hasattr(skeleton, "device") else "cpu"

        if "global_root_heading" in dico:
            global_root_heading = torch.tensor(dico["global_root_heading"], device=device)
        else:
            global_root_heading = None

        return cls(
            skeleton,
            frame_indices=torch.tensor(dico["frame_indices"]),
            smooth_root_2d=torch.tensor(dico["smooth_root_2d"], device=device),
            global_root_heading=global_root_heading,
        )


class FullBodyConstraintSet:
    """Constraint set fixing full-body global positions and rotations on given keyframes."""

    name = "fullbody"

    def __init__(
        self,
        skeleton: SkeletonBase,
        frame_indices: Tensor,
        global_joints_positions: Tensor,
        global_joints_rots: Tensor,
        smooth_root_2d: Optional[Tensor] = None,
        to_crop: bool = False,
    ):
        self.skeleton = skeleton
        self.frame_indices = frame_indices

        # if we pass the full smooth root 3D as input
        if smooth_root_2d is not None and smooth_root_2d.shape[-1] == 3:
            smooth_root_2d = smooth_root_2d[..., [0, 1]]

        if to_crop:
            global_joints_positions = global_joints_positions[frame_indices]
            global_joints_rots = global_joints_rots[frame_indices]
            if smooth_root_2d is not None:
                smooth_root_2d = smooth_root_2d[frame_indices]
        else:
            assert len(global_joints_positions) == len(
                frame_indices
            ), "The number of global positions should be match the number of frames"
            assert len(global_joints_rots) == len(
                frame_indices
            ), "The number of global joint rotations should be match the number of frames"

            if smooth_root_2d is not None:
                assert len(smooth_root_2d) == len(
                    frame_indices
                ), "The number of smooth root 2d (if specified) should be match the number of frames"

        if smooth_root_2d is None:
            # substitute the smooth root 2d with the real root
            smooth_root_2d = global_joints_positions[:, skeleton.root_idx, [0, 2]]

        # root y: from smooth or pelvis is the same
        self.root_y_pos = global_joints_positions[:, skeleton.root_idx, 1]

        self.global_joints_positions = global_joints_positions
        self.global_joints_rots = global_joints_rots
        self.global_root_heading = compute_global_heading(global_joints_positions, skeleton)
        self.smooth_root_2d = smooth_root_2d

    def update_constraints(self, data_dict: dict, index_dict: dict) -> None:
        """Append global positions, smooth root 2D, root y, and global heading to data/index
        dicts."""
        nbjoints = self.skeleton.nbjoints
        indices_lst = create_pairs(
            self.frame_indices,
            torch.arange(nbjoints, device=self.frame_indices.device),
        )
        data_dict["global_joints_positions"].append(
            self.global_joints_positions.reshape(-1, 3)
        )  # flatten the global positions
        index_dict["global_joints_positions"].append(indices_lst)

        # global rotations are not used here

        # as we use smooth root, also constraint the smooth root to get the same full body
        # maybe keep storing the hips offset, if we smooth it ourselves
        data_dict["smooth_root_2d"].append(self.smooth_root_2d)
        index_dict["smooth_root_2d"].append(self.frame_indices)

        # constraint the y pos of the root
        data_dict["root_y_pos"].append(self.root_y_pos)
        index_dict["root_y_pos"].append(self.frame_indices)

        # constraint the global heading
        data_dict["global_root_heading"].append(self.global_root_heading)
        index_dict["global_root_heading"].append(self.frame_indices)

    def crop_move(self, start: int, end: int) -> "FullBodyConstraintSet":
        """Return a new FullBodyConstraintSet for the cropped frame range [start, end)."""
        mask = (self.frame_indices >= start) & (self.frame_indices < end)
        return FullBodyConstraintSet(
            self.skeleton,
            self.frame_indices[mask] - start,
            self.global_joints_positions[mask],
            self.global_joints_rots[mask],
            self.smooth_root_2d[mask],
        )

    def get_save_info(self) -> dict:
        """Return a dict for JSON save: type, frame_indices, local_joints_rot, root_positions, smooth_root_2d."""
        local_joints_rot = self.skeleton.global_rots_to_local_rots(self.global_joints_rots)
        if isinstance(self.skeleton, SOMASkeleton30):
            local_joints_rot = self.skeleton.to_SOMASkeleton77(local_joints_rot)
        local_joints_rot = matrix_to_axis_angle(local_joints_rot)

        root_positions = self.global_joints_positions[:, self.skeleton.root_idx]
        return {
            "type": self.name,
            "frame_indices": self.frame_indices,
            "local_joints_rot": local_joints_rot,
            "root_positions": root_positions,
            "smooth_root_2d": self.smooth_root_2d,
        }

    def to(
        self,
        device: Optional[Union[str, torch.device]] = None,
        dtype: Optional[torch.dtype] = None,
    ) -> "FullBodyConstraintSet":
        self.frame_indices = _tensor_to(self.frame_indices, device, dtype)
        self.global_joints_positions = _tensor_to(self.global_joints_positions, device, dtype)
        self.global_joints_rots = _tensor_to(self.global_joints_rots, device, dtype)
        self.root_y_pos = _tensor_to(self.root_y_pos, device, dtype)
        self.global_root_heading = _tensor_to(self.global_root_heading, device, dtype)
        self.smooth_root_2d = _tensor_to(self.smooth_root_2d, device, dtype)
        if device is not None and hasattr(self.skeleton, "to"):
            self.skeleton = self.skeleton.to(device)
        return self

    @classmethod
    def from_dict(cls, skeleton: SkeletonBase, dico: dict) -> "FullBodyConstraintSet":
        """Build a FullBodyConstraintSet from a dict (e.g. loaded from JSON)."""
        frame_indices = torch.tensor(dico["frame_indices"])
        device = skeleton.device if hasattr(skeleton, "device") else "cpu"
        local_rot = torch.tensor(dico["local_joints_rot"], device=device)
        local_rot_mats = axis_angle_to_matrix(local_rot)
        local_rot_mats = _convert_constraint_local_rots_to_skeleton(local_rot_mats, skeleton)
        global_joints_rots, global_joints_positions, _ = skeleton.fk(
            local_rot_mats,
            torch.tensor(dico["root_positions"], device=device),
        )
        smooth_root_2d = None
        if "smooth_root_2d" in dico:
            smooth_root_2d = torch.tensor(dico["smooth_root_2d"], device=device)

        return cls(
            skeleton,
            frame_indices=frame_indices,
            global_joints_positions=global_joints_positions,
            global_joints_rots=global_joints_rots,
            smooth_root_2d=smooth_root_2d,
        )


class EndEffectorConstraintSet:
    """Constraint set fixing selected end-effector positions and rotations on given frames."""

    name = "end-effector"

    def __init__(
        self,
        skeleton: SkeletonBase,
        frame_indices: Tensor,
        global_joints_positions: Tensor,
        global_joints_rots: Tensor,
        smooth_root_2d: Optional[Tensor],
        *,
        joint_names: list[str],
        to_crop: bool = False,
    ) -> None:
        self.skeleton = skeleton
        self.frame_indices = frame_indices
        self.joint_names = joint_names

        # joint_names are constant for all the frames
        rot_joint_names, pos_joint_names = self.skeleton.expand_joint_names(self.joint_names)
        # indexing works for motion_rep with smooth root only (contains pelvis index)
        self.pos_indices = torch.tensor([self.skeleton.bone_index[jname] for jname in pos_joint_names])
        self.rot_indices = torch.tensor([self.skeleton.bone_index[jname] for jname in rot_joint_names])

        # if we pass the full smooth root 3D as input
        if smooth_root_2d is not None and smooth_root_2d.shape[-1] == 3:
            smooth_root_2d = smooth_root_2d[..., [0, 1]]

        if to_crop:
            global_joints_positions = global_joints_positions[frame_indices]
            global_joints_rots = global_joints_rots[frame_indices]
            if smooth_root_2d is not None:
                smooth_root_2d = smooth_root_2d[frame_indices]
        else:
            assert len(global_joints_positions) == len(
                frame_indices
            ), "The number of global positions should be match the number of frames"
            assert len(global_joints_rots) == len(
                frame_indices
            ), "The number of global joint rotations should be match the number of frames"
            if smooth_root_2d is not None:
                assert len(smooth_root_2d) == len(
                    frame_indices
                ), "The number of smooth root 2d (if specified) should be match the number of frames"

        if smooth_root_2d is None:
            # substitute the smooth root 2d with the real root
            smooth_root_2d = global_joints_positions[:, skeleton.root_idx, [0, 2]]

        # root y: from smooth or pelvis is the same
        self.root_y_pos = global_joints_positions[:, skeleton.root_idx, 1]

        self.global_joints_positions = global_joints_positions
        self.global_root_heading = compute_global_heading(global_joints_positions, skeleton)
        self.global_joints_rots = global_joints_rots
        self.smooth_root_2d = smooth_root_2d

    def update_constraints(self, data_dict: dict, index_dict: dict) -> None:
        """Append constrained joint positions/rots, smooth root 2D, root y, and heading to
        data/index dicts."""
        crop_frames_indexing = torch.arange(len(self.frame_indices), device=self.frame_indices.device)

        # constraint positions
        pos_indices_real = create_pairs(
            self.frame_indices,
            self.pos_indices,
        )
        pos_indices_crop = create_pairs(
            crop_frames_indexing,
            self.pos_indices,
        )
        data_dict["global_joints_positions"].append(self.global_joints_positions[tuple(pos_indices_crop.T)])
        index_dict["global_joints_positions"].append(pos_indices_real)

        # constraint rotations
        rot_indices_real = create_pairs(
            self.frame_indices,
            self.rot_indices,
        )
        rot_indices_crop = create_pairs(
            crop_frames_indexing,
            self.rot_indices,
        )
        data_dict["global_joints_rots"].append(self.global_joints_rots[tuple(rot_indices_crop.T)])
        index_dict["global_joints_rots"].append(rot_indices_real)

        # as we use smooth root, also constraint the smooth root to get the same full body
        # maybe keep storing the hips offset, if we smooth it ourselves
        data_dict["smooth_root_2d"].append(self.smooth_root_2d)
        index_dict["smooth_root_2d"].append(self.frame_indices)

        # constraint the y pos of the root
        data_dict["root_y_pos"].append(self.root_y_pos)
        index_dict["root_y_pos"].append(self.frame_indices)

        # constraint the global heading
        data_dict["global_root_heading"].append(self.global_root_heading)
        index_dict["global_root_heading"].append(self.frame_indices)

    def crop_move(self, start: int, end: int) -> "EndEffectorConstraintSet":
        """Return a new EndEffectorConstraintSet for the cropped frame range [start, end)."""
        mask = (self.frame_indices >= start) & (self.frame_indices < end)

        cls = type(self)
        kwargs = {}
        if not hasattr(cls, "joint_names"):
            kwargs["joint_names"] = self.joint_names

        return cls(
            self.skeleton,
            self.frame_indices[mask] - start,
            self.global_joints_positions[mask],
            self.global_joints_rots[mask],
            self.smooth_root_2d[mask],
            **kwargs,
        )

    def get_save_info(self) -> dict:
        """Return a dict for JSON save: type, frame_indices, local_joints_rot, root_positions, smooth_root_2d, joint_names."""
        local_joints_rot = self.skeleton.global_rots_to_local_rots(self.global_joints_rots)
        if isinstance(self.skeleton, SOMASkeleton30):
            local_joints_rot = self.skeleton.to_SOMASkeleton77(local_joints_rot)
        local_joints_rot = matrix_to_axis_angle(local_joints_rot)

        root_positions = self.global_joints_positions[:, self.skeleton.root_idx]
        output = {
            "type": self.name,
            "frame_indices": self.frame_indices,
            "local_joints_rot": local_joints_rot,
            "root_positions": root_positions,
            "smooth_root_2d": self.smooth_root_2d,
        }
        if not hasattr(self.__class__, "joint_names"):
            # save the joint_names for this base class
            # but not for children
            output["joint_names"] = self.joint_names
        return output

    def to(
        self,
        device: Optional[Union[str, torch.device]] = None,
        dtype: Optional[torch.dtype] = None,
    ) -> "EndEffectorConstraintSet":
        self.frame_indices = _tensor_to(self.frame_indices, device, dtype)
        self.pos_indices = _tensor_to(self.pos_indices, device, dtype)
        self.rot_indices = _tensor_to(self.rot_indices, device, dtype)
        self.root_y_pos = _tensor_to(self.root_y_pos, device, dtype)
        self.global_joints_positions = _tensor_to(self.global_joints_positions, device, dtype)
        self.global_root_heading = _tensor_to(self.global_root_heading, device, dtype)
        self.global_joints_rots = _tensor_to(self.global_joints_rots, device, dtype)
        self.smooth_root_2d = _tensor_to(self.smooth_root_2d, device, dtype)
        if device is not None and hasattr(self.skeleton, "to"):
            self.skeleton = self.skeleton.to(device)
        return self

    @classmethod
    def from_dict(cls, skeleton: SkeletonBase, dico: dict) -> "EndEffectorConstraintSet":
        """Build an EndEffectorConstraintSet from a dict (e.g. loaded from JSON)."""
        frame_indices = torch.tensor(dico["frame_indices"])
        device = skeleton.device if hasattr(skeleton, "device") else "cpu"
        local_rot = torch.tensor(dico["local_joints_rot"], device=device)
        local_rot_mats = axis_angle_to_matrix(local_rot)
        local_rot_mats = _convert_constraint_local_rots_to_skeleton(local_rot_mats, skeleton)
        global_joints_rots, global_joints_positions, _ = skeleton.fk(
            local_rot_mats,
            torch.tensor(dico["root_positions"], device=device),
        )
        smooth_root_2d = None
        if "smooth_root_2d" in dico:
            smooth_root_2d = torch.tensor(dico["smooth_root_2d"], device=device)

        kwargs = {}
        if not hasattr(cls, "joint_names"):
            kwargs["joint_names"] = dico["joint_names"]

        return cls(
            skeleton,
            frame_indices=frame_indices,
            global_joints_positions=global_joints_positions,
            global_joints_rots=global_joints_rots,
            smooth_root_2d=smooth_root_2d,
            **kwargs,
        )


class LeftHandConstraintSet(EndEffectorConstraintSet):
    """End-effector constraint for the left hand only."""

    name = "left-hand"
    joint_names: list[str] = ["LeftHand"]

    def __init__(self, *args, **kwargs: dict):
        super().__init__(*args, joint_names=self.joint_names, **kwargs)


class RightHandConstraintSet(EndEffectorConstraintSet):
    """End-effector constraint for the right hand only."""

    name = "right-hand"
    joint_names: list[str] = ["RightHand"]

    def __init__(self, *args, **kwargs: dict):
        super().__init__(*args, joint_names=self.joint_names, **kwargs)


class LeftFootConstraintSet(EndEffectorConstraintSet):
    """End-effector constraint for the left foot only."""

    name = "left-foot"
    joint_names: list[str] = ["LeftFoot"]

    def __init__(self, *args, **kwargs: dict):
        super().__init__(*args, joint_names=self.joint_names, **kwargs)


class RightFootConstraintSet(EndEffectorConstraintSet):
    """End-effector constraint for the right foot only."""

    name = "right-foot"
    joint_names: list[str] = ["RightFoot"]

    def __init__(self, *args, **kwargs: dict):
        super().__init__(*args, joint_names=self.joint_names, **kwargs)


TYPE_TO_CLASS = {
    "root2d": Root2DConstraintSet,
    "fullbody": FullBodyConstraintSet,
    "left-hand": LeftHandConstraintSet,
    "right-hand": RightHandConstraintSet,
    "left-foot": LeftFootConstraintSet,
    "right-foot": RightFootConstraintSet,
    "end-effector": EndEffectorConstraintSet,
}


def load_constraints_lst(
    path_or_data: str | list,
    skeleton: SkeletonBase,
    device: Optional[Union[str, torch.device]] = None,
    dtype: Optional[torch.dtype] = None,
):
    """Load a list of constraints from JSON path or list of dicts.

    Args:
        path_or_data: Path to constraints.json or list of constraint dicts.
        skeleton: Skeleton instance (used for from_dict).
        device: If set, move all constraint tensors and skeleton to this device.
        dtype: If set, cast constraint tensors to this dtype.
    """
    if isinstance(path_or_data, str):
        saved = load_json(path_or_data)
    else:
        saved = path_or_data

    constraints_lst = []
    for el in saved:
        cls = TYPE_TO_CLASS[el["type"]]
        c = cls.from_dict(skeleton, el)
        if device is not None or dtype is not None:
            c.to(device=device, dtype=dtype)
        constraints_lst.append(c)
    return constraints_lst


def save_constraints_lst(path: str, constraints_lst: list) -> list | None:
    """Save a list of constraint sets to a JSON file.

    Returns None if list is empty.
    """
    if not constraints_lst:
        print("The constraints lst is empty. Skip saving")
        return

    to_save = []

    def tensor_to_list(obj):
        """Recursively convert tensors to lists for JSON serialization."""
        if isinstance(obj, Tensor):
            return obj.cpu().tolist()
        elif isinstance(obj, dict):
            return {k: tensor_to_list(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [tensor_to_list(v) for v in obj]
        else:
            return obj

    for constraint in constraints_lst:
        constraint_info = constraint.get_save_info()
        # Convert all tensors to lists for JSON serialization
        constraint_info = tensor_to_list(constraint_info)
        to_save.append(constraint_info)

    save_json(path, to_save)
    print(f"Saved constraints to {path}")
    return to_save
