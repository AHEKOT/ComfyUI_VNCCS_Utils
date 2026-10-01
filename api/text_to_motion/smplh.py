"""SMPL-H skeleton description (52 joints: 22 body + 2 x 15 finger joints).

Shared by every backend that outputs SMPL / SMPL-H joints (HY-Motion today). SMPL-H
has no separate toe and eye joints and fewer spine joints than the mannequin; joints
it lacks keep the mannequin's start pose in the browser.
"""

from __future__ import annotations

import numpy as np

from .transform import SourceMotion, global_rotations_from_local


BODY_JOINTS = [
    "Pelvis", "L_Hip", "R_Hip", "Spine1", "L_Knee", "R_Knee", "Spine2", "L_Ankle", "R_Ankle",
    "Spine3", "L_Foot", "R_Foot", "Neck", "L_Collar", "R_Collar", "Head",
    "L_Shoulder", "R_Shoulder", "L_Elbow", "R_Elbow", "L_Wrist", "R_Wrist",
]
BODY_PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19]

_FINGERS = ("Index", "Middle", "Pinky", "Ring", "Thumb")
JOINT_NAMES = list(BODY_JOINTS)
PARENTS = list(BODY_PARENTS)
for _side, _wrist in (("L", 20), ("R", 21)):
    for _finger in _FINGERS:
        for _segment in (1, 2, 3):
            JOINT_NAMES.append(f"{_side}_{_finger}{_segment}")
            PARENTS.append(_wrist if _segment == 1 else len(PARENTS) - 1)

# Pose Studio motion keys -> SMPL-H joints. SMPL-H "Foot" is the ball of the foot.
MOTION_JOINTS = {
    "Hips": "Pelvis", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Spine3",
    "Neck": "Neck", "Head": "Head",
}
for _side, _name in (("L", "Left"), ("R", "Right")):
    MOTION_JOINTS.update({
        f"{_name}Shoulder": f"{_side}_Collar",
        f"{_name}Arm": f"{_side}_Shoulder",
        f"{_name}ForeArm": f"{_side}_Elbow",
        f"{_name}Hand": f"{_side}_Wrist",
        f"{_name}UpLeg": f"{_side}_Hip",
        f"{_name}Leg": f"{_side}_Knee",
        f"{_name}Foot": f"{_side}_Ankle",
        f"{_name}ToeBase": f"{_side}_Foot",
    })

MOTION_ROTATIONS = {
    "head": "Head",
    "hand_l": "L_Wrist",
    "hand_r": "R_Wrist",
    "foot_l": "L_Ankle",
    "foot_r": "R_Ankle",
}


def smplh_motion(positions, local_rotations=None, fps: float = 30.0, joint_names=None, parents=None) -> SourceMotion:
    """Wrap SMPL-H output: world joints [T,J,3] and optional local rotations [T,J,3,3].

    Motions with only the 22 body joints are accepted; missing finger rotations stay
    identity.
    """
    positions = np.asarray(positions, dtype=np.float64)
    if positions.ndim == 4:
        positions = positions[0]
    names = list(joint_names or JOINT_NAMES)[: positions.shape[1]]
    if positions.ndim != 3 or positions.shape[2] != 3 or len(names) != positions.shape[1]:
        raise ValueError("unexpected SMPL-H motion shape")

    world = None
    if local_rotations is not None:
        local = np.asarray(local_rotations, dtype=np.float64)
        if local.ndim == 5:
            local = local[0]
        chain = list(parents if parents is not None else PARENTS)
        if local.ndim == 4 and local.shape[0] == positions.shape[0] and local.shape[2:] == (3, 3):
            count = min(local.shape[1], len(chain))
            if all(-1 <= p < count for p in chain[:count]):
                world = global_rotations_from_local(local[:, :count], chain[:count])
                if count < len(names):
                    padded = np.tile(np.eye(3), (positions.shape[0], len(names), 1, 1))
                    padded[:, :count] = world
                    world = padded

    return SourceMotion(
        fps=float(fps),
        joint_names=names,
        positions=positions,
        rotations=world,
        joint_map=dict(MOTION_JOINTS),
        rotation_map=dict(MOTION_ROTATIONS),
        hips=("R_Hip", "L_Hip"),
        legs=(("R_Hip", "R_Knee", "R_Ankle"), ("L_Hip", "L_Knee", "L_Ankle")),
        root="Pelvis",
    )
