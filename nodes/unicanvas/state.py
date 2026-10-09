"""UniCanvas state JSON loading, including the server-side layer cache."""

from __future__ import annotations

import json
from typing import Any

from . import cache


def _read_unicanvas_state_cache(state_id: str) -> dict[str, Any] | None:
    entry = cache._vnccs_read_unicanvas_state_cache_file(state_id)
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
                layer["dataURL"] = cached_layer.get("dataURL")
                layer["crop"] = live_layer.get("crop") or cached_layer.get("crop")
                layer["hiresRect"] = live_layer.get("hiresRect", cached_layer.get("hiresRect"))
                layer["hiresDataURL"] = live_layer.get("hiresDataURL") or (cached_layer.get("hiresDataURL") if layer["hiresRect"] else None)
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
