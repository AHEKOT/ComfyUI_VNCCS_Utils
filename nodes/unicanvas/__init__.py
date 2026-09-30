"""VNCCS UniCanvas - in-node canvas editor with direct modular draw actions.

Package layout (lower layers never import higher ones):

* Infrastructure: ``constants``, ``locks``, ``debug``, ``paths``, ``progress``.
* Images and canvas state: ``imaging``, ``masking``, ``state``, ``render``.
* ComfyUI integration: ``comfy_bridge``, ``pipeline``, ``loras``, ``loaders``,
  ``latents``, ``sampling``.
* Model families: ``models`` (one module per family plus the registry).
* Features: ``presets``, ``assets``, ``generation``, ``draw``, ``segment``,
  ``save_output``, ``remove_bg``, ``color_match``.
* Entry points: ``node`` (the ComfyUI node) and ``routes`` (HTTP API).
"""

from __future__ import annotations

# Re-exported for api/factory3d.py, which shares this lock through
# sys.modules["<package>.nodes.unicanvas"] so both editors serialise model work.
from .locks import _COMFY_MODEL_OP_LOCK
from .node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS, VNCCS_UniCanvas
from .routes import register_unicanvas_routes


__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "VNCCS_UniCanvas",
    "_COMFY_MODEL_OP_LOCK",
    "register_unicanvas_routes",
]
