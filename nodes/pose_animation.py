"""Deterministic evaluator for Pose Studio sparse animation clips.

The browser stores local bone rotations as quaternions and the legacy render
path consumes Euler XYZ degrees.  This module mirrors the JavaScript evaluator
so workflows can render long clips without uploading hundreds of base64 PNGs.
"""

from __future__ import annotations

import copy
import math
from typing import Any, Dict, Iterable, List, Mapping, Sequence


MODEL_ROTATION_TRACK = "@modelRotation"
MIN_FRAME_COUNT = 2
MAX_FRAME_COUNT = 600
INTERPOLATIONS = {"hold", "linear", "easeIn", "easeOut", "easeInOut", "smooth"}


def _finite(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def normalize_quaternion(value: Any) -> List[float]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) < 4:
        return [0.0, 0.0, 0.0, 1.0]
    quaternion = [_finite(component) for component in value[:4]]
    length = math.sqrt(sum(component * component for component in quaternion))
    if length < 1e-10:
        return [0.0, 0.0, 0.0, 1.0]
    return [component / length for component in quaternion]


def euler_degrees_to_quaternion(value: Any) -> List[float]:
    euler = value if isinstance(value, Sequence) and not isinstance(value, (str, bytes)) else [0, 0, 0]
    padded = list(euler[:3]) + [0, 0, 0]
    x, y, z = (_finite(padded[index]) * math.pi / 360.0 for index in range(3))
    c1, c2, c3 = math.cos(x), math.cos(y), math.cos(z)
    s1, s2, s3 = math.sin(x), math.sin(y), math.sin(z)
    return normalize_quaternion([
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    ])


def quaternion_to_euler_degrees(value: Any) -> List[float]:
    x, y, z, w = normalize_quaternion(value)
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z

    m11 = 1.0 - 2.0 * (yy + zz)
    m12 = 2.0 * (xy - wz)
    m13 = 2.0 * (xz + wy)
    m22 = 1.0 - 2.0 * (xx + zz)
    m23 = 2.0 * (yz - wx)
    m32 = 2.0 * (yz + wx)
    m33 = 1.0 - 2.0 * (xx + yy)

    ey = math.asin(_clamp(m13, -1.0, 1.0))
    if abs(m13) < 0.9999999:
        ex = math.atan2(-m23, m33)
        ez = math.atan2(-m12, m11)
    else:
        ex = math.atan2(m32, m22)
        ez = 0.0
    scale = 180.0 / math.pi
    result = [ex * scale, ey * scale, ez * scale]
    return [0.0 if abs(component) < 1e-10 else component for component in result]


def slerp_quaternion(a_value: Any, b_value: Any, t_value: Any) -> List[float]:
    a = normalize_quaternion(a_value)
    b = normalize_quaternion(b_value)
    dot = sum(a[index] * b[index] for index in range(4))
    if dot < 0.0:
        b = [-component for component in b]
        dot = -dot
    t = _clamp(_finite(t_value), 0.0, 1.0)
    if dot > 0.9995:
        return normalize_quaternion([a[index] + (b[index] - a[index]) * t for index in range(4)])
    theta_zero = math.acos(_clamp(dot, -1.0, 1.0))
    sin_theta_zero = math.sin(theta_zero)
    if abs(sin_theta_zero) < 1e-8:
        return a
    theta = theta_zero * t
    scale_a = math.sin(theta_zero - theta) / sin_theta_zero
    scale_b = math.sin(theta) / sin_theta_zero
    return normalize_quaternion([a[index] * scale_a + b[index] * scale_b for index in range(4)])


def apply_interpolation(t_value: Any, interpolation: str = "linear") -> float:
    t = _clamp(_finite(t_value), 0.0, 1.0)
    if interpolation == "hold":
        return 0.0
    if interpolation == "easeIn":
        return t * t * t
    if interpolation == "easeOut":
        return 1.0 - (1.0 - t) ** 3
    if interpolation == "easeInOut":
        return 4.0 * t * t * t if t < 0.5 else 1.0 - ((-2.0 * t + 2.0) ** 3) / 2.0
    if interpolation == "smooth":
        return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
    return t


def _pose_track_euler(pose: Mapping[str, Any], track_name: str) -> List[float]:
    if track_name == MODEL_ROTATION_TRACK:
        raw = pose.get("modelRotation", [0, 0, 0])
    else:
        bones = pose.get("bones", {})
        raw = bones.get(track_name, [0, 0, 0]) if isinstance(bones, Mapping) else [0, 0, 0]
    values = list(raw[:3]) if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes)) else []
    values += [0.0] * (3 - len(values))
    return [_finite(component) for component in values[:3]]


