"""Pose capture and animation caches shared by HTTP and graph execution."""
import json
import os
import tempfile
from ..shared.paths import _vnccs_safe_id, _vnccs_user_data_root, _vnccs_runtime_temp_root

_CAPTURE_CACHE_MAX_IMAGES = 600


_CAPTURE_CACHE_MAX_TOTAL_CHARS = 64 * 1024 * 1024


_POSE_ANIMATION_CACHE_MAX = 24


_POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS = 48 * 1024 * 1024


_POSE_ANIMATION_CACHE_MAX_KEYS = 300_000


_POSE_ANIMATION_CACHE_DIR = os.path.join(_vnccs_user_data_root(), "pose_animation_cache")


_POSE_ANIMATION_LEGACY_CACHE_DIR = os.path.join(_vnccs_runtime_temp_root(), "vnccs_pose_animation_cache")


def _vnccs_validate_capture_payload(data):
    captured_images = data.get("captured_images", [])
    lighting_prompts = data.get("lighting_prompts", [])
    if not isinstance(captured_images, list):
        raise ValueError("captured_images must be a list")
    if len(captured_images) > _CAPTURE_CACHE_MAX_IMAGES:
        raise ValueError(f"captured_images limit is {_CAPTURE_CACHE_MAX_IMAGES}")
    total_chars = 0
    for image in captured_images:
        if not isinstance(image, str):
            raise ValueError("captured_images entries must be strings")
        total_chars += len(image)
        if total_chars > _CAPTURE_CACHE_MAX_TOTAL_CHARS:
            raise ValueError("captured_images payload is too large")
    if not isinstance(lighting_prompts, list):
        lighting_prompts = []
    lighting_prompts = [str(prompt)[:4096] for prompt in lighting_prompts[:_CAPTURE_CACHE_MAX_IMAGES]]
    return captured_images, lighting_prompts


def _vnccs_validate_pose_animation_payload(data):
    animation = data.get("animation")
    if not isinstance(animation, dict):
        raise ValueError("animation must be an object")
    total_keys = 0
    animations = [animation]
    character_animations = animation.get("characterAnimations", [])
    if character_animations is not None:
        if not isinstance(character_animations, list) or len(character_animations) > 3:
            raise ValueError("animation.characterAnimations must contain at most three entries")
        for entry in character_animations:
            nested = entry.get("animation") if isinstance(entry, dict) else None
            if not isinstance(nested, dict):
                raise ValueError("character animation must be an object")
            animations.append(nested)
    for clip in animations:
        tracks = clip.get("tracks", {})
        if not isinstance(tracks, dict):
            raise ValueError("animation.tracks must be an object")
        for track in tracks.values():
            if not isinstance(track, dict):
                continue
            keys = track.get("keys", [])
            if not isinstance(keys, list):
                raise ValueError("animation track keys must be a list")
            total_keys += len(keys)
            if total_keys > _POSE_ANIMATION_CACHE_MAX_KEYS:
                raise ValueError(f"animation key limit is {_POSE_ANIMATION_CACHE_MAX_KEYS}")
    raw = json.dumps(animation, ensure_ascii=False, separators=(",", ":"))
    if len(raw) > _POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS:
        raise ValueError("animation payload is too large")
    try:
        revision = max(0, int(data.get("revision", 0) or 0))
    except (TypeError, ValueError):
        revision = 0
    return animation, revision


VNCCS_CAPTURE_CACHE = {}


_CAPTURE_CACHE_MAX = 10


def vnccs_get_capture_cache(capture_id):
    capture_id = _vnccs_safe_id(capture_id, "capture")
    entry = VNCCS_CAPTURE_CACHE.pop(capture_id, None)
    if entry is not None:
        VNCCS_CAPTURE_CACHE[capture_id] = entry
    return entry


VNCCS_POSE_ANIMATION_CACHE = {}


def _vnccs_pose_animation_cache_path(animation_id):
    safe_id = _vnccs_safe_id(animation_id, "pose_animation")
    return os.path.join(_POSE_ANIMATION_CACHE_DIR, f"{safe_id}.json")


def _vnccs_write_pose_animation_cache_file(animation_id, entry):
    os.makedirs(_POSE_ANIMATION_CACHE_DIR, exist_ok=True)
    path = _vnccs_pose_animation_cache_path(animation_id)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=os.path.dirname(path),
                                         prefix="cache_", delete=False) as handle:
            temp_path = handle.name
            json.dump(entry, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


def _vnccs_read_pose_animation_cache_file(animation_id):
    path = _vnccs_pose_animation_cache_path(animation_id)
    from_legacy = False
    if not os.path.exists(path):
        legacy = os.path.join(_POSE_ANIMATION_LEGACY_CACHE_DIR, os.path.basename(path))
        if not os.path.exists(legacy):
            return None
        path = legacy
        from_legacy = True
    with open(path, "r", encoding="utf-8") as handle:
        entry = json.load(handle)
    if from_legacy:
        _vnccs_write_pose_animation_cache_file(animation_id, entry)
    try:
        os.utime(path, None)
    except OSError:
        pass
    return entry if isinstance(entry, dict) else None


def vnccs_get_pose_animation_cache(animation_id):
    animation_id = _vnccs_safe_id(animation_id, "pose_animation")
    entry = VNCCS_POSE_ANIMATION_CACHE.get(animation_id)
    if entry is None:
        entry = _vnccs_read_pose_animation_cache_file(animation_id)
    if not isinstance(entry, dict):
        return None
    if animation_id in VNCCS_POSE_ANIMATION_CACHE:
        del VNCCS_POSE_ANIMATION_CACHE[animation_id]
    VNCCS_POSE_ANIMATION_CACHE[animation_id] = entry
    while len(VNCCS_POSE_ANIMATION_CACHE) > _POSE_ANIMATION_CACHE_MAX:
        oldest = next(iter(VNCCS_POSE_ANIMATION_CACHE))
        del VNCCS_POSE_ANIMATION_CACHE[oldest]
    return entry
