"""ComfyUI bridge for the persistent VNCCS 3D Factory widget."""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image


_EMPTY_STATE = '{"schema_version":4,"scene_id":"","selected_object_id":"","selected_group_id":"","selected_object_ids":[]}'
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
    for key in ("scene_id", "selected_object_id", "selected_group_id"):
        item = value.get(key, "")
        if item and (not isinstance(item, str) or not _ID_RE.fullmatch(item)):
            raise ValueError(f"3D Factory {key.replace('_', ' ')} is invalid")
    selected_object_ids = value.get("selected_object_ids", [])
    if (
        not isinstance(selected_object_ids, list)
        or len(selected_object_ids) > 4096
        or any(not isinstance(item, str) or not _ID_RE.fullmatch(item) for item in selected_object_ids)
    ):
        raise ValueError("3D Factory selected object ids are invalid")
    collapsed_group_ids = value.get("collapsed_group_ids", [])
    if (
        not isinstance(collapsed_group_ids, list)
        or len(collapsed_group_ids) > 1024
        or any(not isinstance(item, str) or not _ID_RE.fullmatch(item) for item in collapsed_group_ids)
    ):
        raise ValueError("3D Factory collapsed group ids are invalid")
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
        object_ids: set[str] = set()
        for item in objects:
            object_id = item.get("object_id") if isinstance(item, dict) else None
            if not isinstance(object_id, str) or not _ID_RE.fullmatch(object_id):
                raise ValueError("3D Factory scene snapshot contains an invalid object id")
            if object_id in object_ids:
                raise ValueError("3D Factory scene snapshot contains duplicate objects")
            if "visible" in item and not isinstance(item["visible"], bool):
                raise ValueError("3D Factory scene snapshot contains invalid object visibility")
            object_ids.add(object_id)
        layers = snapshot.get("layers", [])
        if not isinstance(layers, list) or len(layers) > len(objects) + 1024:
            raise ValueError("3D Factory scene snapshot has an invalid layer hierarchy")
        assigned_objects: set[str] = set()
        group_ids: set[str] = set()
        for layer in layers:
            if not isinstance(layer, dict) or layer.get("type") not in {"object", "group"}:
                raise ValueError("3D Factory scene snapshot contains an invalid layer")
            key = "object_id" if layer["type"] == "object" else "group_id"
            layer_id = layer.get(key)
            if not isinstance(layer_id, str) or not _ID_RE.fullmatch(layer_id):
                raise ValueError("3D Factory scene snapshot contains an invalid layer id")
            if layer["type"] == "object":
                if layer_id not in object_ids or layer_id in assigned_objects:
                    raise ValueError("3D Factory scene snapshot contains an unknown or duplicate layer object")
                assigned_objects.add(layer_id)
                continue
            if layer_id in group_ids or layer_id in object_ids:
                raise ValueError("3D Factory scene snapshot contains a duplicate group id")
            group_ids.add(layer_id)
            if "visible" in layer and not isinstance(layer["visible"], bool):
                raise ValueError("3D Factory scene snapshot contains invalid group visibility")
            if "name" in layer and not isinstance(layer["name"], str):
                raise ValueError("3D Factory scene snapshot contains an invalid group name")
            if layer["type"] == "group":
                children = layer.get("children", [])
                if (
                    not isinstance(children, list)
                    or len(children) > len(objects)
                    or any(not isinstance(item, str) or not _ID_RE.fullmatch(item) for item in children)
                ):
                    raise ValueError("3D Factory scene snapshot contains invalid group children")
                if any(item not in object_ids or item in assigned_objects for item in children):
                    raise ValueError("3D Factory scene snapshot contains unknown or duplicate group children")
                assigned_objects.update(children)
        render = snapshot.get("render")
        if render is not None:
            if not isinstance(render, dict):
                raise ValueError("3D Factory scene snapshot has invalid render settings")
            for key in ("width", "height"):
                side = render.get(key)
                if not isinstance(side, int) or isinstance(side, bool) or not 64 <= side <= 4096:
                    raise ValueError("3D Factory scene snapshot has invalid render dimensions")
            if render.get("aspect", "custom") not in {
                "custom", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9",
            }:
                raise ValueError("3D Factory scene snapshot has an invalid aspect preset")
            if "show_camera_frame" in render and not isinstance(render["show_camera_frame"], bool):
                raise ValueError("3D Factory scene snapshot has invalid camera-frame visibility")
        camera = snapshot.get("camera")
        if camera is not None:
            if not isinstance(camera, dict):
                raise ValueError("3D Factory scene snapshot has invalid camera settings")
            for key in ("position", "target"):
                vector = camera.get(key)
                if (
                    not isinstance(vector, list)
                    or len(vector) != 3
                    or any(
                        not isinstance(item, (int, float))
                        or isinstance(item, bool)
                        or not math.isfinite(float(item))
                        for item in vector
                    )
                ):
                    raise ValueError("3D Factory scene snapshot has an invalid camera vector")
            fov = camera.get("fov")
            if (
                not isinstance(fov, (int, float))
                or isinstance(fov, bool)
                or not math.isfinite(float(fov))
                or not 5 <= float(fov) <= 120
            ):
                raise ValueError("3D Factory scene snapshot has an invalid camera FOV")
    return value


