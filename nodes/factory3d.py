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


_EMPTY_STATE = '{"schema_version":17,"scene_id":"","selected_object_id":"","selected_group_id":"","selected_object_ids":[]}'
_MAX_STATE_CHARS = 16 * 1024 * 1024
_MAX_PREVIEW_PIXELS = 4096 * 4096
_MAX_SCENE_CAMERAS = 32
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
            collision = item.get("collision_proxy", {})
            if not isinstance(collision, dict) or collision.get("mode", "auto_box") not in {
                "auto_box", "box", "off",
            }:
                raise ValueError("3D Factory scene snapshot contains an invalid collision proxy")
            for key in ("center", "size"):
                vector = collision.get(key, [0, 0, 0] if key == "center" else [1, 1, 1])
                if (
                    not isinstance(vector, list)
                    or len(vector) != 3
                    or any(
                        not isinstance(component, (int, float))
                        or isinstance(component, bool)
                        or not math.isfinite(float(component))
                        for component in vector
                    )
                    or (key == "size" and any(float(component) <= 0 for component in vector))
                ):
                    raise ValueError("3D Factory scene snapshot contains invalid collision geometry")
            if item.get("light_transport", "opaque") not in {"opaque", "cutout", "transmissive"}:
                raise ValueError("3D Factory scene snapshot contains invalid light transport")
            transmission = item.get("transmission", 0)
            if (
                not isinstance(transmission, (int, float))
                or isinstance(transmission, bool)
                or not math.isfinite(float(transmission))
                or not 0 <= float(transmission) <= 1
            ):
                raise ValueError("3D Factory scene snapshot contains invalid light transmission")
            if "locked" in item and not isinstance(item["locked"], bool):
                raise ValueError("3D Factory scene snapshot contains invalid object lock state")
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
        def validate_camera(camera: Any, label: str) -> None:
            if not isinstance(camera, dict):
                raise ValueError(f"3D Factory scene snapshot has invalid {label}")
            for key in ("position", "target", "up"):
                vector = camera.get(key)
                if key == "up" and vector is None:
                    continue
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
                    raise ValueError(
                        f"3D Factory scene snapshot has an invalid {label} vector"
                    )
            fov = camera.get("fov")
            if (
                not isinstance(fov, (int, float))
                or isinstance(fov, bool)
                or not math.isfinite(float(fov))
                or not 5 <= float(fov) <= 120
            ):
                raise ValueError(f"3D Factory scene snapshot has an invalid {label} FOV")

        camera = snapshot.get("camera")
        if camera is not None:
            validate_camera(camera, "camera")
        cameras = snapshot.get("cameras", [])
        if not isinstance(cameras, list) or len(cameras) > _MAX_SCENE_CAMERAS:
            raise ValueError("3D Factory scene snapshot has an invalid saved camera list")
        camera_ids: set[str] = set()
        for saved_camera in cameras:
            camera_id = (
                saved_camera.get("camera_id")
                if isinstance(saved_camera, dict)
                else None
            )
            if (
                not isinstance(camera_id, str)
                or not _ID_RE.fullmatch(camera_id)
                or camera_id in camera_ids
            ):
                raise ValueError(
                    "3D Factory scene snapshot contains an invalid saved camera id"
                )
            if "name" in saved_camera and not isinstance(saved_camera["name"], str):
                raise ValueError(
                    "3D Factory scene snapshot contains an invalid saved camera name"
                )
            validate_camera(saved_camera, "saved camera")
            camera_ids.add(camera_id)
        levels = snapshot.get("levels", [])
        if "levels" in snapshot and (not isinstance(levels, list) or not 1 <= len(levels) <= 64):
            raise ValueError("3D Factory scene snapshot has invalid floor levels")
        level_ids: set[str] = set()
        for level in levels:
            level_id = level.get("level_id") if isinstance(level, dict) else None
            if not isinstance(level_id, str) or not _ID_RE.fullmatch(level_id) or level_id in level_ids:
                raise ValueError("3D Factory scene snapshot contains an invalid floor level")
            for key in ("elevation", "height", "slab_thickness"):
                number = level.get(key)
                if not isinstance(number, (int, float)) or isinstance(number, bool) or not math.isfinite(float(number)):
                    raise ValueError("3D Factory scene snapshot contains invalid floor geometry")
            level_ids.add(level_id)
        if level_ids:
            for item in objects:
                if item.get("level_id") is not None and item.get("level_id") not in level_ids:
                    raise ValueError("3D Factory object references an unknown floor level")
            for saved_camera in cameras:
                if saved_camera.get("level_id") is not None and saved_camera.get("level_id") not in level_ids:
                    raise ValueError("3D Factory saved camera references an unknown floor level")
        architecture = snapshot.get("architecture", {})
        if not isinstance(architecture, dict):
            raise ValueError("3D Factory scene snapshot has invalid architecture")
        architecture_limits = {
            "materials": 512,
            "buildings": 64,
            "walls": 4096,
            "rooms": 1024,
            "openings": 4096,
        }
        for key, limit in architecture_limits.items():
            entries = architecture.get(key, [])
            if not isinstance(entries, list) or len(entries) > limit or any(not isinstance(item, dict) for item in entries):
                raise ValueError(f"3D Factory scene snapshot has invalid architecture {key}")
        def finite_number(value: Any) -> bool:
            return (
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(float(value))
            )

        def finite_vector(value: Any, length: int) -> bool:
            return (
                isinstance(value, list)
                and len(value) == length
                and all(finite_number(item) for item in value)
            )

        material_ids: set[str] = set()
        for material in architecture.get("materials", []):
            material_id = material.get("material_id")
            if (
                not isinstance(material_id, str)
                or not _ID_RE.fullmatch(material_id)
                or material_id in material_ids
            ):
                raise ValueError("3D Factory scene snapshot contains an invalid material")
            material_ids.add(material_id)
        building_ids: set[str] = set()
        raw_buildings = architecture.get("buildings", [])
        has_building_schema = "buildings" in architecture
        requires_content_building_refs = int(value.get("schema_version", 0) or 0) >= 16
        for building in raw_buildings:
            building_id = building.get("building_id")
            if (
                not isinstance(building_id, str)
                or not _ID_RE.fullmatch(building_id)
                or building_id in building_ids
                or not finite_vector(building.get("position"), 3)
                or not finite_number(building.get("rotation_y"))
            ):
                raise ValueError("3D Factory scene snapshot contains an invalid building")
            building_ids.add(building_id)
        if has_building_schema and requires_content_building_refs:
            for item in objects:
                if item.get("building_id") and item.get("building_id") not in building_ids:
                    raise ValueError("3D Factory object references an unknown building")
            for saved_camera in cameras:
                if (
                    saved_camera.get("building_id")
                    and saved_camera.get("building_id") not in building_ids
                ):
                    raise ValueError("3D Factory saved camera references an unknown building")
        wall_ids: set[str] = set()
        for wall in architecture.get("walls", []):
            wall_id = wall.get("wall_id")
            if not isinstance(wall_id, str) or not _ID_RE.fullmatch(wall_id) or wall_id in wall_ids:
                raise ValueError("3D Factory scene snapshot contains an invalid wall")
            if (
                wall.get("level_id") not in level_ids
                or (
                    has_building_schema
                    and wall.get("building_id")
                    and wall.get("building_id") not in building_ids
                )
            ):
                raise ValueError("3D Factory wall references an unknown floor level")
            if (
                not finite_vector(wall.get("start"), 2)
                or not finite_vector(wall.get("end"), 2)
                or any(
                    not finite_number(wall.get(key))
                    for key in ("thickness", "height", "elevation_offset")
                )
            ):
                raise ValueError("3D Factory scene snapshot contains invalid wall geometry")
            wall_ids.add(wall_id)
        room_ids: set[str] = set()
        walls_by_id = {
            wall["wall_id"]: wall
            for wall in architecture.get("walls", [])
        }
        for room in architecture.get("rooms", []):
            room_id = room.get("room_id")
            polygon = room.get("polygon")
            if (
                not isinstance(room_id, str)
                or not _ID_RE.fullmatch(room_id)
                or room_id in room_ids
                or room.get("level_id") not in level_ids
                or (
                    has_building_schema
                    and room.get("building_id")
                    and room.get("building_id") not in building_ids
                )
                or not isinstance(polygon, list)
                or not 3 <= len(polygon) <= 512
                or any(not finite_vector(point, 2) for point in polygon)
                or not isinstance(room.get("wall_ids", []), list)
                or any(wall_id not in wall_ids for wall_id in room.get("wall_ids", []))
            ):
                raise ValueError("3D Factory scene snapshot contains an invalid room")
            linked_ids = room.get("wall_ids", [])
            if linked_ids:
                if len(linked_ids) != len(polygon) or len(set(linked_ids)) != len(linked_ids):
                    raise ValueError("3D Factory room perimeter does not match its polygon")
                for index, wall_id in enumerate(linked_ids):
                    wall = walls_by_id[wall_id]
                    if (
                        wall.get("level_id") != room.get("level_id")
                        or wall.get("building_id") != room.get("building_id")
                        or math.dist(wall["start"], polygon[index]) > 1e-4
                        or math.dist(wall["end"], polygon[(index + 1) % len(polygon)]) > 1e-4
                    ):
                        raise ValueError("3D Factory room perimeter walls are inconsistent")
            room_ids.add(room_id)
        opening_ids: set[str] = set()
        occupied_by_wall: dict[str, list[tuple[float, float]]] = {}
        for opening in architecture.get("openings", []):
            opening_id = opening.get("opening_id")
            if (
                not isinstance(opening_id, str)
                or not _ID_RE.fullmatch(opening_id)
                or opening_id in opening_ids
                or opening.get("wall_id") not in wall_ids
                or any(
                    not finite_number(opening.get(key))
                    for key in ("offset", "width", "height", "sill_height")
                )
            ):
                raise ValueError("3D Factory scene snapshot contains an invalid opening")
            wall = walls_by_id[opening["wall_id"]]
            wall_length = math.dist(wall["start"], wall["end"])
            center = float(opening["offset"]) * wall_length
            half = float(opening["width"]) / 2.0
            interval = (center - half, center + half)
            if (
                interval[0] < -1e-9
                or interval[1] > wall_length + 1e-9
                or float(opening["sill_height"]) + float(opening["height"]) > float(wall["height"]) + 1e-9
                or any(interval[0] < end - 1e-9 and interval[1] > start + 1e-9 for start, end in occupied_by_wall.setdefault(opening["wall_id"], []))
            ):
                raise ValueError("3D Factory opening is outside its wall or overlaps another opening")
            occupied_by_wall[opening["wall_id"]].append(interval)
            opening_ids.add(opening_id)
        tracks = snapshot.get("camera_tracks", [])
        if not isinstance(tracks, list) or len(tracks) > 16:
            raise ValueError("3D Factory scene snapshot has invalid camera paths")
        total_keyframes = 0
        track_ids: set[str] = set()
        all_keyframe_ids: set[str] = set()
        for track in tracks:
            track_id = track.get("track_id") if isinstance(track, dict) else None
            keyframes = track.get("keyframes", []) if isinstance(track, dict) else None
            if (
                not isinstance(track_id, str)
                or not _ID_RE.fullmatch(track_id)
                or track_id in track_ids
                or not isinstance(keyframes, list)
                or not finite_number(track.get("duration"))
                or not finite_number(track.get("fps"))
                or (
                    has_building_schema
                    and requires_content_building_refs
                    and track.get("building_id")
                    and track.get("building_id") not in building_ids
                )
            ):
                raise ValueError("3D Factory scene snapshot contains an invalid camera path")
            total_keyframes += len(keyframes)
            if total_keyframes > 1000:
                raise ValueError("3D Factory camera path point limit was exceeded")
            keyframe_ids: set[str] = set()
            for frame in keyframes:
                quaternion = frame.get("quaternion") if isinstance(frame, dict) else None
                if (
                    not isinstance(frame, dict)
                    or not isinstance(frame.get("keyframe_id"), str)
                    or not _ID_RE.fullmatch(frame["keyframe_id"])
                    or frame["keyframe_id"] in keyframe_ids
                    or frame["keyframe_id"] in all_keyframe_ids
                    or not isinstance(quaternion, list)
                    or len(quaternion) != 4
                    or any(not isinstance(item, (int, float)) or not math.isfinite(float(item)) for item in quaternion)
                    or not finite_vector(frame.get("position"), 3)
                    or not finite_number(frame.get("time"))
                    or not finite_number(frame.get("fov"))
                    or not finite_number(frame.get("focus_distance"))
                ):
                    raise ValueError("3D Factory scene snapshot contains an invalid camera path point")
                keyframe_ids.add(frame["keyframe_id"])
                all_keyframe_ids.add(frame["keyframe_id"])
            if keyframes and max(float(frame["time"]) for frame in keyframes) > float(track["duration"]):
                raise ValueError("3D Factory camera path duration ends before its last point")
            track_ids.add(track_id)
        lighting = snapshot.get("lighting", {})
        if not isinstance(lighting, dict):
            raise ValueError("3D Factory scene snapshot has invalid lighting")
        shadows = lighting.get("shadows", {})
        if not isinstance(shadows, dict) or shadows.get("quality", "medium") not in {
            "off", "low", "medium", "high", "ultra",
        }:
            raise ValueError("3D Factory scene snapshot has invalid shadow settings")
        lights = lighting.get("lights", [])
        if not isinstance(lights, list) or len(lights) > 32:
            raise ValueError("3D Factory scene snapshot has invalid local lights")
        light_ids: set[str] = set()
        for light in lights:
            light_id = light.get("light_id") if isinstance(light, dict) else None
            if (
                not isinstance(light_id, str)
                or not _ID_RE.fullmatch(light_id)
                or light_id in light_ids
                or light.get("kind") not in {"point", "spot", "directional"}
                or (light.get("level_id") is not None and light.get("level_id") not in level_ids)
                or (
                    has_building_schema
                    and requires_content_building_refs
                    and light.get("building_id")
                    and light.get("building_id") not in building_ids
                )
                or not finite_vector(light.get("position"), 3)
                or not finite_vector(light.get("target"), 3)
                or any(
                    not finite_number(light.get(key))
                    for key in ("intensity", "distance", "angle", "penumbra")
                )
            ):
                raise ValueError("3D Factory scene snapshot contains an invalid local light")
            light_ids.add(light_id)
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
                "edit_revision": int(scene.get("edit_revision", 0)),
                "render": scene.get("render", {}),
                "camera": scene.get("camera", {}),
                "cameras": scene.get("cameras", []),
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


