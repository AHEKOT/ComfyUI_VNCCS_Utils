# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

import torch
from torch import Tensor

from .motion_rep.tools import compute_heading_angle
from .skeleton import SkeletonBase

from .geometry import axis_angle_to_matrix, matrix_to_axis_angle


def create_pairs(tensor_A, tensor_B):
    pairs = torch.stack(
        (
            tensor_A[:, None].expand(-1, len(tensor_B)),
            tensor_B.expand(len(tensor_A), -1),
        ),
        dim=-1,
    ).reshape(-1, 2)
    return pairs


def compute_global_heading(global_joints_positions: Tensor, skeleton: SkeletonBase):
    root_heading_angle = compute_heading_angle(global_joints_positions, skeleton)
    global_root_heading = torch.stack([torch.cos(root_heading_angle), torch.sin(root_heading_angle)], dim=-1)
    return global_root_heading


class Root2DConstraintSet:
    name = "root2d"

    def __init__(
        self,
        skeleton: SkeletonBase,
        frame_indices: Tensor,
        root_2d: Tensor,
        global_root_heading: Optional[Tensor] = None,
        to_crop: bool = False,
    ) -> None:
        self.skeleton = skeleton
        if to_crop:
            root_2d = root_2d[frame_indices]
            if global_root_heading is not None:
                global_root_heading = global_root_heading[frame_indices]
        else:
            assert len(root_2d) == len(frame_indices), "The number of root 2d should be match the number of frames"
            if global_root_heading is not None:
                assert len(global_root_heading) == len(frame_indices), (
                    "The number of global root heading should match the number of frames"
                )
        self.root_2d = root_2d
        self.global_root_heading = global_root_heading
        self.frame_indices = frame_indices

    def update_constraints(self, data_dict: dict, index_dict: dict) -> None:
        data_dict["root_2d"].append(self.root_2d)
        index_dict["root_2d"].append(self.frame_indices)
        if self.global_root_heading is not None:
            # Convert heading angles to [cos, sin] format
            # self.global_root_heading contains angles in radians
            heading_cos_sin = torch.stack(
                [
                    torch.cos(self.global_root_heading),
                    torch.sin(self.global_root_heading),
                ],
                dim=-1,
            )
            data_dict["global_root_heading"].append(heading_cos_sin)
            index_dict["global_root_heading"].append(self.frame_indices)

    def crop_move(self, start: int, end: int):
        mask = (self.frame_indices >= start) & (self.frame_indices < end)
        return (
            Root2DConstraintSet(
                self.skeleton,
                self.frame_indices[mask] - start,
                self.root_2d[mask],
                self.global_root_heading[mask],
            )
            if self.global_root_heading is not None
            else Root2DConstraintSet(self.skeleton, self.frame_indices[mask] - start, self.root_2d[mask])
        )

    def get_save_info(self):
        info = {
            "type": self.name,
            "frame_indices": self.frame_indices,
            "root_2d": self.root_2d,
        }
        if self.global_root_heading is not None:
            info["global_root_heading"] = self.global_root_heading
        return info

    @classmethod
    def from_dict(cls, skeleton: SkeletonBase, dico: dict):
        device = skeleton.device
        root_2d_key = "root_2d" if "root_2d" in dico else "smooth_root_2d"
        return cls(
            skeleton,
            frame_indices=torch.tensor(dico["frame_indices"]),
            root_2d=torch.tensor(dico[root_2d_key], device=device),
            global_root_heading=torch.tensor(dico["global_root_heading"]) if "global_root_heading" in dico else None,
        )