def _normalize_keys(source: Any, last_frame: int) -> List[Dict[str, Any]]:
    if isinstance(source, Mapping):
        source = source.get("keys", source.get("keyframes", []))
    if not isinstance(source, Iterable) or isinstance(source, (str, bytes, Mapping)):
        return []
    by_frame: Dict[int, Dict[str, Any]] = {}
    for raw in source:
        if not isinstance(raw, Mapping):
            continue
        try:
            raw_frame = float(raw.get("frame"))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(raw_frame):
            continue
        value = raw.get("value", raw.get("rotation"))
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)) and len(value) == 3:
            value = euler_degrees_to_quaternion(value)
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) < 4:
            continue
        frame = int(_clamp(round(raw_frame), 0, last_frame))
        interpolation = raw.get("interpolation", "linear")
        if interpolation not in INTERPOLATIONS:
            interpolation = "linear"
        by_frame[frame] = {
            "frame": frame,
            "value": normalize_quaternion(value),
            "interpolation": interpolation,
        }
    return sorted(by_frame.values(), key=lambda key: key["frame"])


def normalize_animation_state(source: Any, fallback_pose: Any = None) -> Dict[str, Any]:
    raw = source if isinstance(source, Mapping) else {}
    frame_count = int(_clamp(round(_finite(raw.get("frameCount", raw.get("frame_count", 48)), 48)), MIN_FRAME_COUNT, MAX_FRAME_COUNT))
    duration = _clamp(_finite(raw.get("duration", raw.get("duration_seconds", 2.0)), 2.0), 0.1, 600.0)
    base_pose = copy.deepcopy(raw.get("basePose", raw.get("base_pose", fallback_pose or {})))
    if not isinstance(base_pose, dict):
        base_pose = {}
    if not isinstance(base_pose.get("bones"), dict):
        base_pose["bones"] = {}
    if not isinstance(base_pose.get("modelRotation"), list):
        base_pose["modelRotation"] = [0.0, 0.0, 0.0]

    raw_tracks = raw.get("tracks", {})
    if isinstance(raw_tracks, Mapping) and isinstance(raw_tracks.get("bones"), Mapping):
        merged_tracks = dict(raw_tracks["bones"])
        if isinstance(raw_tracks.get("model"), Mapping):
            merged_tracks.update(raw_tracks["model"])
        raw_tracks = merged_tracks
    tracks: Dict[str, Dict[str, Any]] = {}
    if isinstance(raw_tracks, Mapping):
        for track_name, raw_track in raw_tracks.items():
            keys = _normalize_keys(raw_track, frame_count - 1)
            if keys:
                tracks[str(track_name)] = {"valueType": "quaternion", "keys": keys}

    return {
        "schemaVersion": 1,
        "frameCount": frame_count,
        "duration": duration,
        "basePose": base_pose,
        "tracks": tracks,
    }


def _evaluate_track(state: Mapping[str, Any], track_name: str, frame: int) -> List[float]:
    keys = state.get("tracks", {}).get(track_name, {}).get("keys", [])
    if not keys:
        return euler_degrees_to_quaternion(_pose_track_euler(state.get("basePose", {}), track_name))
    if frame <= keys[0]["frame"]:
        return list(keys[0]["value"])
    if frame >= keys[-1]["frame"]:
        return list(keys[-1]["value"])
    right_index = 1
    while right_index < len(keys) and keys[right_index]["frame"] < frame:
        right_index += 1
    left = keys[right_index - 1]
    right = keys[right_index]
    span = max(1, right["frame"] - left["frame"])
    t = apply_interpolation((frame - left["frame"]) / span, left["interpolation"])
    return slerp_quaternion(left["value"], right["value"], t)


def evaluate_animation_frame(state: Mapping[str, Any], frame_value: Any) -> Dict[str, Any]:
    frame = int(_clamp(round(_finite(frame_value)), 0, state["frameCount"] - 1))
    pose = copy.deepcopy(state.get("basePose", {}))
    if not isinstance(pose.get("bones"), dict):
        pose["bones"] = {}
    for track_name in state.get("tracks", {}):
        euler = quaternion_to_euler_degrees(_evaluate_track(state, track_name, frame))
        if track_name == MODEL_ROTATION_TRACK:
            pose["modelRotation"] = euler
        else:
            pose["bones"][track_name] = euler
    pose.pop("ikEffectorPositions", None)
    pose.pop("poleTargetPositions", None)
    pose.pop("hipBonePosition", None)
    return pose


def sample_animation_frames(source: Any, fallback_pose: Any = None) -> List[Dict[str, Any]]:
    state = normalize_animation_state(source, fallback_pose)
    return [evaluate_animation_frame(state, frame) for frame in range(state["frameCount"])]