def _wait_for_scene_capture_set(
    backend: Any,
    scene_id: str,
    timeout: float = 60.0,
    capture_token: str = "",
) -> list[Path]:
    """Wait for the current view and all saved-camera renders as one revision."""
    deadline = time.monotonic() + max(0.0, float(timeout))
    last_error: Exception | None = None
    saved_capture_set: list[Path] | None = None
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
                    "3D Factory execution camera capture failed in the viewport: "
                    f"{sync.get('error') or 'unknown capture error'}"
                )
        try:
            if capture_token:
                return backend._scene_capture_files(scene, capture_token)
            return backend._scene_capture_files(scene)
        except FileNotFoundError as exc:
            last_error = exc
            if capture_token:
                try:
                    saved_capture_set = backend._scene_capture_files(scene)
                except FileNotFoundError:
                    saved_capture_set = None
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    if saved_capture_set is not None:
        print(
            "[VNCCS 3D Factory] Fresh camera capture timed out; using the "
            "revision-matched saved capture set.",
            flush=True,
        )
        return saved_capture_set
    raise RuntimeError(
        "3D Factory could not obtain the current view and saved-camera images. "
        "Keep the 3D Factory widget open for execution and save the scene after "
        f"camera changes. Last capture check: {last_error}"
    ) from last_error