class FullBodyConstraintSet:
    name = "fullbody"

    def __init__(
        self,
        skeleton: SkeletonBase,
        frame_indices: Tensor,
        global_joints_positions: Tensor,
        global_joints_rots: Tensor,
        root_2d: Optional[Tensor] = None,
        to_crop: bool = False,
    ):
        self.skeleton = skeleton
        self.frame_indices = frame_indices

        if to_crop:
            global_joints_positions = global_joints_positions[frame_indices]
            global_joints_rots = global_joints_rots[frame_indices]
            if root_2d is not None:
                root_2d = root_2d[frame_indices]
        else:
            assert len(global_joints_positions) == len(frame_indices), (
                "The number of global positions should be match the number of frames"
            )
            assert len(global_joints_rots) == len(frame_indices), (
                "The number of global joint rotations should be match the number of frames"
            )

            if root_2d is not None:
                assert len(root_2d) == len(frame_indices), (
                    "The number of root 2d (if specified) should be match the number of frames"
                )

        if root_2d is None:
            # substitute root 2d with the real root
            root_2d = global_joints_positions[:, skeleton.root_idx, [0, 2]]

        # root y: from smooth or pelvis is the same
        self.root_y_pos = global_joints_positions[:, skeleton.root_idx, 1]

        self.global_joints_positions = global_joints_positions
        self.global_joints_rots = global_joints_rots
        self.global_root_heading = compute_global_heading(global_joints_positions, skeleton)
        self.root_2d = root_2d

    def update_constraints(self, data_dict, index_dict):
        nbjoints = self.skeleton.nbjoints
        indices_lst = create_pairs(
            self.frame_indices,
            torch.arange(nbjoints),
        )
        data_dict["global_joints_positions"].append(
            self.global_joints_positions.reshape(-1, 3)
        )  # flatten the global positions
        index_dict["global_joints_positions"].append(indices_lst)

        # global rotations are not used here

        # also constraint root 2d to get the same full body
        # maybe keep storing the hips offset, if we smooth it ourselves
        data_dict["root_2d"].append(self.root_2d)
        index_dict["root_2d"].append(self.frame_indices)

        # constraint the y pos of the root
        data_dict["root_y_pos"].append(self.root_y_pos)
        index_dict["root_y_pos"].append(self.frame_indices)

        # constraint the global heading
        data_dict["global_root_heading"].append(self.global_root_heading)
        index_dict["global_root_heading"].append(self.frame_indices)

    def crop_move(self, start: int, end: int):
        mask = (self.frame_indices >= start) & (self.frame_indices < end)
        return FullBodyConstraintSet(
            self.skeleton,
            self.frame_indices[mask] - start,
            self.global_joints_positions[mask],
            self.global_joints_rots[mask],
            self.root_2d[mask],
        )

    def get_save_info(self):
        local_joints_rot = self.skeleton.global_rots_to_local_rots(self.global_joints_rots)
        local_joints_rot = matrix_to_axis_angle(local_joints_rot)

        root_positions = self.global_joints_positions[:, self.skeleton.root_idx]
        return {
            "type": self.name,
            "frame_indices": self.frame_indices,
            "local_joints_rot": local_joints_rot,
            "root_positions": root_positions,
            "root_2d": self.root_2d,
        }

    @classmethod
    def from_dict(cls, skeleton: SkeletonBase, dico: dict):
        frame_indices = torch.tensor(dico["frame_indices"])
        device = skeleton.device
        global_joints_rots, global_joints_positions, _ = skeleton.fk(
            axis_angle_to_matrix(torch.tensor(dico["local_joints_rot"], device=device)),
            torch.tensor(dico["root_positions"], device=device),
        )
        root_2d = None
        if "root_2d" in dico:
            root_2d = torch.tensor(dico["root_2d"], device=device)
        elif "smooth_root_2d" in dico:
            root_2d = torch.tensor(dico["smooth_root_2d"], device=device)

        return cls(
            skeleton,
            frame_indices=frame_indices,
            global_joints_positions=global_joints_positions,
            global_joints_rots=global_joints_rots,
            root_2d=root_2d,
        )


