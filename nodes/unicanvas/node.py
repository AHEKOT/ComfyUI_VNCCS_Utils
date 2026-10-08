"""The ``VNCCS_UniCanvas`` ComfyUI node."""

from __future__ import annotations

import hashlib
import json
import os

from .draw import _run_unicanvas_draw
from .progress import _store_draw_result
from .render import _render_unicanvas_state_to_image_tensor
from .state import _load_unicanvas_state, _unicanvas_state_cache_path


# The composition keys _run_unicanvas_draw reads from an HTTP-path draw payload (the exact
# key set web/vnccs_unicanvas.js draw() sends). The frontend owns the composition, so the
# queued graph path forwards these values verbatim from settings["queued_draw"].
_QUEUED_DRAW_COMPOSITION_KEYS = (
    "mode",
    "image",
    "pose_edit",
    "mask",
    "source_empty",
    "bbox",
    "inference_size",
    "output_size",
)


class VNCCS_UniCanvas:
    """A ComfyUI node that hosts the VNCCS UniCanvas editor.

    The node's visible work happens in the frontend widget. Its DRAW button calls
    the ``/vnccs/unicanvas/draw`` endpoint (see ``routes.py``) and intentionally does not queue the whole
    ComfyUI graph.
    """

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "export_state"
    CATEGORY = "VNCCS/canvas"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "unicanvas_state": ("STRING", {"multiline": True, "default": "{}"}),
            },
            "optional": {
                "config": ("VNCSS_CONFIG",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, unicanvas_state: str = "{}", config=None, unique_id: str | None = None):
        digest = hashlib.sha256(str(unicanvas_state or "").encode("utf-8"))
        try:
            state = json.loads(unicanvas_state or "{}")
            if isinstance(state, dict):
                # Pixels live outside the prompt; include both layer and panorama output caches.
                output_id = state.get("output_id") or (f"{state['state_id']}_out" if state.get("panorama") and state.get("state_id") else None)
                for state_id in (state.get("state_id"), output_id):
                    if state_id:
                        path = _unicanvas_state_cache_path(str(state_id))
                        if path:
                            stat = os.stat(path)
                            digest.update(f"|{path}|{stat.st_mtime_ns}|{stat.st_ctime_ns}|{stat.st_size}".encode("utf-8"))
        except (OSError, ValueError):
            pass
        return digest.hexdigest()

    def export_state(self, unicanvas_state: str = "{}", config=None, unique_id: str | None = None):
        if config is None:
            return (_render_unicanvas_state_to_image_tensor(unicanvas_state),)
        state = _load_unicanvas_state(unicanvas_state)
        settings = state.get("settings") if isinstance(state.get("settings"), dict) else {}
        draw_id = str(settings.get("draw_id") or f"uc-graph-{unique_id or 'node'}")
        queued_draw = settings.get("queued_draw")
        if not isinstance(queued_draw, dict) or not queued_draw:
            # A plain ComfyUI Queue Prompt carries no fresh composition: the widget releases
            # queued_draw as soon as a queued draw settles, so the node renders the canvas state
            # rather than failing the whole prompt.
            return (_render_unicanvas_state_to_image_tensor(unicanvas_state),)
        payload = {
            "state": state,
            "gen_settings": settings,
            "debug_id": draw_id,
            "external": {
                "model": config.get("model"),
                "clip": config.get("clip"),
                "vae": config.get("vae"),
                "audio_vae": config.get("audio_vae"),
                "references": config.get("references") or {},
                # Already applied to the config model: family LoRAs skip these files.
                "lora_stack": config.get("lora_stack") or [],
            },
            "return_tensor": True,
        }
        # The frontend draw() owns the composition (bbox crop, composite, mask, mode decision);
        # forward its payload verbatim so the queued draw runs the same composition as the HTTP path.
        for key in _QUEUED_DRAW_COMPOSITION_KEYS:
            if key in queued_draw:
                payload[key] = queued_draw[key]
        result = _run_unicanvas_draw(payload)
        _store_draw_result(draw_id, {"images": result.get("images") or [], "mask": result.get("mask")})
        return (result["tensor"],)


NODE_CLASS_MAPPINGS = {
    "VNCCS_UniCanvas": VNCCS_UniCanvas,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_UniCanvas": "VNCCS UniCanvas",
}
