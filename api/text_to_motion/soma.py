"""Pose conversion between the Pose Studio mannequin and Kimodo's SOMA skeleton.

Pure numpy, no torch or Kimodo import, so it is unit-testable in CI.

Pose Studio sends world-space landmarks of the mannequin's current pose (MakeHuman /
UE-style bone names). ``solve_start_pose`` turns them into a full-body SOMA keyframe
(global joint positions and rotations) that Kimodo uses as its frame-0 constraint.
``soma_motion`` wraps the generated SOMA motion as a ``SourceMotion`` that the shared
transform code places back on the mannequin.

Kimodo generates in a canonical frame (heading 0 = facing +Z, meters, floor at y=0),
Pose Studio keeps whatever model rotation and scene units the mannequin has.
"""

from __future__ import annotations

import numpy as np

from .transform import (
    FrameTransform,
    SourceMotion,
    align_vectors,
    heading_angle,
    mannequin_leg_length,
    missing_keypoints,
    triad_rotation,
    yaw_matrix,
)


_EPS = 1e-8

# Direction-driven joints: SOMA joint -> (SOMA child giving the rest direction,
# Pose Studio landmark the direction starts at, landmark it points to).
_SWING_RULES = {
    "Spine1": ("Spine2", "spine_01", "spine_02"),
    "Spine2": ("Chest", "spine_02", "spine_03"),
    "Neck1": ("Neck2", "neck_01", "head"),
    "Neck2": ("Head", "neck_01", "head"),
}
for _side, _soma in (("l", "Left"), ("r", "Right")):
    _SWING_RULES.update({
        f"{_soma}Shoulder": (f"{_soma}Arm", f"clavicle_{_side}", f"upperarm_{_side}"),
        f"{_soma}Arm": (f"{_soma}ForeArm", f"upperarm_{_side}", f"lowerarm_{_side}"),
        f"{_soma}ForeArm": (f"{_soma}Hand", f"lowerarm_{_side}", f"hand_{_side}"),
        f"{_soma}Leg": (f"{_soma}Shin", f"thigh_{_side}", f"calf_{_side}"),
        f"{_soma}Shin": (f"{_soma}Foot", f"calf_{_side}", f"foot_{_side}"),
        f"{_soma}Foot": (f"{_soma}ToeBase", f"foot_{_side}", f"ball_{_side}"),
        f"{_soma}HandThumb1": (f"{_soma}HandThumb2", f"thumb_01_{_side}", f"thumb_02_{_side}"),
        f"{_soma}HandThumb2": (f"{_soma}HandThumb3", f"thumb_02_{_side}", f"thumb_03_{_side}"),
    })
    # SOMA fingers have a metacarpal joint (Index1) that the mannequin does not,
    # so the mannequin's first phalanx maps to SOMA's second finger joint.
    for _finger in ("Index", "Middle", "Ring", "Pinky"):
        _lower = _finger.lower()
        _SWING_RULES[f"{_soma}Hand{_finger}2"] = (
            f"{_soma}Hand{_finger}3", f"{_lower}_01_{_side}", f"{_lower}_02_{_side}",
        )
        _SWING_RULES[f"{_soma}Hand{_finger}3"] = (
            f"{_soma}Hand{_finger}4", f"{_lower}_02_{_side}", f"{_lower}_03_{_side}",
        )

class SomaSkeleton:
    """Joint names, parents and rest (identity-rotation) global positions of a SOMA skeleton."""

    def __init__(self, joint_names, parents, rest_positions):
        self.joint_names = [str(name) for name in joint_names]
        self.parents = [int(parent) for parent in parents]
        self.rest = np.asarray(rest_positions, dtype=np.float64).reshape(len(self.joint_names), 3)
        self.index = {name: i for i, name in enumerate(self.joint_names)}
        if len(self.parents) != len(self.joint_names):
            raise ValueError("joint parents do not match joint names")
        roots = [i for i, parent in enumerate(self.parents) if parent < 0]
        if len(roots) != 1:
            raise ValueError("SOMA skeleton must have exactly one root joint")
        self.root = roots[0]
        self.order = self._topological_order()

    def _topological_order(self):
        children = {i: [] for i in range(len(self.parents))}
        for i, parent in enumerate(self.parents):
            if parent >= 0:
                children[parent].append(i)
        order, stack = [], [self.root]
        while stack:
            joint = stack.pop()
            order.append(joint)
            stack.extend(reversed(children[joint]))
        if len(order) != len(self.parents):
            raise ValueError("SOMA skeleton hierarchy is not a tree")
        return order

    def rest_vector(self, start: str, end: str):
        if start not in self.index or end not in self.index:
            return None
        return self.rest[self.index[end]] - self.rest[self.index[start]]

    def leg_length(self) -> float:
        lengths = []
        for side in ("Left", "Right"):
            thigh = self.rest_vector(f"{side}Leg", f"{side}Shin")
            shin = self.rest_vector(f"{side}Shin", f"{side}Foot")
            if thigh is not None and shin is not None:
                lengths.append(float(np.linalg.norm(thigh) + np.linalg.norm(shin)))
        return float(np.mean(lengths)) if lengths else 0.0

    def forward_kinematics(self, global_rotations, root_position=None):
        positions = np.zeros_like(self.rest)
        positions[self.root] = self.rest[self.root] if root_position is None else root_position
        for joint in self.order:
            parent = self.parents[joint]
            if parent < 0:
                continue
            offset = self.rest[joint] - self.rest[parent]
            positions[joint] = positions[parent] + global_rotations[parent] @ offset
        return positions


