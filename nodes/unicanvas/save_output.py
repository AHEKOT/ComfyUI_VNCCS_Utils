"""Saving the composite or a single layer into ComfyUI's output directory.

Backs ``POST /vnccs/unicanvas/save_output`` (Save to output / layer save).
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

from PIL import Image

from .imaging import _decode_data_url
from .render import _render_unicanvas_state_to_rgba
from .state import _read_unicanvas_state_cache


_UNICANVAS_SAVE_OUTPUT_SEQ = 0
_UNICANVAS_SAVE_OUTPUT_LOCK = threading.Lock()


def _unicanvas_reserve_output_path(output_dir: str) -> str:
    """Atomically reserve a unique unicanvas-<timestamp>-<n>.png name.

    The lock serialises the counter and O_EXCL reserves the name, so concurrent
    saves (Save to output plus the layer context menu) cannot collide.
    """
    global _UNICANVAS_SAVE_OUTPUT_SEQ
    timestamp = int(time.time() * 1000)
    with _UNICANVAS_SAVE_OUTPUT_LOCK:
        while True:
            _UNICANVAS_SAVE_OUTPUT_SEQ += 1
            candidate = os.path.join(output_dir, f"unicanvas-{timestamp}-{_UNICANVAS_SAVE_OUTPUT_SEQ}.png")
            try:
                os.close(os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            except FileExistsError:
                continue
            return candidate


def _unicanvas_save_output_image(image: Image.Image) -> str:
    import folder_paths

    output_dir = str(folder_paths.get_output_directory() or "output")
    os.makedirs(output_dir, exist_ok=True)
    path = _unicanvas_reserve_output_path(output_dir)
    try:
        image.save(path, format="PNG")
    except BaseException:
        # The O_EXCL reservation created the file: a failed save must not leave
        # a zero-byte PNG behind in output/.
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path


def _unicanvas_state_layer_image(state: dict[str, Any], layer_id: str) -> Image.Image:
    layers = state.get("layers")
    if isinstance(layers, list):
        for layer in layers:
            if not isinstance(layer, dict) or str(layer.get("id") or "") != str(layer_id):
                continue
            data_url = layer.get("dataURL") or layer.get("hiresDataURL")
            if data_url:
                return _decode_data_url(str(data_url), "RGBA")
            break
    raise ValueError(f"[VNCCS UniCanvas] Layer '{layer_id}' has no stored pixels to save.")


def _run_unicanvas_save_output(payload: dict[str, Any]) -> dict[str, Any]:
    """Save one PNG into ComfyUI's output directory for the Save to output action.

    ``image`` carries the PNG data URL of the flattened composite, or of a single
    layer when ``layer_id`` is set (the layer keeps its alpha channel). Without
    ``image`` the pixels come from ``state`` (or the server-side state cache via
    ``state_id``): ``layer_id`` saves only that layer's PNG, otherwise the whole
    state renders to one flattened composite.
    """
    if not isinstance(payload, dict):
        raise ValueError("[VNCCS UniCanvas] save_output expects a JSON object.")
    layer_id = str(payload.get("layer_id") or "").strip() or None
    data_url = payload.get("image")
    if data_url:
        image = _decode_data_url(str(data_url), "RGBA")
    else:
        state = payload.get("state")
        if state is None and payload.get("state_id"):
            state = _read_unicanvas_state_cache(str(payload.get("state_id")))
        if not isinstance(state, dict):
            raise ValueError("[VNCCS UniCanvas] save_output needs an image or a canvas state.")
        if layer_id:
            image = _unicanvas_state_layer_image(state, layer_id)
        else:
            image = _render_unicanvas_state_to_rgba(json.dumps(state))
    if layer_id:
        image = image.convert("RGBA")
    path = _unicanvas_save_output_image(image)
    return {"ok": True, "path": path, "width": image.width, "height": image.height}
