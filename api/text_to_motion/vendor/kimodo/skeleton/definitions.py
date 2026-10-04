# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Concrete skeleton definitions: SOMA, G1, SMPLX with joint names and hierarchy."""

from pathlib import Path

import numpy as np
import torch

from ..tools import ensure_batched
from .base import SkeletonBase


class SOMASkeleton77(SkeletonBase):
    """High-detail 77-joint SOMA skeleton with full finger and toe chains."""

    name = "somaskel77"

    right_foot_joint_names = [
        "RightFoot",
        "RightToeBase",
        "RightToeEnd",
    ]  # in order of chain
    left_foot_joint_names = [
        "LeftFoot",
        "LeftToeBase",
        "LeftToeEnd",
    ]  # in order of chain
    right_hand_joint_names = [
        "RightHand",
        "RightHandThumb1",
        "RightHandThumb2",
        "RightHandThumb3",
        "RightHandThumbEnd",
        "RightHandIndex1",
        "RightHandIndex2",
        "RightHandIndex3",
        "RightHandIndex4",
        "RightHandIndexEnd",
        "RightHandMiddle1",
        "RightHandMiddle2",
        "RightHandMiddle3",
        "RightHandMiddle4",
        "RightHandMiddleEnd",
        "RightHandRing1",
        "RightHandRing2",
        "RightHandRing3",
        "RightHandRing4",
        "RightHandRingEnd",
        "RightHandPinky1",
        "RightHandPinky2",
        "RightHandPinky3",
        "RightHandPinky4",
        "RightHandPinkyEnd",
    ]  # in order of chain
    left_hand_joint_names = [
        "LeftHand",
        "LeftHandThumb1",
        "LeftHandThumb2",
        "LeftHandThumb3",
        "LeftHandThumbEnd",
        "LeftHandIndex1",
        "LeftHandIndex2",
        "LeftHandIndex3",
        "LeftHandIndex4",
        "LeftHandIndexEnd",
        "LeftHandMiddle1",
        "LeftHandMiddle2",
        "LeftHandMiddle3",
        "LeftHandMiddle4",
        "LeftHandMiddleEnd",
        "LeftHandRing1",
        "LeftHandRing2",
        "LeftHandRing3",
        "LeftHandRing4",
        "LeftHandRingEnd",
        "LeftHandPinky1",
        "LeftHandPinky2",
        "LeftHandPinky3",
        "LeftHandPinky4",
        "LeftHandPinkyEnd",
    ]  # in order of chain

    hip_joint_names = ["RightLeg", "LeftLeg"]  # in order [right, left]

    bone_order_names_with_parents = [
        ("Hips", None),
        ("Spine1", "Hips"),
        ("Spine2", "Spine1"),
        ("Chest", "Spine2"),
        ("Neck1", "Chest"),
        ("Neck2", "Neck1"),
        ("Head", "Neck2"),
        ("HeadEnd", "Head"),
        ("Jaw", "Head"),
        ("LeftEye", "Head"),
        ("RightEye", "Head"),
        ("LeftShoulder", "Chest"),
        ("LeftArm", "LeftShoulder"),
        ("LeftForeArm", "LeftArm"),
        ("LeftHand", "LeftForeArm"),
        ("LeftHandThumb1", "LeftHand"),
        ("LeftHandThumb2", "LeftHandThumb1"),
        ("LeftHandThumb3", "LeftHandThumb2"),
        ("LeftHandThumbEnd", "LeftHandThumb3"),
        ("LeftHandIndex1", "LeftHand"),
        ("LeftHandIndex2", "LeftHandIndex1"),
        ("LeftHandIndex3", "LeftHandIndex2"),
        ("LeftHandIndex4", "LeftHandIndex3"),
        ("LeftHandIndexEnd", "LeftHandIndex4"),
        ("LeftHandMiddle1", "LeftHand"),
        ("LeftHandMiddle2", "LeftHandMiddle1"),
        ("LeftHandMiddle3", "LeftHandMiddle2"),
        ("LeftHandMiddle4", "LeftHandMiddle3"),
        ("LeftHandMiddleEnd", "LeftHandMiddle4"),
        ("LeftHandRing1", "LeftHand"),
        ("LeftHandRing2", "LeftHandRing1"),
        ("LeftHandRing3", "LeftHandRing2"),
        ("LeftHandRing4", "LeftHandRing3"),
        ("LeftHandRingEnd", "LeftHandRing4"),
        ("LeftHandPinky1", "LeftHand"),
        ("LeftHandPinky2", "LeftHandPinky1"),
        ("LeftHandPinky3", "LeftHandPinky2"),
        ("LeftHandPinky4", "LeftHandPinky3"),
        ("LeftHandPinkyEnd", "LeftHandPinky4"),
        ("RightShoulder", "Chest"),
        ("RightArm", "RightShoulder"),
        ("RightForeArm", "RightArm"),
        ("RightHand", "RightForeArm"),
        ("RightHandThumb1", "RightHand"),
        ("RightHandThumb2", "RightHandThumb1"),
        ("RightHandThumb3", "RightHandThumb2"),
        ("RightHandThumbEnd", "RightHandThumb3"),
        ("RightHandIndex1", "RightHand"),
        ("RightHandIndex2", "RightHandIndex1"),
        ("RightHandIndex3", "RightHandIndex2"),
        ("RightHandIndex4", "RightHandIndex3"),
        ("RightHandIndexEnd", "RightHandIndex4"),
        ("RightHandMiddle1", "RightHand"),
        ("RightHandMiddle2", "RightHandMiddle1"),
        ("RightHandMiddle3", "RightHandMiddle2"),
        ("RightHandMiddle4", "RightHandMiddle3"),
        ("RightHandMiddleEnd", "RightHandMiddle4"),
        ("RightHandRing1", "RightHand"),
        ("RightHandRing2", "RightHandRing1"),
        ("RightHandRing3", "RightHandRing2"),
        ("RightHandRing4", "RightHandRing3"),
        ("RightHandRingEnd", "RightHandRing4"),
        ("RightHandPinky1", "RightHand"),
        ("RightHandPinky2", "RightHandPinky1"),
        ("RightHandPinky3", "RightHandPinky2"),
        ("RightHandPinky4", "RightHandPinky3"),
        ("RightHandPinkyEnd", "RightHandPinky4"),
        ("LeftLeg", "Hips"),
        ("LeftShin", "LeftLeg"),
        ("LeftFoot", "LeftShin"),
        ("LeftToeBase", "LeftFoot"),
        ("LeftToeEnd", "LeftToeBase"),
        ("RightLeg", "Hips"),
        ("RightShin", "RightLeg"),
        ("RightFoot", "RightShin"),
        ("RightToeBase", "RightFoot"),
        ("RightToeEnd", "RightToeBase"),
    ]

    @property
    def relaxed_hands_rest_pose(self):
        # lazy loading
        if hasattr(self, "_relaxed_hands_rest_pose"):
            return self._relaxed_hands_rest_pose

        relaxed_hands_pose_path = Path(self.folder) / "relaxed_hands_rest_pose.npy"
        relaxed_hands_rest_pose = torch.from_numpy(np.load(relaxed_hands_pose_path)).squeeze()
        self.register_buffer(
            "_relaxed_hands_rest_pose",
            relaxed_hands_rest_pose,
            persistent=False,
        )
        return self._relaxed_hands_rest_pose


