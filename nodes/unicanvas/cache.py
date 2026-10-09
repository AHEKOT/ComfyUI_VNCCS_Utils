"""Durable UniCanvas state cache, including legacy temp-file migration."""
import json
import os
import tempfile
from ..shared.paths import _vnccs_safe_id, _vnccs_user_data_root, _vnccs_runtime_temp_root

_UNICANVAS_STATE_CACHE_MAX = 10


_UNICANVAS_STATE_CACHE_MAX_TOTAL_CHARS = 96 * 1024 * 1024


_UNICANVAS_STATE_CACHE_DIR = os.path.join(_vnccs_user_data_root(), "unicanvas_state_cache")


_UNICANVAS_LEGACY_STATE_CACHE_DIR = os.path.join(_vnccs_runtime_temp_root(), "vnccs_unicanvas_state_cache")


def _vnccs_validate_unicanvas_state_payload(data):
    state = data.get("state")
    if not isinstance(state, dict):
        raise ValueError("state must be an object")
    layers = state.get("layers", [])
    if not isinstance(layers, list):
        raise ValueError("state.layers must be a list")
    raw = json.dumps(state, ensure_ascii=False)
    if len(raw) > _UNICANVAS_STATE_CACHE_MAX_TOTAL_CHARS:
        raise ValueError("unicanvas state payload is too large")
    return state


VNCCS_UNICANVAS_STATE_CACHE = {}


def _vnccs_unicanvas_state_cache_path(state_id):
    safe_id = _vnccs_safe_id(state_id, "unicanvas")
    return os.path.join(_UNICANVAS_STATE_CACHE_DIR, f"{safe_id}.json")


def _vnccs_write_unicanvas_state_cache_file(state_id, entry):
    os.makedirs(_UNICANVAS_STATE_CACHE_DIR, exist_ok=True)
    path = _vnccs_unicanvas_state_cache_path(state_id)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=os.path.dirname(path),
                                         prefix="cache_", delete=False) as handle:
            temp_path = handle.name
            json.dump(entry, handle, ensure_ascii=False)
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


def _vnccs_read_unicanvas_state_cache_file(state_id):
    path = _unicanvas_state_cache_path(state_id)
    if path is None:
        return None
    from_legacy = path != _vnccs_unicanvas_state_cache_path(state_id)
    with open(path, "r", encoding="utf-8") as handle:
        entry = json.load(handle)
    if from_legacy:
        _vnccs_write_unicanvas_state_cache_file(state_id, entry)
    return entry


def _unicanvas_state_cache_path(state_id):
    name = os.path.basename(_vnccs_unicanvas_state_cache_path(state_id))
    return next((path for directory in (_UNICANVAS_STATE_CACHE_DIR, _UNICANVAS_LEGACY_STATE_CACHE_DIR)
                 if os.path.isfile(path := os.path.join(directory, name))), None)