def frame_transform_for(keypoints, skeleton: SomaSkeleton) -> FrameTransform:
    """Transform between Kimodo's canonical frame and the mannequin's world frame."""
    missing = missing_keypoints(keypoints)
    if missing:
        raise ValueError(f"start pose is missing landmarks: {', '.join(missing)}")
    soma_leg = skeleton.leg_length()
    pose_leg = mannequin_leg_length(keypoints)
    if soma_leg <= _EPS or pose_leg <= _EPS:
        raise ValueError("cannot measure leg length for scaling the start pose")
    return FrameTransform(
        heading=heading_angle(keypoints["thigh_r"], keypoints["thigh_l"]),
        scale=pose_leg / soma_leg,
        origin=np.zeros(3),
        anchor=np.array([keypoints["pelvis"][0], 0.0, keypoints["pelvis"][2]]),
    )


def _to_canonical(point, transform: FrameTransform):
    return ((np.asarray(point) - transform.anchor) / transform.scale) @ yaw_matrix(transform.heading)


# Torso joints follow how far the mannequin's torso moved away from its own rest
# pose: both rest poses stand upright, but their spine landmarks sit differently
# (the mannequin's spine_01 is behind the pelvis). Limbs use absolute directions
# instead, because the rest poses differ there (A-pose versus T-pose).
_REST_RELATIVE_JOINTS = frozenset({"Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2"})


def _canonical_points(keypoints, skeleton):
    transform = frame_transform_for(keypoints, skeleton)
    return {name: _to_canonical(point, transform) for name, point in keypoints.items()}, transform


def solve_start_pose(skeleton: SomaSkeleton, keypoints, head_axes=None, rest_keypoints=None):
    """Solve a SOMA full-body pose that matches the mannequin's current pose.

    ``keypoints`` are the mannequin's current world landmarks, ``rest_keypoints``
    (optional) the same landmarks in its rest pose, and ``head_axes`` (optional) the
    world up/forward axes of its head relative to rest.

    Returns ``(positions [J,3], rotations [J,3,3], transform)``. Positions and rotations
    are in Kimodo's canonical frame with the lowest joint on the floor; ``transform``
    maps canonical points back into the Pose Studio world frame.
    """
    canonical, transform = _canonical_points(keypoints, skeleton)
    rest = None
    if rest_keypoints:
        try:
            rest, _ = _canonical_points(rest_keypoints, skeleton)
        except ValueError:
            rest = None

    def vector(points, start, end):
        if points is None or start not in points or end not in points:
            return None
        return points[end] - points[start]

    head = None
    if isinstance(head_axes, dict):
        up = head_axes.get("up")
        forward = head_axes.get("forward")
        if up is not None and forward is not None:
            # Row vector @ yaw(h) == yaw(-h) @ column vector: world -> canonical.
            to_canonical = yaw_matrix(transform.heading)
            head = (
                np.asarray(up, dtype=np.float64) @ to_canonical,
                np.asarray(forward, dtype=np.float64) @ to_canonical,
            )

    # joint -> (primary (SOMA, landmarks), [secondary (SOMA, landmarks), ...fallbacks])
    triads = {
        # The hip line is always well defined; the spine only settles the pelvis tilt.
        "Hips": ((("RightLeg", "LeftLeg"), ("thigh_r", "thigh_l")), [
            (("Hips", "Spine1"), ("pelvis", "spine_01")),
            (("Hips", "Neck1"), ("pelvis", "neck_01")),
        ]),
        "Chest": ((("Chest", "Neck1"), ("spine_03", "neck_01")), [
            (("RightArm", "LeftArm"), ("upperarm_r", "upperarm_l")),
        ]),
    }
    for side, soma in (("l", "Left"), ("r", "Right")):
        triads[f"{soma}Hand"] = (((f"{soma}Hand", f"{soma}HandMiddle2"), (f"hand_{side}", f"middle_01_{side}")), [
            ((f"{soma}HandPinky2", f"{soma}HandIndex2"), (f"pinky_01_{side}", f"index_01_{side}")),
        ])

    rotations = np.tile(np.eye(3), (len(skeleton.joint_names), 1, 1))
    for joint in skeleton.order:
        name = skeleton.joint_names[joint]
        parent = skeleton.parents[joint]
        parent_rotation = rotations[parent] if parent >= 0 else np.eye(3)
        rest_relative = rest is not None and name in _REST_RELATIVE_JOINTS
        rotation = None

        if name == "Head" and head is not None:
            rotation = triad_rotation(np.array([0.0, 1.0, 0.0]), np.array([0.0, 0.0, 1.0]), head[0], head[1])
        elif name in triads:
            (soma_primary, landmark_primary), secondaries = triads[name]
            current_p = vector(canonical, *landmark_primary)
            # Rest-relative: the mannequin's own rest pose replaces SOMA's rest vectors,
            # which makes the result the mannequin's rotation away from rest.
            from_p = vector(rest, *landmark_primary) if rest_relative else skeleton.rest_vector(*soma_primary)
            for soma_secondary, landmark_secondary in secondaries:
                current_s = vector(canonical, *landmark_secondary)
                from_s = vector(rest, *landmark_secondary) if rest_relative else skeleton.rest_vector(*soma_secondary)
                if rotation is None and all(v is not None for v in (from_p, from_s, current_p, current_s)):
                    rotation = triad_rotation(from_p, from_s, current_p, current_s)
            soma_p = skeleton.rest_vector(*soma_primary)
            if rotation is None and soma_p is not None and current_p is not None:
                rotation = align_vectors(parent_rotation @ soma_p, current_p) @ parent_rotation
        elif name in _SWING_RULES:
            child, start, end = _SWING_RULES[name]
            rest_direction = skeleton.rest_vector(name, child)
            target_direction = vector(canonical, start, end)
            rest_landmark = vector(rest, start, end) if rest_relative else None
            if rest_direction is not None and target_direction is not None and rest_landmark is not None:
                target_direction = align_vectors(rest_landmark, target_direction) @ rest_direction
            if rest_direction is not None and target_direction is not None:
                rotation = align_vectors(parent_rotation @ rest_direction, target_direction) @ parent_rotation

        rotations[joint] = parent_rotation if rotation is None else rotation

    positions = skeleton.forward_kinematics(rotations, root_position=np.zeros(3))
    positions[:, 1] -= positions[:, 1].min()
    # The canonical root maps back onto the mannequin pelvis.
    transform = FrameTransform(
        heading=transform.heading,
        scale=transform.scale,
        origin=positions[skeleton.root].copy(),
        anchor=np.asarray(keypoints["pelvis"], dtype=np.float64),
    )
    return positions, rotations, transform