def _backend():
    from ..api import factory3d

    return factory3d


class VNCCS_3DFactory:
    """Render a saved Factory scene into the ComfyUI graph."""

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("preview",)
    OUTPUT_IS_LIST = (True,)
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
            return ([_empty_image()],)

        backend = _backend()
        try:
            snapshot = state.get("scene_snapshot")
            if isinstance(snapshot, dict):
                scene = backend.update_scene(scene_id, dict(snapshot))
            else:
                scene = backend.load_scene(scene_id)
        except (FileNotFoundError, ValueError) as exc:
            raise RuntimeError(f"3D Factory scene {scene_id} could not be loaded: {exc}") from exc

        has_renderable_scene = bool(
            scene.get("objects") or scene.get("skydome") or scene.get("cameras")
        )
        if has_renderable_scene:
            capture_token = uuid.uuid4().hex if unique_id is not None else ""
            requested = _request_scene_preview(unique_id, scene, capture_token)
            if requested:
                capture_paths = _wait_for_scene_capture_set(
                    backend,
                    scene_id,
                    capture_token=capture_token,
                )
            else:
                try:
                    capture_paths = backend._scene_capture_files(scene)
                except FileNotFoundError:
                    if scene.get("cameras"):
                        raise RuntimeError(
                            "3D Factory has saved cameras but no matching camera "
                            "capture set. Open the node widget and run it again."
                        )
                    capture_paths = [
                        _wait_for_scene_preview(backend, scene_id, timeout=0.0)
                    ]
            previews = [_preview_tensor(path) for path in capture_paths]
        else:
            previews = [_empty_image()]
        return (previews,)