class SOMASkeleton30(SkeletonBase):
    """Compact 30-joint SOMA variant with reduced hand and end-effector detail."""

    name = "somaskel30"

    right_foot_joint_names = [
        "RightFoot",
        "RightToeBase",
    ]  # in order of chain
    left_foot_joint_names = [
        "LeftFoot",
        "LeftToeBase",
    ]  # in order of chain
    right_hand_joint_names = [
        "RightHand",
        "RightHandMiddleEnd",
    ]  # in order of chain
    left_hand_joint_names = [
        "LeftHand",
        "LeftHandMiddleEnd",
    ]  # in order of chain

    hip_joint_names = ["RightLeg", "LeftLeg"]  # in order [right, left]

    bone_order_names_with_parents = [
        ("Hips", None),
        ("Spine1", "Hips"),
        ("Spine2", "Spine1"),
        ("Chest", "Spine2"),
        ("Neck1", "Chest"),
        ("Neck2", "Neck1"),
        ("Head", "Neck2"),
        ("Jaw", "Head"),
        ("LeftEye", "Head"),
        ("RightEye", "Head"),
        ("LeftShoulder", "Chest"),
        ("LeftArm", "LeftShoulder"),
        ("LeftForeArm", "LeftArm"),
        ("LeftHand", "LeftForeArm"),
        ("LeftHandThumbEnd", "LeftHand"),
        ("LeftHandMiddleEnd", "LeftHand"),
        ("RightShoulder", "Chest"),
        ("RightArm", "RightShoulder"),
        ("RightForeArm", "RightArm"),
        ("RightHand", "RightForeArm"),
        ("RightHandThumbEnd", "RightHand"),
        ("RightHandMiddleEnd", "RightHand"),
        ("LeftLeg", "Hips"),
        ("LeftShin", "LeftLeg"),
        ("LeftFoot", "LeftShin"),
        ("LeftToeBase", "LeftFoot"),
        ("RightLeg", "Hips"),
        ("RightShin", "RightLeg"),
        ("RightFoot", "RightShin"),
        ("RightToeBase", "RightFoot"),
    ]

    @property
    def somaskel77(self):
        # lazy loading
        if not hasattr(self, "_somaskel77"):
            self._somaskel77 = SOMASkeleton77()
        return self._somaskel77

    @ensure_batched(local_joint_rots_subset=4)
    def to_SOMASkeleton77(self, local_joint_rots_subset: torch.Tensor):
        # Converting from 30-joint to 77-joint to have relaxed hands

        device = local_joint_rots_subset.device
        nF = len(local_joint_rots_subset)
        local_joint_rots_mats = self.somaskel77.relaxed_hands_rest_pose.clone().to(device).repeat(nF, 1, 1, 1)

        skel_slice = self.get_skel_slice(self.somaskel77)
        local_joint_rots_mats[:, skel_slice] = local_joint_rots_subset
        return local_joint_rots_mats

    @ensure_batched(local_joint_rots_full=4) # [BT, J, 3, 3]
    def from_SOMASkeleton77(self, local_joint_rots_full: torch.Tensor) -> torch.Tensor:
        """Extract the 30-joint subset from 77-joint local rotation data."""
        skel_slice = self.get_skel_slice(self.somaskel77)
        return local_joint_rots_full[:, skel_slice]

    def output_to_SOMASkeleton77(self, output: dict) -> dict:
        """Convert model output dict from somaskel30 to somaskel77.

        Expands local_rot_mats to 77 joints, re-runs FK for global_rot_mats and posed_joints. Foot
        contacts are expanded from 4 channels to 6 (toe-end copies toe-base contact).
        """
        local_rot_mats_77 = self.to_SOMASkeleton77(output["local_rot_mats"])
        root_positions = output["root_positions"]
        global_rot_mats_77, posed_joints_77, _ = self.somaskel77.fk(local_rot_mats_77, root_positions)
        out_77 = dict(output)
        out_77["local_rot_mats"] = local_rot_mats_77
        out_77["global_rot_mats"] = global_rot_mats_77
        out_77["posed_joints"] = posed_joints_77

        if "foot_contacts" in output:
            fc = output["foot_contacts"]  # [..., 4]: [L_heel, L_toe, R_heel, R_toe]
            # -> [..., 6]: [L_heel, L_toe, L_toe_end, R_heel, R_toe, R_toe_end]
            out_77["foot_contacts"] = torch.cat([fc[..., :2], fc[..., 1:2], fc[..., 2:4], fc[..., 3:4]], dim=-1)

        return out_77