# Pose Studio motion keys -> SOMA joints.
MOTION_JOINTS = {
    "Hips": "Hips", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Chest",
    "Neck": "Neck1", "Head": "Head",
    "LeftUpLeg": "LeftLeg", "LeftLeg": "LeftShin", "LeftFoot": "LeftFoot", "LeftToeBase": "LeftToeBase",
    "RightUpLeg": "RightLeg", "RightLeg": "RightShin", "RightFoot": "RightFoot", "RightToeBase": "RightToeBase",
}
for _soma in ("Left", "Right"):
    for _part in ("Shoulder", "Arm", "ForeArm", "Hand"):
        MOTION_JOINTS[f"{_soma}{_part}"] = f"{_soma}{_part}"

# Pose Studio bones -> SOMA joints whose world rotation change the browser applies.
MOTION_ROTATIONS = {
    "head": "Head",
    "hand_l": "LeftHand",
    "hand_r": "RightHand",
    "foot_l": "LeftFoot",
    "foot_r": "RightFoot",
}


def soma_motion(skeleton: SomaSkeleton, posed_joints, global_rotations, fps: float) -> SourceMotion:
    """Wrap Kimodo output ([T,J,3] positions, [T,J,3,3] rotations, optional batch dim)."""
    positions = np.asarray(posed_joints, dtype=np.float64)
    rotations = None if global_rotations is None else np.asarray(global_rotations, dtype=np.float64)
    if positions.ndim == 4:
        positions = positions[0]
    if rotations is not None and rotations.ndim == 5:
        rotations = rotations[0]
    if positions.ndim != 3 or positions.shape[1:] != (len(skeleton.joint_names), 3):
        raise ValueError("unexpected Kimodo motion shape")
    if rotations is not None and rotations.shape != positions.shape[:2] + (3, 3):
        rotations = None
    return SourceMotion(
        fps=fps,
        joint_names=list(skeleton.joint_names),
        positions=positions,
        rotations=rotations,
        joint_map=dict(MOTION_JOINTS),
        rotation_map=dict(MOTION_ROTATIONS),
        hips=("RightLeg", "LeftLeg"),
        legs=(("RightLeg", "RightShin", "RightFoot"), ("LeftLeg", "LeftShin", "LeftFoot")),
        root=skeleton.joint_names[skeleton.root],
    )