def _empty_image() -> torch.Tensor:
    return torch.zeros((1, 64, 64, 3), dtype=torch.float32)


def _preview_tensor(path: Path) -> torch.Tensor:
    if not path.is_file():
        raise FileNotFoundError("3D Factory scene preview file is missing")
    try:
        with Image.open(path) as image:
            if image.width * image.height > _MAX_PREVIEW_PIXELS:
                raise ValueError("3D Factory preview dimensions are too large")
            pixels = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        return torch.from_numpy(np.array(pixels, copy=True)).unsqueeze(0)
    except OSError as exc:
        raise RuntimeError(f"3D Factory scene preview could not be decoded: {exc}") from exc


def _request_scene_preview(
    unique_id: Any,
    scene: dict[str, Any],
    capture_token: str,
) -> bool:
    """Ask the matching live widget for an execution-bound render.

    This is the same server-to-widget synchronization pattern used by Pose
    Studio.  It runs directly from ComfyUI execution and does not rely on a
    requestAnimationFrame loop, tab focus, or the background autosave timer.
    """
    if unique_id is None or not capture_token:
        return False
    try:
        from server import PromptServer

        PromptServer.instance.send_sync(
            "vnccs_req_3d_factory_preview",
            {
                "node_id": unique_id,
                "scene_id": scene.get("scene_id", ""),
                "scene_revision": int(scene.get("revision", 0)),
                "render_revision": int(
                    scene.get("render_revision", scene.get("revision", 0))
                ),
                "capture_token": capture_token,
            },
        )
        return True
    except Exception as exc:
        print(f"[VNCCS 3D Factory] Could not request execution preview sync: {exc}", flush=True)
        return False


def _wait_for_scene_preview(
    backend: Any,
    scene_id: str,
    timeout: float = 60.0,
    capture_token: str = "",
) -> Path:
    """Wait for a fresh execution capture, with a revision-safe saved fallback."""
    deadline = time.monotonic() + max(0.0, float(timeout))
    last_error: Exception | None = None
    current_preview: Path | None = None
    while True:
        scene = backend.load_scene(scene_id)
        if capture_token:
            sync = scene.get("preview_sync")
            if (
                isinstance(sync, dict)
                and sync.get("capture_token") == capture_token
                and sync.get("status") == "failed"
            ):
                raise RuntimeError(
                    "3D Factory execution preview failed in the viewport: "
                    f"{sync.get('error') or 'unknown capture error'}"
                )
        try:
            if capture_token:
                return backend._scene_preview_file(scene, capture_token)
            return backend._scene_preview_file(scene)
        except FileNotFoundError as exc:
            last_error = exc
            if capture_token:
                try:
                    current_preview = backend._scene_preview_file(scene)
                except FileNotFoundError:
                    current_preview = None
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    if current_preview is not None:
        print(
            "[VNCCS 3D Factory] Fresh execution preview sync timed out; "
            "using the saved preview because its scene, camera, and resolution revisions match.",
            flush=True,
        )
        return current_preview
    raise RuntimeError(
        "3D Factory could not obtain a current 3D scene preview during execution. "
        "The saved preview is also stale for the scene geometry, camera, or export resolution. "
        f"Last preview check: {last_error}"
    ) from last_error


def _backend():
    from ..api import factory3d

    return factory3d


class VNCCS_3DFactory:
    """Render a saved Factory scene into the ComfyUI graph."""

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("preview",)
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
        state = _parse_state(factory_data)
        scene_id = str(state.get("scene_id") or "")
        if not scene_id:
            return (_empty_image(),)

        backend = _backend()
        try:
            snapshot = state.get("scene_snapshot")
            if isinstance(snapshot, dict):
                backend.update_scene(scene_id, snapshot)
            scene = backend.load_scene(scene_id)
        except (FileNotFoundError, ValueError) as exc:
            raise RuntimeError(f"3D Factory scene {scene_id} could not be loaded: {exc}") from exc

        if scene.get("objects"):
            capture_token = uuid.uuid4().hex if unique_id is not None else ""
            requested = _request_scene_preview(unique_id, scene, capture_token)
            preview_path = _wait_for_scene_preview(
                backend,
                scene_id,
                capture_token=capture_token if requested else "",
            )
            preview = _preview_tensor(preview_path)
        else:
            preview = _empty_image()
        return (preview,)