class G1Skeleton34(SkeletonBase):
    """Unitree G1 skeleton with 32 articulated joints plus 2 toe endpoints."""

    name = "g1skel34"
    right_foot_joint_names = ["right_ankle_roll_skel", "right_toe_base"]
    left_foot_joint_names = ["left_ankle_roll_skel", "left_toe_base"]
    right_hand_joint_names = ["right_wrist_yaw_skel", "right_hand_roll_skel"]
    left_hand_joint_names = ["left_wrist_yaw_skel", "left_hand_roll_skel"]

    hip_joint_names = [
        "right_hip_pitch_skel",
        "left_hip_pitch_skel",
    ]  # used to calculate root orientation, only need 1 pair of hip joints

    bone_order_names_with_parents = [
        ("pelvis_skel", None),
        ("left_hip_pitch_skel", "pelvis_skel"),
        ("left_hip_roll_skel", "left_hip_pitch_skel"),
        ("left_hip_yaw_skel", "left_hip_roll_skel"),
        ("left_knee_skel", "left_hip_yaw_skel"),
        ("left_ankle_pitch_skel", "left_knee_skel"),
        ("left_ankle_roll_skel", "left_ankle_pitch_skel"),
        ("left_toe_base", "left_ankle_roll_skel"),
        ("right_hip_pitch_skel", "pelvis_skel"),
        ("right_hip_roll_skel", "right_hip_pitch_skel"),
        ("right_hip_yaw_skel", "right_hip_roll_skel"),
        ("right_knee_skel", "right_hip_yaw_skel"),
        ("right_ankle_pitch_skel", "right_knee_skel"),
        ("right_ankle_roll_skel", "right_ankle_pitch_skel"),
        ("right_toe_base", "right_ankle_roll_skel"),
        ("waist_yaw_skel", "pelvis_skel"),
        ("waist_roll_skel", "waist_yaw_skel"),
        ("waist_pitch_skel", "waist_roll_skel"),
        ("left_shoulder_pitch_skel", "waist_pitch_skel"),
        ("left_shoulder_roll_skel", "left_shoulder_pitch_skel"),
        ("left_shoulder_yaw_skel", "left_shoulder_roll_skel"),
        ("left_elbow_skel", "left_shoulder_yaw_skel"),
        ("left_wrist_roll_skel", "left_elbow_skel"),
        ("left_wrist_pitch_skel", "left_wrist_roll_skel"),
        ("left_wrist_yaw_skel", "left_wrist_pitch_skel"),
        ("left_hand_roll_skel", "left_wrist_yaw_skel"),
        ("right_shoulder_pitch_skel", "waist_pitch_skel"),
        ("right_shoulder_roll_skel", "right_shoulder_pitch_skel"),
        ("right_shoulder_yaw_skel", "right_shoulder_roll_skel"),
        ("right_elbow_skel", "right_shoulder_yaw_skel"),
        ("right_wrist_roll_skel", "right_elbow_skel"),
        ("right_wrist_pitch_skel", "right_wrist_roll_skel"),
        ("right_wrist_yaw_skel", "right_wrist_pitch_skel"),
        ("right_hand_roll_skel", "right_wrist_yaw_skel"),
    ]


