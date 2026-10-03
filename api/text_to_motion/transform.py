"""Frame math shared by every text-to-motion backend (pure numpy).

Motion models generate in their own frame: y up, meters, some heading. Pose Studio
keeps the mannequin's model rotation and scene units. ``align_to_start_pose`` builds
the similarity transform (yaw, uniform scale, translation) that places a generated
motion's first frame on the mannequin, and ``motion_to_pose_studio`` converts the
motion into the JSON the browser retargets.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np


_EPS = 1e-8

# Landmarks the browser sends for the mannequin (MakeHuman / UE-style bone names).
REQUIRED_KEYPOINTS = (
    "pelvis", "neck_01", "head",
    "upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r", "hand_l", "hand_r",
    "thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l", "foot_r",
)

# Joints the browser retargets, keyed by the Mixamo-style names Pose Studio's
# keypoint importer understands. Every backend maps its skeleton onto these.
MOTION_JOINT_KEYS = (
    "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
    "LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase",
    "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase",
)

# Pose Studio bones that follow the model's world rotation change since frame 0.
MOTION_ROTATION_BONES = ("head", "hand_l", "hand_r", "foot_l", "foot_r")


@dataclass(frozen=True)
class FrameTransform:
    """Similarity transform: pose_studio = yaw(heading) * (source - origin) * scale + anchor."""

    heading: float
    scale: float
    origin: np.ndarray
    anchor: np.ndarray

    def to_pose_studio(self, points) -> np.ndarray:
        rotated = (np.asarray(points, dtype=np.float64) - self.origin) @ yaw_matrix(self.heading).T
        return rotated * self.scale + self.anchor

    def rotation_to_pose_studio(self, rotations) -> np.ndarray:
        return yaw_matrix(self.heading) @ np.asarray(rotations, dtype=np.float64)


@dataclass
class SourceMotion:
    """A generated motion in the model's own skeleton and frame.

    ``positions`` are world joint positions [T, J, 3] (y up, meters) and
    ``rotations`` world joint rotations [T, J, 3, 3] (or None). ``joint_map`` maps
    MOTION_JOINT_KEYS onto the model's joint names, ``rotation_map`` maps
    MOTION_ROTATION_BONES, and ``hips`` / ``legs`` name the joints used to align the
    first frame with the mannequin.
    """

    fps: float
    joint_names: list
    positions: np.ndarray
    rotations: np.ndarray | None
    joint_map: dict
    rotation_map: dict
    hips: tuple  # (right hip, left hip)
    legs: tuple  # ((hip, knee, ankle) right, (hip, knee, ankle) left)
    root: str
    extra: dict = field(default_factory=dict)

    def index(self, name):
        try:
            return self.joint_names.index(name)
        except ValueError:
            return None


def yaw_matrix(angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]], dtype=np.float64)


def heading_angle(right_hip, left_hip) -> float:
    """Heading of a body from its hip line: 0 faces +Z with the left hip on +X."""
    diff = np.asarray(right_hip, dtype=np.float64) - np.asarray(left_hip, dtype=np.float64)
    return math.atan2(diff[2], -diff[0])


def unit(vector):
    vector = np.asarray(vector, dtype=np.float64)
    norm = float(np.linalg.norm(vector))
    if norm < _EPS or not math.isfinite(norm):
        return None
    return vector / norm


def align_vectors(source, target) -> np.ndarray:
    """Smallest rotation taking direction ``source`` onto direction ``target``."""
    a, b = unit(source), unit(target)
    if a is None or b is None:
        return np.eye(3)
    cross = np.cross(a, b)
    dot = float(np.clip(np.dot(a, b), -1.0, 1.0))
    sin = float(np.linalg.norm(cross))
    if sin < 1e-9:
        if dot > 0:
            return np.eye(3)
        # Opposite directions: rotate 180 degrees about any perpendicular axis.
        helper = np.array([1.0, 0.0, 0.0]) if abs(a[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        axis = unit(np.cross(a, helper))
        return 2.0 * np.outer(axis, axis) - np.eye(3)
    axis = cross / sin
    skew = np.array([
        [0.0, -axis[2], axis[1]],
        [axis[2], 0.0, -axis[0]],
        [-axis[1], axis[0], 0.0],
    ])
    return np.eye(3) + sin * skew + (1.0 - dot) * (skew @ skew)


def _basis(primary, secondary):
    e1 = unit(primary)
    if e1 is None:
        return None
    e2 = unit(np.asarray(secondary, dtype=np.float64) - np.dot(secondary, e1) * e1)
    if e2 is None:
        return None
    return np.column_stack([e1, e2, np.cross(e1, e2)])


def triad_rotation(rest_primary, rest_secondary, target_primary, target_secondary):
    """Rotation matching the primary direction exactly and the secondary as close as possible."""
    rest = _basis(rest_primary, rest_secondary)
    target = _basis(target_primary, target_secondary)
    if rest is None or target is None:
        return None
    return target @ rest.T


def matrix_to_quaternion(matrix) -> list:
    """Rotation matrix -> [x, y, z, w] (three.js order)."""
    m = np.asarray(matrix, dtype=np.float64)
    trace = m[0, 0] + m[1, 1] + m[2, 2]
    if trace > 0:
        s = math.sqrt(trace + 1.0) * 2.0
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    quat = np.array([x, y, z, w])
    quat /= max(float(np.linalg.norm(quat)), _EPS)
    return quat.tolist()


def parse_keypoints(raw) -> dict:
    """Validate a ``{name: [x, y, z]}`` mapping from the browser."""
    if not isinstance(raw, dict):
        raise ValueError("pose landmarks must be an object")
    keypoints = {}
    for name, value in list(raw.items())[:256]:
        if not isinstance(name, str) or not isinstance(value, (list, tuple)) or len(value) < 3:
            continue
        try:
            point = np.array([float(value[0]), float(value[1]), float(value[2])], dtype=np.float64)
        except (TypeError, ValueError):
            continue
        if np.all(np.isfinite(point)):
            keypoints[name[:64]] = point
    return keypoints


def missing_keypoints(keypoints) -> list:
    return [name for name in REQUIRED_KEYPOINTS if name not in keypoints]


def mannequin_leg_length(keypoints) -> float:
    lengths = []
    for side in ("l", "r"):
        points = [keypoints.get(f"{name}_{side}") for name in ("thigh", "calf", "foot")]
        if all(point is not None for point in points):
            lengths.append(float(np.linalg.norm(points[1] - points[0]) + np.linalg.norm(points[2] - points[1])))
    return float(np.mean(lengths)) if lengths else 0.0


def mannequin_heading(keypoints) -> float:
    return heading_angle(keypoints["thigh_r"], keypoints["thigh_l"])


def align_to_start_pose(motion: SourceMotion, keypoints) -> FrameTransform:
    """Place the motion's first frame on the mannequin: same heading, root on the pelvis,
    leg length matched."""
    missing = missing_keypoints(keypoints)
    if missing:
        raise ValueError(f"start pose is missing landmarks: {', '.join(missing)}")
    first = np.asarray(motion.positions[0], dtype=np.float64)

    def at(name):
        index = motion.index(name)
        if index is None:
            raise ValueError(f"motion has no joint named {name}")
        return first[index]

    source_leg = float(np.mean([
        np.linalg.norm(at(knee) - at(hip)) + np.linalg.norm(at(ankle) - at(knee))
        for hip, knee, ankle in motion.legs
    ]))
    pose_leg = mannequin_leg_length(keypoints)
    if source_leg <= _EPS or pose_leg <= _EPS:
        raise ValueError("cannot measure leg length to scale the motion")
    source_heading = heading_angle(at(motion.hips[0]), at(motion.hips[1]))
    return FrameTransform(
        heading=mannequin_heading(keypoints) - source_heading,
        scale=pose_leg / source_leg,
        origin=at(motion.root).copy(),
        anchor=np.asarray(keypoints["pelvis"], dtype=np.float64),
    )


def motion_to_pose_studio(motion: SourceMotion, transform: FrameTransform) -> dict:
    """Convert a SourceMotion into the browser payload (Pose Studio world frame)."""
    positions = np.asarray(motion.positions, dtype=np.float64)
    if positions.ndim != 3 or positions.shape[1:] != (len(motion.joint_names), 3):
        raise ValueError("unexpected motion shape")
    world = transform.to_pose_studio(positions.reshape(-1, 3)).reshape(positions.shape)

    joints = {}
    for key in MOTION_JOINT_KEYS:
        index = motion.index(motion.joint_map.get(key, ""))
        if index is not None:
            joints[key] = np.round(world[:, index], 5).tolist()

    quaternions = {}
    if motion.rotations is not None:
        rotations = np.asarray(motion.rotations, dtype=np.float64)
        for bone in MOTION_ROTATION_BONES:
            index = motion.index(motion.rotation_map.get(bone, ""))
            if index is None:
                continue
            world_rotations = transform.rotation_to_pose_studio(rotations[:, index])
            quaternions[bone] = [np.round(matrix_to_quaternion(matrix), 6).tolist() for matrix in world_rotations]

    return {
        "fps": float(motion.fps),
        "frame_count": int(positions.shape[0]),
        "joints": joints,
        "rotations": quaternions,
    }


def global_rotations_from_local(local_rotations, parents) -> np.ndarray:
    """[T, J, 3, 3] local rotations + parent indices -> world rotations (parents first)."""
    local = np.asarray(local_rotations, dtype=np.float64)
    world = np.empty_like(local)
    for joint, parent in enumerate(parents):
        world[:, joint] = local[:, joint] if parent < 0 else world[:, parent] @ local[:, joint]
    return world
