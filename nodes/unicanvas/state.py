"""UniCanvas state JSON loading, including the server-side layer cache."""

from __future__ import annotations

import json
import os
import re
from typing import Any

from .paths import _unicanvas_runtime_temp_root, _unicanvas_state_cache_dir


# The upload route (__init__.py) writes to the user directory; the temp directory is the pre-restart-safe location.
_UNICANVAS_STATE_CACHE_DIR = _unicanvas_state_cache_dir()
_UNICANVAS_LEGACY_STATE_CACHE_DIR = os.path.join(_unicanvas_runtime_temp_root(), "vnccs_unicanvas_state_cache")
_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")


def _safe_unicanvas_state_id(value: Any) -> str:
    safe = _SAFE_ID_RE.sub("_", str(value or ""))[:96].strip("_")
    return safe or "unicanvas"


def _read_unicanvas_state_cache(state_id: str) -> dict[str, Any] | None:
    name = f"{_safe_unicanvas_state_id(state_id)}.json"
    path = next((p for p in (os.path.join(directory, name) for directory in (_UNICANVAS_STATE_CACHE_DIR, _UNICANVAS_LEGACY_STATE_CACHE_DIR)) if os.path.exists(p)), None)
    if path is None:
        return None
    with open(path, "r", encoding="utf-8") as handle:
        entry = json.load(handle)
    return entry.get("state") if isinstance(entry, dict) else None


def _merge_unicanvas_state_with_cache(state: dict[str, Any], cached: dict[str, Any]) -> dict[str, Any]:
    cached_layers = cached.get("layers")
    live_layers = state.get("layers")
    if not isinstance(cached_layers, list) or not isinstance(live_layers, list):
        return cached

    cached_by_id = {
        layer.get("id"): layer
        for layer in cached_layers
        if isinstance(layer, dict) and layer.get("id") is not None
    }
    merged = {**cached, **state}
    merged_layers: list[dict[str, Any]] = []
    for live_layer in live_layers:
        if not isinstance(live_layer, dict):
            continue
        cached_layer = cached_by_id.get(live_layer.get("id"))
        if isinstance(cached_layer, dict):
            layer = {**cached_layer, **live_layer}
            if live_layer.get("cached") and not live_layer.get("dataURL"):
                for key in ("crop", "dataURL", "hiresRect", "hiresDataURL"):
                    layer[key] = cached_layer.get(key)
        else:
            layer = dict(live_layer)
        merged_layers.append(layer)
    merged["layers"] = merged_layers
    return merged


def _load_unicanvas_state(unicanvas_state: str) -> dict[str, Any]:
    try:
        state = json.loads(unicanvas_state or "{}")
    except Exception as exc:
        raise ValueError("Invalid UniCanvas state JSON") from exc
    if not isinstance(state, dict):
        raise ValueError("Invalid UniCanvas state")

    state_id = state.get("state_id")
    layers = state.get("layers")
    needs_cache = (
        state.get("storage") == "server_cache"
        or (isinstance(layers, list) and any(layer.get("cached") and not layer.get("dataURL") for layer in layers if isinstance(layer, dict)))
    )
    if state_id and needs_cache:
        cached = _read_unicanvas_state_cache(str(state_id))
        if isinstance(cached, dict) and isinstance(cached.get("layers"), list):
            state = _merge_unicanvas_state_with_cache(state, cached)
        elif any(layer.get("cached") and not layer.get("dataURL") for layer in layers or [] if isinstance(layer, dict)):
            raise ValueError("UniCanvas state cache is missing; interact with the canvas once or wait for state sync before queueing")

    if not isinstance(state.get("layers"), list):
        state["layers"] = []
    return state
