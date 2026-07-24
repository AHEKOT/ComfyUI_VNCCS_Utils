"""ComfyUI bridge for the persistent VNCCS 3D Factory widget."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image


_EMPTY_STATE = '{"schema_version":2,"scene_id":"","selected_object_id":""}'
_MAX_STATE_CHARS = 2 * 1024 * 1024
_MAX_PREVIEW_PIXELS = 4096 * 4096
_ID_RE = re.compile(r"^[a-f0-9]{32}$")


def _parse_state(factory_data: Any) -> dict[str, Any]:
    raw = factory_data if isinstance(factory_data, str) else str(factory_data or "")
    if len(raw) > _MAX_STATE_CHARS:
        raise ValueError("3D Factory state is too large")
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError("3D Factory state is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("3D Factory state must be an object")
    for key in ("scene_id", "selected_object_id"):
        item = value.get(key, "")
        if item and (not isinstance(item, str) or not _ID_RE.fullmatch(item)):
            raise ValueError(f"3D Factory {key.replace('_', ' ')} is invalid")
    source = value.get("source")
    if source is not None:
        if not isinstance(source, dict):
            raise ValueError("3D Factory source reference must be an object")
        source_scene_id = source.get("scene_id", value.get("scene_id", ""))
        if (
            not isinstance(source_scene_id, str)
            or not _ID_RE.fullmatch(source_scene_id)
            or source_scene_id != value.get("scene_id")
        ):
            raise ValueError("3D Factory source scene id is invalid")
        expected_url = f"/vnccs/3d-factory/scenes/{source_scene_id}/reference"
        if source.get("url") != expected_url:
            raise ValueError("3D Factory source URL is invalid")
    snapshot = value.get("scene_snapshot")
    if snapshot is not None:
        if not isinstance(snapshot, dict):
            raise ValueError("3D Factory scene snapshot must be an object")
        objects = snapshot.get("objects", [])
        if not isinstance(objects, list) or len(objects) > 4096:
            raise ValueError("3D Factory scene snapshot has an invalid object list")
        for item in objects:
            object_id = item.get("object_id") if isinstance(item, dict) else None
            if not isinstance(object_id, str) or not _ID_RE.fullmatch(object_id):
                raise ValueError("3D Factory scene snapshot contains an invalid object id")
    return value


def _empty_image() -> torch.Tensor:
    return torch.zeros((1, 64, 64, 3), dtype=torch.float32)


def _preview_tensor(path: Path) -> torch.Tensor:
    if not path.is_file():
        return _empty_image()
    try:
        with Image.open(path) as image:
            if image.width * image.height > _MAX_PREVIEW_PIXELS:
                raise ValueError("3D Factory preview dimensions are too large")
            pixels = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        return torch.from_numpy(np.array(pixels, copy=True)).unsqueeze(0)
    except (OSError, ValueError):
        return _empty_image()


def _backend():
    from ..api import factory3d

    return factory3d


class VNCCS_3DFactory:
    """Expose a saved Factory scene and its Gaussian exports to the graph."""

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("preview", "scene_ply", "scene_splat", "scene_manifest")
    FUNCTION = "load_scene"
    CATEGORY = "VNCCS/3D"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "factory_data": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": _EMPTY_STATE,
                        "dynamicPrompts": False,
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def VALIDATE_INPUTS(cls, factory_data: str = _EMPTY_STATE, **_kwargs):
        try:
            _parse_state(factory_data)
        except ValueError as exc:
            return str(exc)
        return True

    @classmethod
    def IS_CHANGED(cls, factory_data: str = _EMPTY_STATE, **_kwargs):
        digest = hashlib.sha256(str(factory_data or "").encode("utf-8")).hexdigest()
        try:
            state = _parse_state(factory_data)
            scene_id = str(state.get("scene_id") or "")
            if scene_id:
                path = _backend().resolve_scene_dir(scene_id) / "scene.json"
                if path.is_file():
                    stat = path.stat()
                    digest = hashlib.sha256(
                        f"{digest}|{stat.st_mtime_ns}|{stat.st_size}".encode("utf-8")
                    ).hexdigest()
        except (OSError, ValueError):
            pass
        return digest

    def load_scene(self, factory_data: str = _EMPTY_STATE, unique_id=None):
        del unique_id
        state = _parse_state(factory_data)
        scene_id = str(state.get("scene_id") or "")
        if not scene_id:
            return (_empty_image(), "", "", "")

        backend = _backend()
        try:
            snapshot = state.get("scene_snapshot")
            if isinstance(snapshot, dict):
                backend.update_scene(scene_id, snapshot)
            scene = backend.load_scene(scene_id)
        except (FileNotFoundError, ValueError):
            return (_empty_image(), "", "", "")

        preview_path = Path()
        try:
            preview_path = backend._scene_preview_file(scene)
        except FileNotFoundError:
            pass

        try:
            exports = backend.ensure_scene_exports(scene_id) if scene.get("objects") else None
        except (OSError, ValueError):
            exports = None
        return (
            _preview_tensor(preview_path),
            str(exports["ply"]) if exports else "",
            str(exports["splat"]) if exports else "",
            str(backend.resolve_scene_dir(scene_id) / "scene.json"),
        )