class EndEffectorConstraintSet:
    name = "end-effector"

    def __init__(
        self,
        skeleton: SkeletonBase,
        frame_indices: Tensor,
        global_joints_positions: Tensor,
        global_joints_rots: Tensor,
        root_2d: Optional[Tensor],
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

        if to_crop:
            global_joints_positions = global_joints_positions[frame_indices]
            global_joints_rots = global_joints_rots[frame_indices]
            if root_2d is not None:
                root_2d = root_2d[frame_indices]
        else:
            assert len(global_joints_positions) == len(frame_indices), (
                "The number of global positions should be match the number of frames"
            )
            assert len(global_joints_rots) == len(frame_indices), (
                "The number of global joint rotations should be match the number of frames"
            )
            if root_2d is not None:
                assert len(root_2d) == len(frame_indices), (
                    "The number of root 2d (if specified) should be match the number of frames"
                )

        if root_2d is None:
            # substitute root 2d with the real root
            root_2d = global_joints_positions[:, skeleton.root_idx, [0, 2]]

        # root y: from smooth or pelvis is the same
        self.root_y_pos = global_joints_positions[:, skeleton.root_idx, 1]

        self.global_joints_positions = global_joints_positions
        self.global_root_heading = compute_global_heading(global_joints_positions, skeleton)
        self.global_joints_rots = global_joints_rots
        self.root_2d = root_2d

    def update_constraints(self, data_dict, index_dict):
        crop_frames_indexing = torch.arange(len(self.frame_indices))

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

        # also constraint root 2d to get the same full body
        # maybe keep storing the hips offset, if we smooth it ourselves
        data_dict["root_2d"].append(self.root_2d)
        index_dict["root_2d"].append(self.frame_indices)

        # constraint the y pos of the root
        data_dict["root_y_pos"].append(self.root_y_pos)
        index_dict["root_y_pos"].append(self.frame_indices)

        # constraint the global heading
        data_dict["global_root_heading"].append(self.global_root_heading)
        index_dict["global_root_heading"].append(self.frame_indices)

    def crop_move(self, start: int, end: int):
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
            self.root_2d[mask],
            **kwargs,
        )

    def get_save_info(self):
        local_joints_rot = self.skeleton.global_rots_to_local_rots(self.global_joints_rots)
        local_joints_rot = matrix_to_axis_angle(local_joints_rot)

        root_positions = self.global_joints_positions[:, self.skeleton.root_idx]
        output = {
            "type": self.name,
            "frame_indices": self.frame_indices,
            "local_joints_rot": local_joints_rot,
            "root_positions": root_positions,
            "root_2d": self.root_2d,
        }
        if not hasattr(self.__class__, "joint_names"):
            # save the joint_names for this base class
            # but not for children
            output["joint_names"] = self.joint_names
        return output

    @classmethod
    def from_dict(cls, skeleton: SkeletonBase, dico: dict):
        frame_indices = torch.tensor(dico["frame_indices"])
        device = skeleton.device
        global_joints_rots, global_joints_positions, _ = skeleton.fk(
            axis_angle_to_matrix(torch.tensor(dico["local_joints_rot"], device=device)),
            torch.tensor(dico["root_positions"], device=device),
        )
        root_2d = None
        if "root_2d" in dico:
            root_2d = torch.tensor(dico["root_2d"], device=device)
        elif "smooth_root_2d" in dico:
            root_2d = torch.tensor(dico["smooth_root_2d"], device=device)

        kwargs = {}
        if not hasattr(cls, "joint_names"):
            kwargs["joint_names"] = dico["joint_names"]

        return cls(
            skeleton,
            frame_indices=frame_indices,
            global_joints_positions=global_joints_positions,
            global_joints_rots=global_joints_rots,
            root_2d=root_2d,
            **kwargs,
        )


class LeftHandConstraintSet(EndEffectorConstraintSet):
    name = "left-hand"
    joint_names: list[str] = ["LeftHand", "Hips"]

    def __init__(self, *args, **kwargs: dict):
        super().__init__(*args, joint_names=self.joint_names, **kwargs)


class RightHandConstraintSet(EndEffectorConstraintSet):
    name = "right-hand"
    joint_names: list[str] = ["RightHand", "Hips"]

    def __init__(self, *args, **kwargs: dict):
        super().__init__(*args, joint_names=self.joint_names, **kwargs)


class LeftFootConstraintSet(EndEffectorConstraintSet):
    name = "left-foot"
    joint_names: list[str] = ["LeftFoot", "Hips"]

    def __init__(self, *args, **kwargs: dict):
        super().__init__(*args, joint_names=self.joint_names, **kwargs)


class RightFootConstraintSet(EndEffectorConstraintSet):
    name = "right-foot"
    joint_names: list[str] = ["RightFoot", "Hips"]

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


def load_constraints_lst(path_or_data: str | list, skeleton: SkeletonBase):
    from .tools import load_json

    if isinstance(path_or_data, str):
        saved = load_json(path_or_data)
    else:
        saved = path_or_data

    constraints_lst = []
    for el in saved:
        cls = TYPE_TO_CLASS[el["type"]]
        constraints_lst.append(cls.from_dict(skeleton, el))
    return constraints_lst


def save_constraints_lst(path: str, constraints_lst):
    from .tools import save_json

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