class SMPLXSkeleton22(SkeletonBase):
    """SMPL-X skeleton with body-only 22 joints."""

    name = "smplx22"
    right_foot_joint_names = ["right_ankle", "right_foot"]  # in order of chain
    left_foot_joint_names = ["left_ankle", "left_foot"]  # in order of chain
    right_hand_joint_names = ["right_wrist"]  # in order of chain
    left_hand_joint_names = ["left_wrist"]  # in order of chain
    hip_joint_names = ["right_hip", "left_hip"]  # in order [right, left]

    bone_order_names_with_parents = [
        ("pelvis", None),
        ("left_hip", "pelvis"),
        ("right_hip", "pelvis"),
        ("spine1", "pelvis"),
        ("left_knee", "left_hip"),
        ("right_knee", "right_hip"),
        ("spine2", "spine1"),
        ("left_ankle", "left_knee"),
        ("right_ankle", "right_knee"),
        ("spine3", "spine2"),
        ("left_foot", "left_ankle"),
        ("right_foot", "right_ankle"),
        ("neck", "spine3"),
        ("left_collar", "spine3"),
        ("right_collar", "spine3"),
        ("head", "neck"),
        ("left_shoulder", "left_collar"),
        ("right_shoulder", "right_collar"),
        ("left_elbow", "left_shoulder"),
        ("right_elbow", "right_shoulder"),
        ("left_wrist", "left_elbow"),
        ("right_wrist", "right_elbow"),
    ]
