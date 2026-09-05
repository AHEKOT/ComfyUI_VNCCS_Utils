"""ComfyUI server API for the VNCCS 3D Factory scene editor."""

from __future__ import annotations

import asyncio
import gc
import hashlib
import io
import json
import logging
import math
import os
import re
import secrets
import shutil
import sys
import threading
import time
import traceback
import urllib.parse
import zipfile
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, BinaryIO, Callable

from PIL import Image, ImageDraw, ImageOps

from . import factory3d_generation
from .factory3d_migrations import migrate_scene_11_to_12
from .gaussian_scene import (
    export_gaussian_scene,
    inspect_ply,
    normalize_transform,
    ply_to_splat,
    validate_ply_payload,
    validate_splat_payload,
)
from .factory3d_schema import (
    normalize_architecture,
    normalize_camera_tracks,
    normalize_levels,
    normalize_lighting_extensions,
    normalize_object_editor_properties,
)


LOGGER = logging.getLogger("vnccs.3d_factory")
API_BASE = "/vnccs/3d-factory"
SCHEMA_VERSION = 11
MAX_READABLE_SCHEMA_VERSION = 12
EXPORT_FORMAT_VERSION = 8
UPSTREAM_REPOSITORY = "VAST-AI/TripoSplat"
UPSTREAM_COMMIT = "a78fa12d06dbf1381ca548bfac32bb68cb8c451d"
UPSTREAM_HF_REVISION = "56a96e603204ec410c4da60c13ea4fa09a2169a9"
MAX_UPLOAD_BYTES = 32 * 1024 * 1024
MAX_PLY_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
MAX_MODEL_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
MAX_MODEL_UPLOAD_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
MAX_MODEL_UPLOAD_FILES = 512
MAX_PREVIEW_BYTES = 64 * 1024 * 1024
MAX_SCENE_CAMERAS = 32
MAX_IMAGE_PIXELS = 4096 * 4096
MAX_SKYDOME_BYTES = 64 * 1024 * 1024
MAX_TEXTURE_BYTES = 32 * 1024 * 1024
MAX_SKYDOME_PIXELS = 8192 * 4096
REFERENCE_PREVIEW_SIZE = (640, 640)
SKYDOME_VIEWPORT_SIZE = (2048, 1024)
OBJECT_THUMBNAIL_SIZE = (256, 256)
MAX_SCENE_JSON_BYTES = 16 * 1024 * 1024
MAX_JOB_LOG_LINES = 800
MAX_ACTIVE_JOBS = 2
DEFAULT_SPLAT_CACHE_LIMIT_GB = 32
MIN_SPLAT_CACHE_LIMIT_GB = 1
MAX_SPLAT_CACHE_LIMIT_GB = 1024
GAUSSIAN_COUNTS = (32768, 65536, 131072, 262144, 524288, 1048576)
EXPERIMENTAL_GAUSSIAN_COUNTS = (524288, 1048576)
CONDITIONING_RESOLUTIONS = (1024, 1536, 2048)
EXPERIMENTAL_CONDITIONING_RESOLUTIONS = (1536, 2048)
_ID_RE = re.compile(r"^[a-f0-9]{32}$")
_SAFE_NAME_RE = re.compile(r"[\x00-\x1f\x7f]+")
_MODEL_FORMATS = {".glb", ".gltf", ".fbx", ".obj", ".stl"}
_MODEL_RESOURCE_FORMATS = {
    ".bin", ".mtl", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tga",
}
_ASPECT_PRESETS = {"custom", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"}
_DEFAULT_RENDER_SETTINGS = {
    "width": 1024,
    "height": 1024,
    "aspect": "1:1",
    "show_camera_frame": False,
}
_DEFAULT_CAMERA = {
    "position": [2.8, 2.1, 4.2],
    "target": [0.0, 0.0, 0.0],
    "up": [0.0, 1.0, 0.0],
    "fov": 42.0,
}
_LIGHTING_PRESETS = {"off", "day", "night", "dawn", "sunset", "custom"}
_DEFAULT_LIGHTING = {
    "preset": "day",
    "intensity": 0.72,
    "color": "#fff1d6",
    "azimuth": 325.0,
    "elevation": 42.0,
    "ambient": 0.5,
    "background": "#171b25",
}
_DEFAULT_SKYDOME_SETTINGS = {
    "visible": True,
    "yaw": 0.0,
    "pitch": 0.0,
    "roll": 0.0,
    "exposure": 0.0,
    "blur": 0.0,
}
_WEIGHT_FILES = (
    "diffusion_models/triposplat_fp16.safetensors",
    "vae/triposplat_vae_decoder_fp16.safetensors",
    "clip_vision/dino_v3_vit_h.safetensors",
    "vae/flux2-vae.safetensors",
    "background_removal/birefnet.safetensors",
)

_STATE_LOCK = threading.RLock()
_INFERENCE_LOCK = threading.RLock()
_SPLAT_CACHE_LOCK = threading.RLock()
_PLY_HASH_CACHE: dict[tuple[int, int, int, int], str] = {}
_PIPELINE: Any = None
_PIPELINE_SIGNATURE: tuple[Any, ...] | None = None
_JOBS: dict[str, dict[str, Any]] = {}
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()
_REGISTERED = False


class JobCancelled(RuntimeError):
    pass


def _model_operation_lock() -> Any:
    """Use UniCanvas' process-wide model lock when that reference is loaded.

    Both editors execute model code outside ComfyUI's normal prompt queue. A
    shared lock prevents one editor from moving or releasing weights while the
    other is sampling. Tests and standalone imports fall back to Factory's own
    lock without importing the full UniCanvas node.
    """
    package_root = (__package__ or "").rsplit(".", 1)[0]
    module_name = f"{package_root}.nodes.unicanvas" if package_root else ""
    module = sys.modules.get(module_name) if module_name else None
    lock = getattr(module, "_COMFY_MODEL_OP_LOCK", None)
    return lock if hasattr(lock, "acquire") and hasattr(lock, "release") else _INFERENCE_LOCK


class _FactoryModelOperation:
    """Cancellable acquisition of the shared direct-model execution slot."""

    def __init__(self, job: dict[str, Any]) -> None:
        self.job = job
        self.lock = _model_operation_lock()
        self.acquired = False

    def __enter__(self) -> "_FactoryModelOperation":
        announced = False
        while not self.lock.acquire(timeout=0.25):
            _check_cancel(self.job)
            if not announced:
                _emit(
                    self.job,
                    "queued",
                    self.job.get("progress", 0),
                    "Waiting for the GPU model slot",
                )
                announced = True
        self.acquired = True
        try:
            _check_cancel(self.job)
        except Exception:
            self.acquired = False
            self.lock.release()
            raise
        return self

    def __exit__(self, _exc_type: Any, _exc_value: Any, _traceback: Any) -> None:
        if self.acquired:
            try:
                # Cleanup is part of the protected model operation. Releasing
                # the lock first would let UniCanvas start loading while this
                # thread is still asking ComfyUI to evict stale model entries.
                factory3d_generation.release_runtime_memory()
            finally:
                self.acquired = False
                self.lock.release()


def _release_cached_triposplat_pipeline() -> None:
    """Drop the CPU model cache before switching to a native mesh generator."""
    global _PIPELINE, _PIPELINE_SIGNATURE

    pipeline = _PIPELINE
    _PIPELINE = None
    _PIPELINE_SIGNATURE = None
    if pipeline is not None:
        del pipeline
        gc.collect()
    factory3d_generation.release_runtime_memory()


def _now() -> float:
    return time.time()


def _factory_root() -> Path:
    try:
        import folder_paths  # type: ignore

        return Path(folder_paths.get_output_directory()).resolve() / "vnccs_3d_factory"
    except Exception:
        return Path.cwd().resolve() / "output" / "vnccs_3d_factory"


def _model_root() -> Path:
    try:
        import folder_paths  # type: ignore

        return Path(folder_paths.models_dir).resolve()
    except Exception:
        return Path.cwd().resolve() / "models"


def _splat_cache_root() -> Path:
    """Return the disposable, content-addressed viewport/export SPLAT cache."""
    root = (_factory_root() / "cache" / "splats").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _splat_cache_settings_path() -> Path:
    return _splat_cache_root().parent / "settings.json"


def _splat_cache_limit_gb() -> int:
    path = _splat_cache_settings_path()
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        limit = int(value.get("limit_gb", DEFAULT_SPLAT_CACHE_LIMIT_GB))
    except (OSError, ValueError, TypeError, json.JSONDecodeError, AttributeError):
        limit = DEFAULT_SPLAT_CACHE_LIMIT_GB
    return max(MIN_SPLAT_CACHE_LIMIT_GB, min(MAX_SPLAT_CACHE_LIMIT_GB, limit))


def _splat_cache_limit_bytes() -> int:
    return _splat_cache_limit_gb() * 1024**3


def _category_roots(category: str) -> list[Path]:
    """Return ComfyUI model-category roots, including extra_model_paths."""
    try:
        import folder_paths  # type: ignore

        return [Path(path).resolve() for path in folder_paths.get_folder_paths(category)]
    except Exception:
        return []


def _validate_id(value: Any, label: str = "id") -> str:
    text = str(value or "").lower()
    if not _ID_RE.fullmatch(text):
        raise ValueError(f"invalid {label}")
    return text


def _new_id() -> str:
    return secrets.token_hex(16)


def _clean_name(value: Any, fallback: str, maximum: int = 96) -> str:
    name = _SAFE_NAME_RE.sub("", str(value or "")).strip()
    return name[:maximum] or fallback


def _normalize_render_settings(value: Any) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}
    try:
        width = int(data.get("width", _DEFAULT_RENDER_SETTINGS["width"]))
    except (TypeError, ValueError):
        width = _DEFAULT_RENDER_SETTINGS["width"]
    try:
        height = int(data.get("height", _DEFAULT_RENDER_SETTINGS["height"]))
    except (TypeError, ValueError):
        height = _DEFAULT_RENDER_SETTINGS["height"]
    aspect = str(data.get("aspect", _DEFAULT_RENDER_SETTINGS["aspect"])).lower()
    if aspect not in _ASPECT_PRESETS:
        aspect = "custom"
    return {
        "width": max(64, min(4096, width)),
        "height": max(64, min(4096, height)),
        "aspect": aspect,
        "show_camera_frame": data.get("show_camera_frame") is True,
    }


def _normalize_camera(value: Any) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}

    def vector(key: str) -> list[float]:
        fallback = _DEFAULT_CAMERA[key]
        raw = data.get(key)
        if not isinstance(raw, (list, tuple)) or len(raw) != 3:
            return list(fallback)
        output = []
        for index, item in enumerate(raw):
            try:
                number = float(item)
            except (TypeError, ValueError):
                number = fallback[index]
            if not math.isfinite(number):
                number = fallback[index]
            output.append(max(-1_000_000.0, min(1_000_000.0, number)))
        return output

    try:
        fov = float(data.get("fov", _DEFAULT_CAMERA["fov"]))
    except (TypeError, ValueError):
        fov = _DEFAULT_CAMERA["fov"]
    if not math.isfinite(fov):
        fov = _DEFAULT_CAMERA["fov"]
    position = vector("position")
    target = vector("target")
    up = vector("up")
    forward = [target[index] - position[index] for index in range(3)]
    forward_length = math.sqrt(sum(component * component for component in forward))
    if forward_length < 1e-7:
        target = [position[0], position[1], position[2] - 1.0]
        forward = [0.0, 0.0, -1.0]
        forward_length = 1.0
    forward = [component / forward_length for component in forward]
    up_length = math.sqrt(sum(component * component for component in up))
    if up_length < 1e-7:
        up = list(_DEFAULT_CAMERA["up"])
        up_length = 1.0
    up = [component / up_length for component in up]
    alignment = abs(sum(forward[index] * up[index] for index in range(3)))
    if alignment > 0.999:
        up = [0.0, 1.0, 0.0]
        if abs(sum(forward[index] * up[index] for index in range(3))) > 0.999:
            up = [0.0, 0.0, 1.0]
    return {
        "position": position,
        "target": target,
        "up": up,
        "fov": max(5.0, min(120.0, fov)),
    }


def _normalize_scene_cameras(
    value: Any,
    *,
    strict: bool = False,
) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        if strict:
            raise ValueError("scene cameras must be a list")
        return []
    if len(value) > MAX_SCENE_CAMERAS:
        if strict:
            raise ValueError(f"a scene can contain at most {MAX_SCENE_CAMERAS} cameras")
        value = value[:MAX_SCENE_CAMERAS]
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            if strict:
                raise ValueError("scene camera entries must be objects")
            continue
        try:
            camera_id = _validate_id(raw.get("camera_id"), "camera id")
        except ValueError:
            if strict:
                raise
            camera_id = _new_id()
        if camera_id in seen:
            if strict:
                raise ValueError("scene camera ids must be unique")
            camera_id = _new_id()
        seen.add(camera_id)
        camera = _normalize_camera(raw)
        try:
            created_at = float(raw.get("created_at", 0.0))
        except (TypeError, ValueError):
            created_at = 0.0
        if not math.isfinite(created_at) or created_at < 0:
            created_at = 0.0
        output.append(
            {
                "camera_id": camera_id,
                "name": _clean_name(raw.get("name"), f"Camera {index + 1}", 80),
                "created_at": created_at,
                "level_id": str(raw.get("level_id") or "")
                if _ID_RE.fullmatch(str(raw.get("level_id") or ""))
                else "",
                "building_id": str(raw.get("building_id") or "")
                if _ID_RE.fullmatch(str(raw.get("building_id") or ""))
                else "",
                **camera,
            }
        )
    return output


def _normalize_lighting(value: Any) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}
    preset = str(data.get("preset", _DEFAULT_LIGHTING["preset"])).lower()
    if preset not in _LIGHTING_PRESETS:
        preset = "custom"

    def number(key: str, minimum: float, maximum: float) -> float:
        try:
            output = float(data.get(key, _DEFAULT_LIGHTING[key]))
        except (TypeError, ValueError):
            output = float(_DEFAULT_LIGHTING[key])
        if not math.isfinite(output):
            output = float(_DEFAULT_LIGHTING[key])
        return max(minimum, min(maximum, output))

    def color(key: str) -> str:
        raw = str(data.get(key, _DEFAULT_LIGHTING[key])).strip().lower()
        if re.fullmatch(r"#[0-9a-f]{6}", raw):
            return raw
        return str(_DEFAULT_LIGHTING[key])

    try:
        azimuth = float(data.get("azimuth", _DEFAULT_LIGHTING["azimuth"]))
    except (TypeError, ValueError):
        azimuth = float(_DEFAULT_LIGHTING["azimuth"])
    if not math.isfinite(azimuth):
        azimuth = float(_DEFAULT_LIGHTING["azimuth"])

    return {
        "preset": preset,
        "intensity": number("intensity", 0.0, 3.0),
        "color": color("color"),
        "azimuth": azimuth % 360.0,
        "elevation": number("elevation", -10.0, 90.0),
        "ambient": number("ambient", 0.0, 1.5),
        "background": color("background"),
        **normalize_lighting_extensions(data),
    }


def _normalize_skydome_settings(value: Any) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}

    def number(key: str, minimum: float, maximum: float) -> float:
        try:
            output = float(data.get(key, _DEFAULT_SKYDOME_SETTINGS[key]))
        except (TypeError, ValueError):
            output = float(_DEFAULT_SKYDOME_SETTINGS[key])
        if not math.isfinite(output):
            output = float(_DEFAULT_SKYDOME_SETTINGS[key])
        return max(minimum, min(maximum, output))

    return {
        "visible": data.get("visible") is not False,
        "yaw": number("yaw", -180.0, 180.0),
        "pitch": number("pitch", -90.0, 90.0),
        "roll": number("roll", -180.0, 180.0),
        "exposure": number("exposure", -4.0, 4.0),
        "blur": number("blur", 0.0, 1.0),
    }


def _normalize_scene_skydome(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or not isinstance(value.get("file"), str):
        return None
    output = json.loads(json.dumps(value))
    skydome_id = str(output.get("skydome_id") or "")
    output["skydome_id"] = skydome_id if _ID_RE.fullmatch(skydome_id) else _new_id()
    output["type"] = "skydome"
    output["name"] = _clean_name(output.get("name"), "Skydome", 96)
    output["projection"] = "equirectangular"
    output.update(_normalize_skydome_settings(output))
    for key in ("width", "height", "size"):
        try:
            output[key] = max(0, int(output.get(key, 0)))
        except (TypeError, ValueError):
            output[key] = 0
    try:
        output["updated_at"] = float(output.get("updated_at", 0))
    except (TypeError, ValueError):
        output["updated_at"] = 0.0
    if not math.isfinite(output["updated_at"]):
        output["updated_at"] = 0.0
    return output


def _normalize_scene_layers(
    scene: dict[str, Any],
    layers: Any = None,
    *,
    strict: bool = False,
) -> list[dict[str, Any]]:
    """Normalize the one-level object/group hierarchy and preserve every object."""
    objects = [
        item
        for item in scene.get("objects", [])
        if isinstance(item, dict) and isinstance(item.get("object_id"), str)
    ]
    object_ids = {item["object_id"] for item in objects}
    for item in objects:
        item["visible"] = item.get("visible") is not False

    raw_layers = scene.get("layers", []) if layers is None else layers
    if not isinstance(raw_layers, list) or len(raw_layers) > len(objects) + 1024:
        if strict:
            raise ValueError("invalid scene layer hierarchy")
        raw_layers = []

    output: list[dict[str, Any]] = []
    seen_objects: set[str] = set()
    seen_groups: set[str] = set()

    def invalid(message: str) -> None:
        if strict:
            raise ValueError(message)

    for raw in raw_layers:
        if not isinstance(raw, dict):
            invalid("scene layers must be objects")
            continue
        layer_type = raw.get("type")
        if layer_type == "object":
            object_id = str(raw.get("object_id") or "")
            if object_id not in object_ids or object_id in seen_objects:
                invalid("scene layer contains an unknown or duplicate object")
                continue
            output.append({"type": "object", "object_id": object_id})
            seen_objects.add(object_id)
            continue
        if layer_type != "group":
            invalid("scene layer type must be object or group")
            continue
        group_id = str(raw.get("group_id") or "").lower()
        if (
            not _ID_RE.fullmatch(group_id)
            or group_id in seen_groups
            or group_id in object_ids
        ):
            invalid("scene layer contains an invalid or duplicate group id")
            continue
        children = raw.get("children", [])
        if not isinstance(children, list) or len(children) > len(objects):
            invalid("scene group contains an invalid child list")
            continue
        normalized_children = []
        for value in children:
            object_id = str(value or "")
            if object_id not in object_ids or object_id in seen_objects:
                invalid("scene group contains an unknown or duplicate object")
                continue
            normalized_children.append(object_id)
            seen_objects.add(object_id)
        output.append(
            {
                "type": "group",
                "group_id": group_id,
                "name": _clean_name(raw.get("name"), "Group", 80),
                "visible": raw.get("visible") is not False,
                "children": normalized_children,
            }
        )
        seen_groups.add(group_id)

    for item in objects:
        object_id = item["object_id"]
        if object_id not in seen_objects:
            output.append({"type": "object", "object_id": object_id})
    return output


def _remove_object_layer(layers: list[dict[str, Any]], object_id: str) -> None:
    layers[:] = [
        layer
        for layer in layers
        if not (layer.get("type") == "object" and layer.get("object_id") == object_id)
    ]
    for layer in layers:
        if layer.get("type") == "group":
            layer["children"] = [
                value for value in layer.get("children", []) if value != object_id
            ]


def _insert_duplicate_layer(
    layers: list[dict[str, Any]],
    source_id: str,
    duplicate_id: str,
) -> None:
    for index, layer in enumerate(layers):
        if layer.get("type") == "object" and layer.get("object_id") == source_id:
            layers.insert(index + 1, {"type": "object", "object_id": duplicate_id})
            return
        if layer.get("type") == "group":
            children = layer.get("children", [])
            if source_id in children:
                children.insert(children.index(source_id) + 1, duplicate_id)
                return
    layers.append({"type": "object", "object_id": duplicate_id})


def _visible_object_ids(scene: dict[str, Any]) -> set[str]:
    objects = {
        item["object_id"]: item
        for item in scene.get("objects", [])
        if isinstance(item, dict) and isinstance(item.get("object_id"), str)
    }
    hidden_building_ids = {
        building.get("building_id")
        for building in scene.get("architecture", {}).get("buildings", [])
        if isinstance(building, dict) and building.get("visible") is False
    }

    def object_is_visible(item: dict[str, Any]) -> bool:
        return (
            item.get("visible") is not False
            and item.get("building_id") not in hidden_building_ids
        )

    visible: set[str] = set()
    for layer in _normalize_scene_layers(scene):
        if layer["type"] == "object":
            object_id = layer["object_id"]
            if object_is_visible(objects[object_id]):
                visible.add(object_id)
            continue
        if layer.get("visible") is False:
            continue
        for object_id in layer["children"]:
            if object_is_visible(objects[object_id]):
                visible.add(object_id)
    return visible


def resolve_scene_dir(scene_id: str) -> Path:
    safe_id = _validate_id(scene_id, "scene id")
    root = _factory_root()
    target = (root / "scenes" / safe_id).resolve()
    if target.parent != (root / "scenes").resolve():
        raise ValueError("scene path escaped the Factory root")
    return target


def _scene_path(scene_id: str) -> Path:
    return resolve_scene_dir(scene_id) / "scene.json"


def _atomic_json(path: Path, value: Any) -> None:
    encoded = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
    if len(encoded) > MAX_SCENE_JSON_BYTES:
        raise ValueError("scene metadata is too large")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    try:
        temporary.write_bytes(encoded)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def _migrate_scene_to_ply_only(path: Path, scene: dict[str, Any]) -> None:
    """Keep PLY as the only permanent source and public export asset."""
    previous_schema_version = int(scene.get("schema_version", 0) or 0)
    if previous_schema_version >= SCHEMA_VERSION:
        return
    scene_root = path.parent.resolve()
    changed = True
    for item in scene.get("objects", []):
        if not isinstance(item, dict):
            continue
        files = item.get("files")
        if not isinstance(files, dict):
            continue
        ply_relative = files.get("ply")
        splat_relative = files.get("splat")
        if not isinstance(ply_relative, str) or not isinstance(splat_relative, str):
            continue
        ply_path = (scene_root / ply_relative).resolve()
        splat_path = (scene_root / splat_relative).resolve()
        if (
            scene_root not in ply_path.parents
            or scene_root not in splat_path.parents
            or not ply_path.is_file()
        ):
            continue
        if splat_path.is_file():
            try:
                digest = _verified_ply_sha256(
                    ply_path,
                    str(item.get("checksums", {}).get("ply_sha256") or ""),
                )
                info = inspect_ply(ply_path)
                cache_path = _splat_cache_root() / f"v1-{digest}.splat"
                with _SPLAT_CACHE_LOCK:
                    if (
                        splat_path.stat().st_size == info.vertex_count * 32
                        and not cache_path.is_file()
                    ):
                        os.replace(splat_path, cache_path)
                    else:
                        splat_path.unlink(missing_ok=True)
            except Exception:
                LOGGER.warning(
                    "Could not adopt legacy object SPLAT %s; it will be "
                    "regenerated from PLY when requested",
                    splat_path,
                    exc_info=True,
                )
                try:
                    splat_path.unlink()
                except OSError:
                    pass
        files.pop("splat", None)
        checksums = item.get("checksums")
        if isinstance(checksums, dict):
            checksums.pop("splat_sha256", None)
        validation = item.get("validation")
        if isinstance(validation, dict):
            validation.pop("splat", None)
        changed = True

    # Remove every retired scene/object export derivative. Canonical PLY files
    # remain and the browser SPLAT representation lives only in the shared
    # content-addressed cache.
    export_root = scene_root / "exports"
    if export_root.is_dir():
        for export_path in export_root.rglob("*"):
            if not export_path.is_file() or export_path.suffix.lower() == ".ply":
                continue
            try:
                export_path.unlink()
                changed = True
            except OSError:
                LOGGER.debug(
                    "Could not remove retired export asset %s",
                    export_path,
                    exc_info=True,
                )
    exports = scene.get("exports")
    if isinstance(exports, dict):
        allowed_keys = {
            "revision",
            "render_revision",
            "camera_fingerprint",
            "format_version",
            "ply_sha256",
            "created_at",
            "gaussians",
            "source_gaussians",
            "dropped_gaussians",
            "repaired_values",
            "objects",
            "files",
        }
        for key in list(exports):
            if key not in allowed_keys:
                exports.pop(key, None)
                changed = True
        files = exports.get("files")
        if isinstance(files, dict):
            for key in list(files):
                if key != "ply":
                    files.pop(key, None)
                    changed = True

    # Schema 9 temporarily created one mandatory empty Building for every
    # scene. Remove only that recognizable synthetic container. Any structure
    # with architecture or a user transform remains untouched.
    architecture = scene.get("architecture")
    legacy_buildings = architecture.get("buildings") if isinstance(architecture, dict) else None
    if previous_schema_version <= 9 and isinstance(legacy_buildings, list) and len(legacy_buildings) == 1:
        legacy = legacy_buildings[0] if isinstance(legacy_buildings[0], dict) else {}
        position = legacy.get("position")
        empty_architecture = not any(
            architecture.get(key) for key in ("walls", "rooms", "openings")
        )
        try:
            synthetic_transform = (
                isinstance(position, list)
                and len(position) == 3
                and all(abs(float(value or 0)) <= 1e-12 for value in position)
                and abs(float(legacy.get("rotation_y") or 0)) <= 1e-12
            )
        except (TypeError, ValueError):
            synthetic_transform = False
        if (
            empty_architecture
            and synthetic_transform
            and str(legacy.get("name") or "Building 1") == "Building 1"
            and legacy.get("locked") is not True
        ):
            removed_building_id = str(legacy.get("building_id") or "")
            architecture["buildings"] = []
            for item in scene.get("objects", []):
                if isinstance(item, dict) and item.get("building_id") == removed_building_id:
                    item["building_id"] = ""
            for camera in scene.get("cameras", []):
                if isinstance(camera, dict) and camera.get("building_id") == removed_building_id:
                    camera["building_id"] = ""
            for track in scene.get("camera_tracks", []):
                if isinstance(track, dict) and track.get("building_id") == removed_building_id:
                    track["building_id"] = ""
            lighting = scene.get("lighting")
            for light in lighting.get("lights", []) if isinstance(lighting, dict) else []:
                if isinstance(light, dict) and light.get("building_id") == removed_building_id:
                    light["building_id"] = ""
            changed = True

    scene["schema_version"] = SCHEMA_VERSION
    if changed:
        _atomic_json(path, scene)
        _prune_splat_cache()


def load_scene(scene_id: str) -> dict[str, Any]:
    path = _scene_path(scene_id)
    if not path.is_file():
        raise FileNotFoundError(f"Factory scene {_validate_id(scene_id, 'scene id')} was not found")
    if path.stat().st_size > MAX_SCENE_JSON_BYTES:
        raise ValueError("scene metadata is too large")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("scene_id") != scene_id:
        raise ValueError("scene metadata is invalid")
    if int(value.get("schema_version", 0) or 0) > MAX_READABLE_SCHEMA_VERSION:
        raise ValueError("This scene requires a newer 3D Factory version; the original scene was not changed")
    _migrate_scene_to_ply_only(path, value)
    if not isinstance(value.get("objects"), list):
        value["objects"] = []
    for item in value["objects"]:
        if not isinstance(item, dict):
            continue
        item.update(normalize_object_editor_properties(item))
    value["layers"] = _normalize_scene_layers(value)
    value["levels"] = normalize_levels(scene_id, value.get("levels"))
    valid_level_ids = {level["level_id"] for level in value["levels"]}
    default_level_id = value["levels"][0]["level_id"]
    for item in value["objects"]:
        if isinstance(item, dict) and item.get("level_id") not in valid_level_ids:
            item["level_id"] = default_level_id
    textures = []
    texture_ids: set[str] = set()
    for item in (
        value.get("textures") if isinstance(value.get("textures"), list) else []
    ):
        texture_id = str(item.get("texture_id") or "") if isinstance(item, dict) else ""
        if not _ID_RE.fullmatch(texture_id) or texture_id in texture_ids:
            continue
        textures.append(item)
        texture_ids.add(texture_id)
        if len(textures) >= 512:
            break
    value["textures"] = textures
    value["architecture"] = normalize_architecture(
        scene_id,
        value["levels"],
        value.get("architecture"),
    )
    valid_building_ids = {
        building["building_id"] for building in value["architecture"]["buildings"]
    }
    default_building_id = value["architecture"]["buildings"][0]["building_id"] \
        if value["architecture"]["buildings"] else ""
    for item in value["objects"]:
        if isinstance(item, dict) and item.get("building_id") not in valid_building_ids:
            item["building_id"] = default_building_id
    for material in value["architecture"].get("materials", []):
        for key in ("texture_id", "normal_texture_id", "roughness_texture_id"):
            if material.get(key) not in texture_ids:
                material.pop(key, None)
    value["render"] = _normalize_render_settings(value.get("render"))
    value["camera"] = _normalize_camera(value.get("camera"))
    value["cameras"] = _normalize_scene_cameras(value.get("cameras"))
    for camera in value["cameras"]:
        if camera.get("level_id") not in valid_level_ids:
            camera["level_id"] = default_level_id
        if camera.get("building_id") not in valid_building_ids:
            camera["building_id"] = default_building_id
    value["camera_tracks"] = normalize_camera_tracks(value.get("camera_tracks"))
    for track in value["camera_tracks"]:
        if track.get("building_id") not in valid_building_ids:
            track["building_id"] = default_building_id
    value["lighting"] = _normalize_lighting(value.get("lighting"))
    for light in value["lighting"].get("lights", []):
        if light.get("level_id") not in valid_level_ids:
            light["level_id"] = default_level_id
        if light.get("building_id") not in valid_building_ids:
            light["building_id"] = default_building_id
    skydome = _normalize_scene_skydome(value.get("skydome"))
    if skydome is None:
        value.pop("skydome", None)
    else:
        value["skydome"] = skydome
    value["render_revision"] = max(
        0,
        int(value.get("render_revision", value.get("revision", 0))),
    )
    value["edit_revision"] = max(
        0,
        int(value.get("edit_revision", value.get("revision", 0))),
    )
    value["schema_version"] = max(SCHEMA_VERSION, int(value.get("schema_version", SCHEMA_VERSION)))
    return value


def _save_scene(
    scene: dict[str, Any],
    *,
    bump_revision: bool = True,
    bump_edit_revision: bool | None = None,
) -> dict[str, Any]:
    scene_id = _validate_id(scene.get("scene_id"), "scene id")
    if bump_edit_revision is None:
        bump_edit_revision = bump_revision
    if bump_edit_revision:
        scene["edit_revision"] = max(0, int(scene.get("edit_revision", 0))) + 1
    if bump_revision:
        scene["revision"] = max(0, int(scene.get("revision", 0))) + 1
        scene["render_revision"] = max(
            0,
            int(scene.get("render_revision", scene["revision"] - 1)),
        ) + 1
    scene["updated_at"] = _now()
    _atomic_json(_scene_path(scene_id), scene)
    return scene


def upgrade_scene(scene_id: str) -> dict[str, Any]:
    """Opt into new features in a separate directory; keep the v11 original."""
    with _STATE_LOCK:
        source = load_scene(scene_id)
        if source.get("schema_version") == 12:
            return source
        original_root = resolve_scene_dir(scene_id)
        if any(path.is_symlink() for path in original_root.rglob("*")):
            raise ValueError("Scene upgrade cannot copy symbolic links")
        new_id = _new_id()
        new_root = resolve_scene_dir(new_id)
        created = False
        try:
            new_root.mkdir(parents=False, exist_ok=False)
            created = True
            shutil.copytree(original_root, new_root, dirs_exist_ok=True)
            upgraded = migrate_scene_11_to_12(source)
            upgraded["scene_id"] = new_id
            upgraded["name"] = _clean_name(f"{source.get('name', 'Scene')} · Editor 12", "Scene · Editor 12")
            upgraded["migration"] = {"source_scene_id": scene_id, "from_version": 11}
            upgraded.pop("capture_set", None)
            upgraded["exports"] = {}
            _save_scene(upgraded)
            return upgraded
        except Exception:
            if created:
                shutil.rmtree(new_root, ignore_errors=True)
            raise


def create_scene(name: Any = "") -> dict[str, Any]:
    scene_id = _new_id()
    timestamp = _now()
    scene = {
        "schema_version": SCHEMA_VERSION,
        "scene_id": scene_id,
        "name": _clean_name(name, "Untitled scene"),
        "revision": 0,
        "render_revision": 0,
        "edit_revision": 0,
        "created_at": timestamp,
        "updated_at": timestamp,
        "objects": [],
        "layers": [],
        "levels": normalize_levels(scene_id, None),
        "architecture": normalize_architecture(
            scene_id,
            normalize_levels(scene_id, None),
            {"buildings": [], "walls": [], "rooms": [], "openings": [], "materials": []},
        ),
        "render": dict(_DEFAULT_RENDER_SETTINGS),
        "camera": {
            "position": list(_DEFAULT_CAMERA["position"]),
            "target": list(_DEFAULT_CAMERA["target"]),
            "up": list(_DEFAULT_CAMERA["up"]),
            "fov": _DEFAULT_CAMERA["fov"],
        },
        "cameras": [],
        "camera_tracks": [],
        "textures": [],
        "lighting": _normalize_lighting(None),
        "exports": {},
    }
    with _STATE_LOCK:
        resolve_scene_dir(scene_id).mkdir(parents=True, exist_ok=False)
        _save_scene(scene, bump_revision=False, bump_edit_revision=False)
    return scene


def list_scenes(limit: int = 100) -> list[dict[str, Any]]:
    root = _factory_root() / "scenes"
    entries = []
    if not root.is_dir():
        return entries
    for path in root.iterdir():
        if not path.is_dir() or not _ID_RE.fullmatch(path.name):
            continue
        try:
            scene = load_scene(path.name)
            entries.append(
                {
                    "scene_id": scene["scene_id"],
                    "name": scene.get("name", "Untitled scene"),
                    "updated_at": float(scene.get("updated_at", 0)),
                    "created_at": float(scene.get("created_at", 0)),
                    "revision": int(scene.get("revision", 0)),
                    "object_count": len(scene.get("objects", [])),
                    "camera_count": len(scene.get("cameras", [])),
                }
            )
        except (OSError, ValueError, json.JSONDecodeError):
            LOGGER.warning("Skipping invalid Factory scene at %s", path, exc_info=True)
    entries.sort(key=lambda item: item["updated_at"], reverse=True)
    return entries[: max(1, min(500, int(limit)))]


def delete_scene(scene_id: str) -> dict[str, Any]:
    safe_id = _validate_id(scene_id, "scene id")
    with _STATE_LOCK:
        # Load the manifest before removing anything so missing or malformed
        # scenes fail without touching the filesystem.
        load_scene(safe_id)
        active_job = next(
            (
                job
                for job in _JOBS.values()
                if job.get("scene_id") == safe_id
                and job.get("status") in {"queued", "running"}
            ),
            None,
        )
        if active_job is not None:
            raise RuntimeError(
                "Scene cannot be deleted while its generation job is active"
            )
        target = resolve_scene_dir(safe_id)
        shutil.rmtree(target)
    return {"scene_id": safe_id, "deleted": True}


def _object_by_id(scene: dict[str, Any], object_id: str) -> dict[str, Any]:
    safe_id = _validate_id(object_id, "object id")
    for item in scene.get("objects", []):
        if isinstance(item, dict) and item.get("object_id") == safe_id:
            return item
    raise FileNotFoundError(f"Factory object {safe_id} was not found")


def _duplicate_object_name(scene: dict[str, Any], source_name: Any) -> str:
    existing = {
        str(item.get("name", "")).casefold()
        for item in scene.get("objects", [])
        if isinstance(item, dict)
    }
    base = _clean_name(source_name, "Object", 80)
    for index in range(1, 10_000):
        suffix = " — copy" if index == 1 else f" — copy {index}"
        candidate = f"{base[: max(1, 80 - len(suffix))]}{suffix}"
        if candidate.casefold() not in existing:
            return candidate
    raise ValueError("could not allocate a unique duplicate object name")


def create_primitive_object(scene_id: str, payload: Any) -> dict[str, Any]:
    safe_scene_id = _validate_id(scene_id, "scene id")
    data = payload if isinstance(payload, dict) else {}
    object_id = _new_id()
    object_root = resolve_scene_dir(safe_scene_id) / "objects" / object_id
    try:
        with _STATE_LOCK:
            scene = load_scene(safe_scene_id)
            normalized = normalize_object_editor_properties({
                "primitive": data.get("primitive"),
                "emission": data.get("emission"),
            })
            primitive = normalized.get("primitive")
            if not isinstance(primitive, dict):
                raise ValueError("primitive settings are required")
            if (primitive["kind"] not in {"image", "plane", "terrain"} or primitive.get("height_amplitude", 0) > 0) and scene.get("schema_version", 11) < 12:
                raise ValueError("Upgrade a copy of the scene to version 12 before adding parametric geometry")
            texture_id = primitive.get("texture_id")
            if texture_id and not any(
                isinstance(texture, dict) and texture.get("texture_id") == texture_id
                for texture in scene.get("textures", [])
            ):
                raise ValueError("primitive references an unknown scene texture")
            if primitive["kind"] == "image" and not texture_id:
                raise ValueError("image planes require a texture")
            object_root.mkdir(parents=True, exist_ok=False)
            if not texture_id:
                _write_imported_object_thumbnail(
                    object_root / "thumbnail.png",
                    primitive["kind"].upper(),
                )
            item = {
                "object_id": object_id,
                "asset_kind": "primitive",
                "name": _clean_name(data.get("name"), primitive["kind"].title(), 80),
                "created_at": _now(),
                "visible": True,
                "transform": normalize_transform(data.get("transform")),
                **normalize_object_editor_properties({
                    **normalized,
                    "collision_proxy": {"mode": "auto_box", "supports_objects": True},
                }),
                "source": {"type": "procedural_primitive"},
                "settings": {"source": "procedural_primitive"},
                "files": {},
                "level_id": scene["levels"][0]["level_id"],
                "building_id": (
                    scene["architecture"]["buildings"][0]["building_id"]
                    if scene["architecture"]["buildings"] else ""
                ),
            }
            scene["objects"].append(item)
            scene["layers"].append({"type": "object", "object_id": object_id})
            scene["exports"] = {}
            _save_scene(scene)
            return {"scene": scene, "object_id": object_id}
    except Exception:
        shutil.rmtree(object_root, ignore_errors=True)
        raise


def duplicate_object(scene_id: str, object_id: str) -> dict[str, Any]:
    safe_scene_id = _validate_id(scene_id, "scene id")
    safe_object_id = _validate_id(object_id, "object id")
    duplicate_id = _new_id()
    scene_root = resolve_scene_dir(safe_scene_id)
    duplicate_root = scene_root / "objects" / duplicate_id
    file_names = {
        "reference": "reference.png",
        "prepared": "prepared.png",
        "ply": "model.ply",
    }
    try:
        with _STATE_LOCK:
            scene = load_scene(safe_scene_id)
            source_item = _object_by_id(scene, safe_object_id)
            duplicate_root.mkdir(parents=True, exist_ok=False)
            duplicate_files: dict[str, str] = {}
            if source_item.get("asset_kind") == "primitive":
                thumbnail = resolve_scene_dir(safe_scene_id) / "objects" / safe_object_id / "thumbnail.png"
                if thumbnail.is_file():
                    target = duplicate_root / "thumbnail.png"
                    try:
                        os.link(thumbnail, target)
                    except OSError:
                        shutil.copy2(thumbnail, target)
            elif source_item.get("asset_kind") == "mesh":
                source_model = _object_file(safe_scene_id, source_item, "model")
                source_model_root = scene_root / "objects" / safe_object_id / "model"
                target_model_root = duplicate_root / "model"
                target_model_root.mkdir(parents=True, exist_ok=True)
                copied: dict[Path, Path] = {}
                for source in [source_model, *[
                    _object_model_resource(safe_scene_id, source_item, path)
                    for path in source_item.get("source", {}).get("resources", [])
                ]]:
                    if source in copied:
                        continue
                    relative = source.relative_to(source_model_root)
                    target = (target_model_root / relative).resolve()
                    if target_model_root.resolve() not in target.parents:
                        raise ValueError("model resource path escaped its root")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        os.link(source, target)
                    except OSError:
                        shutil.copy2(source, target)
                    copied[source] = target
                target_model = copied[source_model]
                duplicate_files["model"] = str(target_model.relative_to(scene_root))
                duplicate_files["resources"] = [
                    str(path.relative_to(scene_root))
                    for source, path in copied.items()
                    if source != source_model
                ]
            else:
                for key, file_name in file_names.items():
                    try:
                        source = _object_file(safe_scene_id, source_item, key)
                    except FileNotFoundError:
                        if key == "ply":
                            raise
                        continue
                    target = duplicate_root / file_name
                    try:
                        os.link(source, target)
                    except OSError:
                        shutil.copy2(source, target)
                    duplicate_files[key] = str(target.relative_to(scene_root))

            duplicate = json.loads(json.dumps(source_item))
            duplicate["object_id"] = duplicate_id
            duplicate["name"] = _duplicate_object_name(scene, source_item.get("name"))
            duplicate["created_at"] = _now()
            duplicate["transform"] = normalize_transform(source_item.get("transform"))
            duplicate["files"] = duplicate_files
            scene["objects"].append(duplicate)
            _insert_duplicate_layer(
                scene["layers"],
                source_item["object_id"],
                duplicate_id,
            )
            scene["exports"] = {}
            _save_scene(scene)
            return {"scene": scene, "object_id": duplicate_id}
    except Exception:
        try:
            shutil.rmtree(duplicate_root)
        except OSError:
            pass
        raise


def _write_imported_object_thumbnail(target: Path, label: str = "PLY") -> None:
    """Create a stable card thumbnail for an object without a source image."""
    size = OBJECT_THUMBNAIL_SIZE
    image = Image.new("RGB", size, "#12101a")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (18, 18, size[0] - 18, size[1] - 18),
        radius=28,
        fill="#1d1929",
        outline="#5b486a",
        width=3,
    )
    colors = ("#ff8fa3", "#b8a9e8", "#ffc1cf")
    points = (
        (74, 82, 12),
        (111, 62, 9),
        (148, 86, 13),
        (177, 118, 8),
        (145, 143, 11),
        (101, 137, 9),
        (72, 117, 7),
    )
    for index, (x, y, radius) in enumerate(points):
        color = colors[index % len(colors)]
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)
    text = _clean_name(label, "3D", 8).upper()
    draw.text((max(36, 128 - len(text) * 4), 177), text, fill="#e9e8f1")
    image.save(target, format="PNG", optimize=True)


def import_ply_object(
    scene_id: str,
    source: BinaryIO,
    file_name: Any = "model.ply",
    object_name: Any = "",
) -> dict[str, Any]:
    """Validate and commit an uploaded Gaussian PLY as a scene object."""
    safe_scene_id = _validate_id(scene_id, "scene id")
    raw_file_name = str(file_name or "model.ply").replace("\\", "/")
    safe_file_name = _clean_name(Path(raw_file_name).name, "model.ply", 160)
    fallback_name = Path(safe_file_name).stem or "Imported PLY"
    name = _clean_name(object_name, fallback_name, 80)
    object_id = _new_id()
    scene_root = resolve_scene_dir(safe_scene_id)
    object_root = scene_root / "objects" / object_id
    temporary = object_root / f".model.{secrets.token_hex(6)}.tmp"
    target = object_root / "model.ply"
    try:
        with _STATE_LOCK:
            load_scene(safe_scene_id)
            object_root.mkdir(parents=True, exist_ok=False)
        total = 0
        with temporary.open("wb") as output:
            while True:
                block = source.read(4 * 1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > MAX_PLY_UPLOAD_BYTES:
                    raise ValueError("PLY upload is too large")
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
        if total <= 0:
            raise ValueError("PLY upload is empty")

        inspect_ply(temporary)
        validate_ply_payload(temporary)
        # Uploaded PLY coordinates describe the appearance the user expects
        # to see. Factory's internal source convention is pre-canonical
        # TripoSplat space, so normalize the upload once here; the viewport
        # canonical matrix and a later object export then restore its original
        # world orientation instead of rotating it unexpectedly.
        normalized = export_gaussian_scene(
            [(temporary, normalize_transform({}))],
            target,
        )
        temporary.unlink(missing_ok=True)
        validation = normalized["ply"]["validation"]
        ply_hash = _sha256_file(target)
        _remember_ply_sha256(target, ply_hash)
        _write_imported_object_thumbnail(object_root / "thumbnail.png")

        relative_root = Path("objects") / object_id
        item = {
            "object_id": object_id,
            "name": name,
            "created_at": _now(),
            "visible": True,
            "transform": normalize_transform({}),
            **normalize_object_editor_properties({}),
            "gaussians": int(normalized["ply"]["gaussians"]),
            "source": {
                "type": "ply_import",
                "filename": safe_file_name,
                "size": total,
            },
            "checksums": {
                "ply_sha256": ply_hash,
            },
            "validation": {
                "ply": {
                    "invalid_values": validation["invalid_values"],
                    "invalid_scales": validation["invalid_scales"],
                    "invalid_quaternions": validation["invalid_quaternions"],
                },
            },
            "settings": {
                "source": "ply_import",
            },
            "files": {
                "ply": str(relative_root / "model.ply"),
            },
        }
        with _STATE_LOCK:
            scene = load_scene(safe_scene_id)
            item["level_id"] = scene["levels"][0]["level_id"]
            item["building_id"] = (
                scene["architecture"]["buildings"][0]["building_id"]
                if scene["architecture"]["buildings"] else ""
            )
            scene["objects"].append(item)
            scene["layers"].append({"type": "object", "object_id": object_id})
            scene["exports"] = {}
            _save_scene(scene)
        return {"scene": scene, "object_id": object_id}
    except Exception:
        shutil.rmtree(object_root, ignore_errors=True)
        raise


def _model_member_path(value: Any, fallback: str = "asset") -> Path:
    raw = str(value or fallback).replace("\\", "/")
    path = PurePosixPath(raw)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("model package contains an unsafe path")
    parts = []
    for index, part in enumerate(path.parts):
        if part in {"", "."}:
            continue
        part_fallback = fallback if index == len(path.parts) - 1 else "folder"
        cleaned = re.sub(
            r'[<>:"|?*]+',
            "_",
            _clean_name(part, part_fallback, 160),
        ).rstrip(" .")
        parts.append(cleaned or part_fallback)
    if not parts:
        parts = [fallback]
    return Path(*parts)


def _write_model_stream(source: BinaryIO, target: Path, remaining: list[int]) -> int:
    target.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with target.open("wb") as output:
        while True:
            block = source.read(4 * 1024 * 1024)
            if not block:
                break
            total += len(block)
            remaining[0] -= len(block)
            if total > MAX_MODEL_UPLOAD_BYTES or remaining[0] < 0:
                raise ValueError("3D model upload is too large")
            output.write(block)
    if total <= 0:
        raise ValueError("3D model upload contains an empty file")
    return total


def _standard_model_item(
    *,
    scene_root: Path,
    object_root: Path,
    model_root: Path,
    object_id: str,
    main: Path,
    resources: list[Path],
    logical_resources: list[str],
    object_name: Any,
    stored_bytes: int,
) -> dict[str, Any]:
    """Build the one canonical scene item used by every mesh import path."""
    model_format = main.suffix.lower().lstrip(".")
    name = _clean_name(object_name, main.stem or "Imported model", 80)
    thumbnail_path = object_root / "thumbnail.png"
    if not thumbnail_path.is_file():
        _write_imported_object_thumbnail(thumbnail_path, model_format)
    return {
        "object_id": object_id,
        "asset_kind": "mesh",
        "name": name,
        "created_at": _now(),
        "visible": True,
        "transform": normalize_transform({}),
        **normalize_object_editor_properties({}),
        "source": {
            "type": "model_import",
            "filename": main.name,
            "format": model_format,
            "model_path": main.relative_to(model_root).as_posix(),
            "resources": logical_resources,
            "file_count": 1 + len(resources),
            "size": stored_bytes,
        },
        "settings": {"source": "model_import"},
        "files": {
            "model": str(main.relative_to(scene_root)),
            "resources": [str(path.relative_to(scene_root)) for path in resources],
        },
    }


def import_model_object(
    scene_id: str,
    uploads: list[tuple[str, BinaryIO]],
    *,
    paths: list[str] | None = None,
    main_path: str = "",
    object_name: Any = "",
) -> dict[str, Any]:
    """Commit a textured mesh model and its sidecar resources to a scene."""
    safe_scene_id = _validate_id(scene_id, "scene id")
    if not uploads or len(uploads) > MAX_MODEL_UPLOAD_FILES:
        raise ValueError("a 3D model import must contain 1 to 512 files")
    object_id = _new_id()
    scene_root = resolve_scene_dir(safe_scene_id)
    object_root = scene_root / "objects" / object_id
    model_root = object_root / "model"
    requested_paths = paths if isinstance(paths, list) and len(paths) == len(uploads) else []
    remaining = [MAX_MODEL_UPLOAD_TOTAL_BYTES]
    uploaded_bytes = 0
    stored_files: list[Path] = []
    seen: set[str] = set()
    try:
        with _STATE_LOCK:
            load_scene(safe_scene_id)
            model_root.mkdir(parents=True, exist_ok=False)
        if len(uploads) == 1 and Path(uploads[0][0]).suffix.lower() == ".zip":
            archive_source = uploads[0][1]
            archive_source.seek(0)
            with zipfile.ZipFile(archive_source, "r", allowZip64=True) as archive:
                members = [member for member in archive.infolist() if not member.is_dir()]
                if not members or len(members) > MAX_MODEL_UPLOAD_FILES:
                    raise ValueError("3D model archive contains an invalid number of files")
                for member in members:
                    relative = _model_member_path(member.filename)
                    suffix = relative.suffix.lower()
                    if suffix not in _MODEL_FORMATS | _MODEL_RESOURCE_FORMATS:
                        continue
                    key = relative.as_posix().casefold()
                    if key in seen:
                        raise ValueError("3D model archive contains duplicate file paths")
                    seen.add(key)
                    target = (model_root / relative).resolve()
                    if model_root.resolve() not in target.parents:
                        raise ValueError("model package path escaped its root")
                    with archive.open(member) as source:
                        uploaded_bytes += _write_model_stream(source, target, remaining)
                    stored_files.append(target)
        else:
            for index, (filename, source) in enumerate(uploads):
                relative = _model_member_path(
                    requested_paths[index] if requested_paths else filename,
                    f"asset-{index + 1}",
                )
                suffix = relative.suffix.lower()
                if suffix not in _MODEL_FORMATS | _MODEL_RESOURCE_FORMATS:
                    raise ValueError(f"unsupported 3D model resource: {relative.name}")
                key = relative.as_posix().casefold()
                if key in seen:
                    raise ValueError("3D model import contains duplicate file paths")
                seen.add(key)
                target = (model_root / relative).resolve()
                if model_root.resolve() not in target.parents:
                    raise ValueError("model package path escaped its root")
                source.seek(0)
                uploaded_bytes += _write_model_stream(source, target, remaining)
                stored_files.append(target)

        model_candidates = [path for path in stored_files if path.suffix.lower() in _MODEL_FORMATS]
        if not model_candidates:
            raise ValueError("no supported 3D model was found; use GLB, glTF, FBX, OBJ, or STL")
        preferred = _model_member_path(main_path).as_posix().casefold() if main_path else ""
        main = next(
            (path for path in model_candidates if path.relative_to(model_root).as_posix().casefold() == preferred),
            None,
        )
        format_order = {".glb": 0, ".gltf": 1, ".fbx": 2, ".obj": 3, ".stl": 4}
        if main is None:
            main = min(
                model_candidates,
                key=lambda path: (
                    format_order[path.suffix.lower()],
                    len(path.relative_to(model_root).parts),
                    path.as_posix().casefold(),
                ),
            )
        resources = [path for path in stored_files if path != main]
        logical_resources = []
        for path in resources:
            try:
                logical = path.relative_to(main.parent)
            except ValueError:
                logical = path.relative_to(model_root)
            logical_resources.append(logical.as_posix())
        if len({path.casefold() for path in logical_resources}) != len(logical_resources):
            raise ValueError("3D model resources resolve to duplicate paths")
        item = _standard_model_item(
            scene_root=scene_root,
            object_root=object_root,
            model_root=model_root,
            object_id=object_id,
            main=main,
            resources=resources,
            logical_resources=logical_resources,
            object_name=object_name,
            stored_bytes=uploaded_bytes,
        )
        with _STATE_LOCK:
            scene = load_scene(safe_scene_id)
            item["level_id"] = scene["levels"][0]["level_id"]
            item["building_id"] = (
                scene["architecture"]["buildings"][0]["building_id"]
                if scene["architecture"]["buildings"] else ""
            )
            scene["objects"].append(item)
            scene["layers"].append({"type": "object", "object_id": object_id})
            scene["exports"] = {}
            _save_scene(scene)
        return {"scene": scene, "object_id": object_id}
    except Exception:
        shutil.rmtree(object_root, ignore_errors=True)
        raise


def _object_file(scene_id: str, item: dict[str, Any], key: str) -> Path:
    relative = item.get("files", {}).get(key)
    if not isinstance(relative, str) or not relative:
        raise FileNotFoundError(f"object has no {key} asset")
    root = resolve_scene_dir(scene_id)
    target = (root / relative).resolve()
    if root not in target.parents or not target.is_file():
        raise FileNotFoundError(f"object {key} asset is missing")
    return target


def _object_model_resource(scene_id: str, item: dict[str, Any], path: Any) -> Path:
    logical = _model_member_path(path).as_posix()
    logical_paths = item.get("source", {}).get("resources", [])
    stored_paths = item.get("files", {}).get("resources", [])
    if not isinstance(logical_paths, list) or not isinstance(stored_paths, list):
        raise FileNotFoundError("object has no model resources")
    try:
        index = logical_paths.index(logical)
        relative = stored_paths[index]
    except (ValueError, IndexError):
        raise FileNotFoundError("model resource was not found") from None
    if not isinstance(relative, str) or not relative:
        raise FileNotFoundError("model resource metadata is invalid")
    root = resolve_scene_dir(scene_id)
    target = (root / relative).resolve()
    if root not in target.parents or not target.is_file():
        raise FileNotFoundError("model resource is missing")
    return target


def _scene_reference_file(scene: dict[str, Any]) -> Path:
    relative = scene.get("reference", {}).get("file")
    if not isinstance(relative, str) or not relative:
        raise FileNotFoundError("scene has no saved reference image")
    root = resolve_scene_dir(scene["scene_id"])
    target = (root / relative).resolve()
    if root not in target.parents or not target.is_file():
        raise FileNotFoundError("scene reference image is missing")
    return target


def _scene_reference_preview_file(scene: dict[str, Any]) -> Path:
    root = resolve_scene_dir(scene["scene_id"])
    relative = scene.get("reference", {}).get("preview_file")
    if isinstance(relative, str) and relative:
        target = (root / relative).resolve()
        if root in target.parents and target.is_file():
            return target
    for target in sorted((root / "reference").glob("preview.*")):
        if target.is_file():
            return target
    return _scene_reference_file(scene)


def _scene_skydome_file(scene: dict[str, Any]) -> Path:
    relative = scene.get("skydome", {}).get("file")
    if not isinstance(relative, str) or not relative:
        raise FileNotFoundError("scene has no skydome image")
    root = resolve_scene_dir(scene["scene_id"])
    target = (root / relative).resolve()
    if root not in target.parents or not target.is_file():
        raise FileNotFoundError("scene skydome image is missing")
    return target


def _scene_skydome_viewport_file(scene: dict[str, Any]) -> Path:
    root = resolve_scene_dir(scene["scene_id"])
    relative = scene.get("skydome", {}).get("viewport_file")
    if isinstance(relative, str) and relative:
        target = (root / relative).resolve()
        if root in target.parents and target.is_file():
            return target
    for target in sorted((root / "skydome").glob("viewport.*")):
        if target.is_file():
            return target
    return _scene_skydome_file(scene)


def _write_browser_preview(
    image: Image.Image,
    directory: Path,
    stem: str,
    maximum_size: tuple[int, int],
    quality: int,
) -> tuple[Path, str, int, int]:
    preview = ImageOps.exif_transpose(image).copy()
    preview.thumbnail(maximum_size, Image.Resampling.LANCZOS)
    if preview.mode not in {"RGB", "RGBA"}:
        preview = preview.convert("RGBA" if "transparency" in preview.info else "RGB")
    directory.mkdir(parents=True, exist_ok=True)
    attempts = [
        (directory / f"{stem}.webp", "WEBP", "image/webp", {"quality": quality, "method": 4}),
        (directory / f"{stem}.png", "PNG", "image/png", {"optimize": True}),
    ]
    last_error: Exception | None = None
    for target, image_format, mime, options in attempts:
        temporary = directory / f".{stem}.{secrets.token_hex(6)}.tmp"
        try:
            preview.save(temporary, format=image_format, **options)
            os.replace(temporary, target)
            for candidate in directory.glob(f"{stem}.*"):
                if candidate != target:
                    candidate.unlink(missing_ok=True)
            return target, mime, preview.width, preview.height
        except Exception as exc:
            last_error = exc
        finally:
            temporary.unlink(missing_ok=True)
    raise RuntimeError("could not create browser image preview") from last_error


def _ensure_scene_reference_preview(scene: dict[str, Any]) -> Path:
    source = _scene_reference_file(scene)
    existing = _scene_reference_preview_file(scene)
    if existing != source:
        return existing
    with Image.open(source) as image:
        image.load()
        target, _mime, _width, _height = _write_browser_preview(
            image,
            source.parent,
            "preview",
            REFERENCE_PREVIEW_SIZE,
            84,
        )
    return target


def _ensure_scene_skydome_viewport(scene: dict[str, Any]) -> Path:
    source = _scene_skydome_file(scene)
    existing = _scene_skydome_viewport_file(scene)
    if existing != source:
        return existing
    with Image.open(source) as image:
        image.load()
        target, _mime, _width, _height = _write_browser_preview(
            image,
            source.parent,
            "viewport",
            SKYDOME_VIEWPORT_SIZE,
            88,
        )
    return target


def _ensure_object_thumbnail(scene_id: str, item: dict[str, Any]) -> Path:
    if item.get("asset_kind") == "primitive":
        texture_id = item.get("primitive", {}).get("texture_id")
        if texture_id:
            return _scene_texture_file(load_scene(scene_id), texture_id)
        target = resolve_scene_dir(scene_id) / "objects" / item["object_id"] / "thumbnail.png"
        if not target.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            _write_imported_object_thumbnail(
                target,
                str(item.get("primitive", {}).get("kind") or "plane").upper(),
            )
        return target
    if item.get("asset_kind") == "mesh":
        _object_file(scene_id, item, "model")
        object_root = resolve_scene_dir(scene_id) / "objects" / item["object_id"]
        for target in sorted(object_root.glob("thumbnail.*")):
            if target.is_file():
                return target
        target = object_root / "thumbnail.png"
        _write_imported_object_thumbnail(target, item.get("source", {}).get("format", "3D"))
        return target
    ply = _object_file(scene_id, item, "ply")
    for target in sorted(ply.parent.glob("thumbnail.*")):
        if target.is_file():
            return target
    try:
        source = _object_file(scene_id, item, "prepared")
    except FileNotFoundError:
        try:
            source = _object_file(scene_id, item, "reference")
        except FileNotFoundError:
            target = ply.parent / "thumbnail.png"
            _write_imported_object_thumbnail(target)
            return target
    with Image.open(source) as image:
        image.load()
        target, _mime, _width, _height = _write_browser_preview(
            image,
            source.parent,
            "thumbnail",
            OBJECT_THUMBNAIL_SIZE,
            82,
        )
    return target


def _scene_preview_file(
    scene: dict[str, Any],
    expected_capture_token: str = "",
) -> Path:
    preview = scene.get("preview", {})
    relative = preview.get("file") if isinstance(preview, dict) else None
    if not isinstance(relative, str) or not relative:
        raise FileNotFoundError("scene has no saved 3D preview")
    if int(preview.get("revision", -1)) != int(scene.get("revision", 0)):
        raise FileNotFoundError("scene 3D preview is stale")
    if int(preview.get("render_revision", preview.get("revision", -1))) != int(
        scene.get("render_revision", scene.get("revision", 0))
    ):
        raise FileNotFoundError("scene 3D preview camera or resolution is stale")
    render = _normalize_render_settings(scene.get("render"))
    if (
        int(preview.get("width", 0)) != render["width"]
        or int(preview.get("height", 0)) != render["height"]
    ):
        raise FileNotFoundError("scene 3D preview dimensions do not match the export frame")
    if expected_capture_token and preview.get("capture_token") != expected_capture_token:
        raise FileNotFoundError("scene 3D preview has not completed this execution capture")
    root = resolve_scene_dir(scene["scene_id"])
    target = (root / relative).resolve()
    if root not in target.parents or not target.is_file():
        raise FileNotFoundError("scene 3D preview is missing")
    return target


def _scene_capture_files(
    scene: dict[str, Any],
    expected_capture_token: str = "",
) -> list[Path]:
    capture_set = scene.get("capture_set")
    if not isinstance(capture_set, dict):
        raise FileNotFoundError("scene has no saved camera capture set")
    if (
        expected_capture_token
        and capture_set.get("capture_token") != expected_capture_token
    ):
        raise FileNotFoundError("scene camera captures have not completed this execution")
    if int(capture_set.get("revision", -1)) != int(scene.get("revision", 0)):
        raise FileNotFoundError("scene camera captures are stale")
    if int(capture_set.get("render_revision", -1)) != int(
        scene.get("render_revision", scene.get("revision", 0))
    ):
        raise FileNotFoundError("scene camera captures use stale render settings")
    render = _normalize_render_settings(scene.get("render"))
    if (
        int(capture_set.get("width", 0)) != render["width"]
        or int(capture_set.get("height", 0)) != render["height"]
    ):
        raise FileNotFoundError("scene camera capture dimensions do not match Scene Export")
    camera_entries = capture_set.get("cameras")
    if not isinstance(camera_entries, list):
        raise FileNotFoundError("scene camera capture manifest is invalid")
    expected_ids = [
        camera["camera_id"] for camera in _normalize_scene_cameras(scene.get("cameras"))
    ]
    captured_ids = [
        str(entry.get("camera_id", ""))
        for entry in camera_entries
        if isinstance(entry, dict)
    ]
    if captured_ids != expected_ids or len(camera_entries) != len(expected_ids):
        raise FileNotFoundError("scene camera capture set does not match the saved cameras")

    root = resolve_scene_dir(scene["scene_id"])

    def capture_path(entry: Any) -> Path:
        relative = entry.get("file") if isinstance(entry, dict) else None
        if not isinstance(relative, str) or not relative:
            raise FileNotFoundError("scene camera capture path is missing")
        target = (root / relative).resolve()
        if root not in target.parents or not target.is_file():
            raise FileNotFoundError("scene camera capture file is missing")
        return target

    paths = [capture_path(capture_set.get("current"))]
    paths.extend(capture_path(entry) for entry in camera_entries)
    return paths


def store_scene_reference(
    scene_id: str,
    image_bytes: bytes,
    file_name: Any = "reference.png",
) -> dict[str, Any]:
    image = _decode_image(image_bytes)
    safe_name = _clean_name(file_name, "reference.png", 160)
    root = resolve_scene_dir(scene_id)
    reference_root = root / "reference"
    reference_root.mkdir(parents=True, exist_ok=True)
    target = reference_root / "source.png"
    temporary = reference_root / f".source.{secrets.token_hex(6)}.tmp"
    try:
        image.save(temporary, format="PNG")
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass
    preview_target, preview_mime, preview_width, preview_height = _write_browser_preview(
        image,
        reference_root,
        "preview",
        REFERENCE_PREVIEW_SIZE,
        84,
    )
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        scene["reference"] = {
            "file": str(target.relative_to(root)),
            "name": safe_name,
            "mime": "image/png",
            "width": image.width,
            "height": image.height,
            "size": target.stat().st_size,
            "preview_file": str(preview_target.relative_to(root)),
            "preview_mime": preview_mime,
            "preview_width": preview_width,
            "preview_height": preview_height,
            "preview_size": preview_target.stat().st_size,
            "updated_at": _now(),
        }
        _save_scene(scene, bump_revision=False, bump_edit_revision=True)
        return scene


def _inspect_skydome_image(image_bytes: bytes) -> tuple[str, str, int, int]:
    if not image_bytes or len(image_bytes) > MAX_SKYDOME_BYTES:
        raise ValueError("skydome image is empty or too large")
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            image_format = str(image.format or "").upper()
            width, height = image.size
            if (
                width <= 0
                or height <= 0
                or width > 16384
                or height > 16384
                or width * height > MAX_SKYDOME_PIXELS
            ):
                raise ValueError("skydome image dimensions are too large")
            image.verify()
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("skydome image is invalid") from exc
    formats = {
        "JPEG": (".jpg", "image/jpeg"),
        "PNG": (".png", "image/png"),
        "WEBP": (".webp", "image/webp"),
    }
    if image_format not in formats:
        raise ValueError("skydome must be a JPEG, PNG, or WebP image")
    suffix, mime = formats[image_format]
    return suffix, mime, width, height


def store_scene_skydome(
    scene_id: str,
    image_bytes: bytes,
    file_name: Any = "skydome.jpg",
) -> dict[str, Any]:
    suffix, mime, width, height = _inspect_skydome_image(image_bytes)
    root = resolve_scene_dir(scene_id)
    skydome_root = root / "skydome"
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        previous = _normalize_scene_skydome(scene.get("skydome"))
        skydome_root.mkdir(parents=True, exist_ok=True)
        target = skydome_root / f"source{suffix}"
        temporary = skydome_root / f".source.{secrets.token_hex(6)}.tmp"
        try:
            temporary.write_bytes(image_bytes)
            for candidate in skydome_root.glob("source.*"):
                if candidate != target:
                    candidate.unlink(missing_ok=True)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        with Image.open(io.BytesIO(image_bytes)) as image:
            image.load()
            viewport_target, viewport_mime, viewport_width, viewport_height = (
                _write_browser_preview(
                    image,
                    skydome_root,
                    "viewport",
                    SKYDOME_VIEWPORT_SIZE,
                    88,
                )
            )
        settings = _normalize_skydome_settings(previous)
        scene["skydome"] = {
            "skydome_id": (
                previous["skydome_id"]
                if previous is not None
                else _new_id()
            ),
            "type": "skydome",
            "name": _clean_name(
                Path(str(file_name or "")).stem,
                previous.get("name", "Skydome") if previous else "Skydome",
                96,
            ),
            "projection": "equirectangular",
            "file": str(target.relative_to(root)),
            "mime": mime,
            "width": width,
            "height": height,
            "size": target.stat().st_size,
            "viewport_file": str(viewport_target.relative_to(root)),
            "viewport_mime": viewport_mime,
            "viewport_width": viewport_width,
            "viewport_height": viewport_height,
            "viewport_size": viewport_target.stat().st_size,
            "updated_at": _now(),
            **settings,
        }
        scene["render_revision"] = max(
            0,
            int(scene.get("render_revision", scene.get("revision", 0))),
        ) + 1
        return _save_scene(scene, bump_revision=False, bump_edit_revision=True)


def remove_scene_skydome(scene_id: str) -> dict[str, Any]:
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        if not isinstance(scene.get("skydome"), dict):
            raise FileNotFoundError("scene has no skydome")
        scene.pop("skydome", None)
        target = resolve_scene_dir(scene_id) / "skydome"
        if target.is_dir() and target.parent == resolve_scene_dir(scene_id):
            shutil.rmtree(target)
        scene["render_revision"] = max(
            0,
            int(scene.get("render_revision", scene.get("revision", 0))),
        ) + 1
        return _save_scene(scene, bump_revision=False, bump_edit_revision=True)


def _scene_texture_file(scene: dict[str, Any], texture_id: Any) -> Path:
    normalized_id = _validate_id(texture_id, "texture id")
    entry = next(
        (
            item for item in scene.get("textures", [])
            if isinstance(item, dict) and item.get("texture_id") == normalized_id
        ),
        None,
    )
    if entry is None:
        raise FileNotFoundError("scene texture was not found")
    relative = entry.get("file")
    root = resolve_scene_dir(scene["scene_id"])
    target = (root / str(relative or "")).resolve()
    if root not in target.parents or not target.is_file():
        raise FileNotFoundError("scene texture file is missing")
    return target


def store_scene_texture(
    scene_id: str,
    image_bytes: bytes,
    file_name: Any = "texture.png",
) -> tuple[dict[str, Any], dict[str, Any]]:
    image = _decode_image(image_bytes, max_bytes=MAX_TEXTURE_BYTES).convert("RGBA")
    if image.width > 8192 or image.height > 8192 or image.width * image.height > 67_108_864:
        raise ValueError("texture dimensions are too large")
    texture_id = _new_id()
    root = resolve_scene_dir(scene_id)
    texture_root = root / "textures"
    texture_root.mkdir(parents=True, exist_ok=True)
    target = texture_root / f"{texture_id}.png"
    temporary = texture_root / f".{texture_id}.{secrets.token_hex(6)}.tmp"
    try:
        image.save(temporary, format="PNG", optimize=True)
        os.replace(temporary, target)
        with _STATE_LOCK:
            scene = load_scene(scene_id)
            if len(scene.get("textures", [])) >= 512:
                raise ValueError("scene texture limit was exceeded")
            entry = {
                "texture_id": texture_id,
                "name": _clean_name(Path(str(file_name or "")).stem, "Texture", 80),
                "file": str(target.relative_to(root)),
                "mime": "image/png",
                "width": image.width,
                "height": image.height,
                "size": target.stat().st_size,
                "updated_at": _now(),
            }
            scene.setdefault("textures", []).append(entry)
            saved = _save_scene(scene, bump_revision=False, bump_edit_revision=True)
            return saved, entry
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        temporary.unlink(missing_ok=True)


def remove_scene_texture(scene_id: str, texture_id: Any) -> dict[str, Any]:
    normalized_id = _validate_id(texture_id, "texture id")
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        target = _scene_texture_file(scene, normalized_id)
        before = len(scene.get("textures", []))
        scene["textures"] = [
            item for item in scene.get("textures", [])
            if item.get("texture_id") != normalized_id
        ]
        if len(scene["textures"]) == before:
            raise FileNotFoundError("scene texture was not found")
        for material in scene.get("architecture", {}).get("materials", []):
            for key in ("texture_id", "normal_texture_id", "roughness_texture_id"):
                if material.get(key) == normalized_id:
                    material.pop(key, None)
        for item in scene.get("objects", []):
            primitive = item.get("primitive")
            if isinstance(primitive, dict) and primitive.get("texture_id") == normalized_id:
                primitive.pop("texture_id", None)
        scene["render_revision"] = max(
            0,
            int(scene.get("render_revision", scene.get("revision", 0))),
        ) + 1
        saved = _save_scene(scene, bump_revision=False, bump_edit_revision=True)
        try:
            target.unlink(missing_ok=True)
        except OSError:
            LOGGER.warning("Could not remove retired scene texture %s", target, exc_info=True)
        return saved


def store_scene_preview(
    scene_id: str,
    image_bytes: bytes,
    expected_revision: Any = None,
    expected_render_revision: Any = None,
    capture_token: Any = "",
) -> dict[str, Any]:
    """Persist a clean render of the current browser-side 3D viewport."""
    image = _decode_image(image_bytes, max_bytes=MAX_PREVIEW_BYTES).convert("RGB")
    if image.width < 64 or image.height < 64:
        raise ValueError(
            f"scene preview is only {image.width}x{image.height}; "
            "the 3D viewport did not produce a valid export render"
        )
    root = resolve_scene_dir(scene_id)
    preview_root = root / "preview"
    preview_root.mkdir(parents=True, exist_ok=True)
    target = preview_root / "scene.png"
    temporary = preview_root / f".scene.{secrets.token_hex(6)}.tmp"
    normalized_capture_token = str(capture_token or "")
    if normalized_capture_token and not _ID_RE.fullmatch(normalized_capture_token):
        raise ValueError("scene preview capture token is invalid")
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        if expected_revision is not None:
            try:
                revision = int(expected_revision)
            except (TypeError, ValueError) as exc:
                raise ValueError("scene preview revision is invalid") from exc
            if revision != int(scene.get("revision", 0)):
                raise ValueError("scene changed while its preview was being rendered")
        if expected_render_revision is not None:
            try:
                render_revision = int(expected_render_revision)
            except (TypeError, ValueError) as exc:
                raise ValueError("scene preview render revision is invalid") from exc
            if render_revision != int(
                scene.get("render_revision", scene.get("revision", 0))
            ):
                raise ValueError(
                    "scene camera or export frame changed while its preview was being rendered"
                )
        render = _normalize_render_settings(scene.get("render"))
        if (image.width, image.height) != (render["width"], render["height"]):
            raise ValueError(
                f"scene preview is {image.width}x{image.height}; "
                f"the configured export frame is {render['width']}x{render['height']}"
            )
        try:
            image.save(temporary, format="PNG")
            os.replace(temporary, target)
        finally:
            try:
                temporary.unlink()
            except OSError:
                pass
        scene["preview"] = {
            "file": str(target.relative_to(root)),
            "mime": "image/png",
            "width": image.width,
            "height": image.height,
            "size": target.stat().st_size,
            "revision": int(scene.get("revision", 0)),
            "render_revision": int(
                scene.get("render_revision", scene.get("revision", 0))
            ),
            "capture_token": normalized_capture_token,
            "updated_at": _now(),
        }
        scene["preview_sync"] = {
            "capture_token": normalized_capture_token,
            "status": "completed",
            "error": "",
            "updated_at": _now(),
        }
        _save_scene(scene, bump_revision=False)
        return scene


def store_scene_capture_set(
    scene_id: str,
    current_image_bytes: Any,
    camera_images: dict[str, Any],
    camera_ids: Any,
    expected_revision: Any,
    expected_render_revision: Any,
    capture_token: Any,
) -> dict[str, Any]:
    """Atomically persist the execution frame followed by every saved camera."""
    normalized_capture_token = str(capture_token or "")
    if not _ID_RE.fullmatch(normalized_capture_token):
        raise ValueError("scene camera capture token is invalid")
    if not isinstance(camera_ids, list) or len(camera_ids) > MAX_SCENE_CAMERAS:
        raise ValueError("scene camera capture ids are invalid")
    normalized_ids = [
        _validate_id(camera_id, "camera id") for camera_id in camera_ids
    ]
    if len(set(normalized_ids)) != len(normalized_ids):
        raise ValueError("scene camera capture ids must be unique")
    if set(camera_images) != set(normalized_ids):
        raise ValueError("scene camera capture images do not match their ids")
    try:
        revision = int(expected_revision)
        render_revision = int(expected_render_revision)
    except (TypeError, ValueError) as exc:
        raise ValueError("scene camera capture revision is invalid") from exc

    with _STATE_LOCK:
        initial_scene = load_scene(scene_id)
        initial_ids = [
            camera["camera_id"]
            for camera in _normalize_scene_cameras(initial_scene.get("cameras"))
        ]
        if revision != int(initial_scene.get("revision", 0)):
            raise ValueError("scene changed while its cameras were being rendered")
        if render_revision != int(
            initial_scene.get("render_revision", initial_scene.get("revision", 0))
        ):
            raise ValueError(
                "scene camera or export frame changed while cameras were being rendered"
            )
        if normalized_ids != initial_ids:
            raise ValueError("saved cameras changed while they were being rendered")
        render = _normalize_render_settings(initial_scene.get("render"))

    root = resolve_scene_dir(scene_id)
    captures_root = root / "preview" / "captures"
    captures_root.mkdir(parents=True, exist_ok=True)
    temporary_root = captures_root / (
        f".{normalized_capture_token}.{secrets.token_hex(6)}.tmp"
    )
    final_root = captures_root / normalized_capture_token
    temporary_root.mkdir(parents=False, exist_ok=False)

    def save_capture(source: Any, target: Path) -> None:
        if hasattr(source, "read"):
            try:
                source.seek(0)
            except (OSError, AttributeError):
                pass
            image_bytes = source.read(MAX_PREVIEW_BYTES + 1)
        else:
            image_bytes = bytes(source or b"")
        image = _decode_image(image_bytes, max_bytes=MAX_PREVIEW_BYTES).convert("RGB")
        if (image.width, image.height) != (render["width"], render["height"]):
            raise ValueError(
                f"scene camera capture is {image.width}x{image.height}; "
                f"Scene Export is {render['width']}x{render['height']}"
            )
        image.save(target, format="PNG")

    try:
        save_capture(current_image_bytes, temporary_root / "current.png")
        for camera_id in normalized_ids:
            save_capture(camera_images[camera_id], temporary_root / f"{camera_id}.png")

        with _STATE_LOCK:
            scene = load_scene(scene_id)
            current_ids = [
                camera["camera_id"]
                for camera in _normalize_scene_cameras(scene.get("cameras"))
            ]
            if revision != int(scene.get("revision", 0)):
                raise ValueError("scene changed while its cameras were being rendered")
            if render_revision != int(
                scene.get("render_revision", scene.get("revision", 0))
            ):
                raise ValueError(
                    "scene camera or export frame changed while cameras were being rendered"
                )
            if normalized_ids != current_ids:
                raise ValueError("saved cameras changed while they were being rendered")

            if final_root.is_dir():
                shutil.rmtree(final_root)
            os.replace(temporary_root, final_root)
            canonical_target = root / "preview" / "scene.png"
            canonical_temporary = root / "preview" / (
                f".scene.{secrets.token_hex(6)}.tmp"
            )
            try:
                shutil.copyfile(final_root / "current.png", canonical_temporary)
                os.replace(canonical_temporary, canonical_target)
            finally:
                canonical_temporary.unlink(missing_ok=True)

            current_relative = str((final_root / "current.png").relative_to(root))
            camera_entries = [
                {
                    "camera_id": camera_id,
                    "file": str((final_root / f"{camera_id}.png").relative_to(root)),
                }
                for camera_id in normalized_ids
            ]
            timestamp = _now()
            scene["capture_set"] = {
                "capture_token": normalized_capture_token,
                "revision": revision,
                "render_revision": render_revision,
                "width": render["width"],
                "height": render["height"],
                "current": {"file": current_relative},
                "cameras": camera_entries,
                "updated_at": timestamp,
            }
            scene["preview"] = {
                "file": str(canonical_target.relative_to(root)),
                "mime": "image/png",
                "width": render["width"],
                "height": render["height"],
                "size": canonical_target.stat().st_size,
                "revision": revision,
                "render_revision": render_revision,
                "capture_token": normalized_capture_token,
                "updated_at": timestamp,
            }
            scene["preview_sync"] = {
                "capture_token": normalized_capture_token,
                "status": "completed",
                "error": "",
                "camera_count": len(normalized_ids),
                "updated_at": timestamp,
            }
            _save_scene(scene, bump_revision=False)

        for candidate in captures_root.iterdir():
            if candidate == final_root or candidate.name.startswith("."):
                continue
            if candidate.is_dir():
                shutil.rmtree(candidate, ignore_errors=True)
        return scene
    except Exception:
        shutil.rmtree(temporary_root, ignore_errors=True)
        raise


def store_scene_preview_error(
    scene_id: str,
    capture_token: Any,
    error: Any,
) -> dict[str, Any]:
    normalized_capture_token = str(capture_token or "")
    if not _ID_RE.fullmatch(normalized_capture_token):
        raise ValueError("scene preview capture token is invalid")
    message = str(error or "3D viewport capture failed").strip()[:2048]
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        scene["preview_sync"] = {
            "capture_token": normalized_capture_token,
            "status": "failed",
            "error": message or "3D viewport capture failed",
            "updated_at": _now(),
        }
        _save_scene(scene, bump_revision=False)
        return scene


def _weight_candidates(relative: str) -> list[Path]:
    root = _model_root()
    relative_path = Path(relative)
    candidates = [root / relative_path]
    category = relative_path.parts[0]
    filename = Path(*relative_path.parts[1:])
    candidates.extend(path / filename for path in _category_roots(category))
    # Builds produced before the standard ComfyUI directory fix stored the
    # same upstream tree under models/TripoSplat. Keep those files usable.
    candidates.append(root / "TripoSplat" / relative_path)
    unique = []
    seen = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        key = os.path.normcase(str(resolved))
        if key not in seen:
            seen.add(key)
            unique.append(resolved)
    return unique


def _valid_weight(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def _weight_paths() -> dict[str, Path]:
    output = {}
    for relative in _WEIGHT_FILES:
        candidates = _weight_candidates(relative)
        output[relative] = next((path for path in candidates if _valid_weight(path)), candidates[0])
    return output


def _provider_weight_files(provider: Any) -> tuple[str, ...]:
    key = factory3d_generation.normalize_provider(provider)
    if key == factory3d_generation.TRIPOSPLAT:
        return _WEIGHT_FILES
    return factory3d_generation.PROVIDER_WEIGHT_FILES[key]


def _provider_weight_paths(provider: Any) -> dict[str, Path]:
    return {
        relative: next(
            (path for path in _weight_candidates(relative) if _valid_weight(path)),
            _weight_candidates(relative)[0],
        )
        for relative in _provider_weight_files(provider)
    }


def _provider_weights_status(provider: Any) -> dict[str, Any]:
    key = factory3d_generation.normalize_provider(provider)
    files = []
    ready = True
    total_size = 0
    for relative, path in _provider_weight_paths(key).items():
        exists = _valid_weight(path)
        size = path.stat().st_size if exists else 0
        total_size += size
        ready = ready and exists
        spec = factory3d_generation.WEIGHT_SPECS.get(relative, {})
        files.append(
            {
                "path": relative,
                "ready": exists,
                "size": size,
                "resolved_path": str(path),
                "searched_paths": [str(candidate) for candidate in _weight_candidates(relative)],
                "repository": spec.get("repo_id", UPSTREAM_REPOSITORY),
                "revision": spec.get("revision", UPSTREAM_HF_REVISION),
            }
        )
    repositories = sorted({str(item["repository"]) for item in files})
    return {
        "ready": ready,
        "root": str(_model_root()),
        "files": files,
        "installed_bytes": total_size,
        "repository": repositories[0] if len(repositories) == 1 else "multiple",
        "repositories": repositories,
    }


def _weights_status() -> dict[str, Any]:
    return _provider_weights_status(factory3d_generation.TRIPOSPLAT)


def capabilities() -> dict[str, Any]:
    device = "unknown"
    torch_version = ""
    error = ""
    try:
        import torch

        torch_version = str(torch.__version__)
        try:
            import comfy.model_management as model_management  # type: ignore

            device = str(model_management.get_torch_device())
        except Exception:
            if torch.cuda.is_available():
                device = "cuda"
            elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                device = "mps"
            else:
                device = "cpu"
    except Exception as exc:
        error = str(exc)
    generators = {}
    for provider in factory3d_generation.PROVIDER_KEYS:
        public = dict(factory3d_generation.PROVIDER_PUBLIC[provider])
        public["weights"] = _provider_weights_status(provider)
        public["runtime"] = factory3d_generation.runtime_status(provider)
        public["defaults"] = (
            {
                "steps": 20,
                "guidance_scale": 3.0,
                "num_gaussians": 131072,
                "conditioning_resolution": 1024,
                "prevent_upscale": False,
                "remove_background": True,
                "seed": -1,
            }
            if provider == factory3d_generation.TRIPOSPLAT
            else dict(factory3d_generation.MESH_DEFAULTS)
        )
        if provider != factory3d_generation.TRIPOSPLAT:
            public["quality_presets"] = factory3d_generation.QUALITY_PRESETS
        generators[provider] = public
    return {
        "schema_version": SCHEMA_VERSION,
        "backend": "TripoSplat",
        "backend_repository": "https://github.com/VAST-AI-Research/TripoSplat",
        "backend_commit": UPSTREAM_COMMIT,
        "formats": ["ply", "glb"],
        "generators": generators,
        "import_formats": ["glb", "gltf", "fbx", "obj", "stl", "ply", "zip"],
        "model_texture_formats": ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tga"],
        "gaussian_counts": list(GAUSSIAN_COUNTS),
        "experimental_gaussian_counts": list(EXPERIMENTAL_GAUSSIAN_COUNTS),
        "conditioning_resolutions": list(CONDITIONING_RESOLUTIONS),
        "experimental_conditioning_resolutions": list(EXPERIMENTAL_CONDITIONING_RESOLUTIONS),
        "scene_render": {
            "min_side": 64,
            "max_side": 4096,
            "max_cameras": MAX_SCENE_CAMERAS,
            "aspect_presets": sorted(_ASPECT_PRESETS),
            "defaults": dict(_DEFAULT_RENDER_SETTINGS),
        },
        "defaults": {
            "steps": 20,
            "guidance_scale": 3.0,
            "num_gaussians": 131072,
            "conditioning_resolution": 1024,
            "prevent_upscale": False,
            "remove_background": True,
            "seed": -1,
        },
        "device": device,
        "torch_version": torch_version,
        "runtime_error": error,
        "weights": _weights_status(),
        "splat_cache": splat_cache_status(),
    }


def _generation_settings(values: Any) -> dict[str, Any]:
    data = values if hasattr(values, "get") else {}
    provider = factory3d_generation.normalize_provider(data.get("provider"))
    if provider in factory3d_generation.MESH_PROVIDER_KEYS:
        mesh_values = dict(data)
        mesh_values["provider"] = provider
        return factory3d_generation.normalize_mesh_settings(mesh_values)
    conditioning_resolution = int(data.get("conditioning_resolution", 1024))
    if conditioning_resolution not in CONDITIONING_RESOLUTIONS:
        raise ValueError(
            "conditioning_resolution must be one of "
            + ", ".join(str(value) for value in CONDITIONING_RESOLUTIONS)
        )
    prevent_upscale = str(data.get("prevent_upscale", "")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    remove_background = str(data.get("remove_background", "1")).strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    return {
        "provider": factory3d_generation.TRIPOSPLAT,
        "steps": max(1, min(100, int(data.get("steps", 20)))),
        "guidance_scale": max(1.0, min(20.0, float(data.get("guidance_scale", 3.0)))),
        "num_gaussians": max(
            GAUSSIAN_COUNTS[0],
            min(GAUSSIAN_COUNTS[-1], round(int(data.get("num_gaussians", 131072)) / 32) * 32),
        ),
        "conditioning_resolution": conditioning_resolution,
        "prevent_upscale": prevent_upscale,
        "remove_background": remove_background,
        "seed": max(-1, min(2**31 - 1, int(data.get("seed", -1)))),
    }


def _job_log_path(job: dict[str, Any]) -> Path:
    scene_id = job.get("scene_id")
    if isinstance(scene_id, str) and _ID_RE.fullmatch(scene_id):
        root = resolve_scene_dir(scene_id)
    else:
        root = _factory_root()
    return root / "logs" / f"{job['job_id']}.log"


def _job_public(job: dict[str, Any]) -> dict[str, Any]:
    with _STATE_LOCK:
        return {
            key: value
            for key, value in job.items()
            if key not in {"cancel_event", "log_path"}
        }


def _emit(
    job: dict[str, Any],
    stage: str,
    progress: float,
    message: str,
    *,
    detail: str = "",
    level: str = "info",
) -> None:
    timestamp = _now()
    percent = max(0.0, min(100.0, float(progress)))
    entry = {
        "timestamp": timestamp,
        "level": level,
        "stage": stage,
        "progress": percent,
        "message": str(message),
        "detail": str(detail),
    }
    with _STATE_LOCK:
        job["stage"] = stage
        job["progress"] = percent
        job["message"] = str(message)
        job["detail"] = str(detail)
        job["updated_at"] = timestamp
        logs = job.setdefault("logs", [])
        logs.append(entry)
        if len(logs) > MAX_JOB_LOG_LINES:
            del logs[: len(logs) - MAX_JOB_LOG_LINES]
    elapsed = max(0.0, timestamp - float(job.get("created_at", timestamp)))
    line = (
        f"[VNCCS 3D Factory][{job['job_id'][:8]}]"
        f"[{percent:6.1f}%][{elapsed:8.1f}s][{stage}] {message}"
        + (f" — {detail}" if detail else "")
    )
    getattr(LOGGER, level if hasattr(LOGGER, level) else "info")(line)
    print(line, flush=True)
    try:
        path = _job_log_path(job)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(
                f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(timestamp))} "
                f"{line}\n"
            )
    except OSError:
        LOGGER.exception("Could not persist Factory job log")


def _new_job(kind: str, scene_id: str = "") -> dict[str, Any]:
    with _STATE_LOCK:
        active = sum(job.get("status") in {"queued", "running"} for job in _JOBS.values())
        if active >= MAX_ACTIVE_JOBS:
            raise RuntimeError("3D Factory job capacity is full; wait for the active job to finish")
        job_id = _new_id()
        timestamp = _now()
        job = {
            "job_id": job_id,
            "kind": kind,
            "scene_id": scene_id,
            "status": "queued",
            "stage": "queued",
            "progress": 0.0,
            "message": "Queued",
            "detail": "",
            "created_at": timestamp,
            "updated_at": timestamp,
            "logs": [],
            "result": None,
            "error": "",
            "traceback": "",
            "cancel_event": threading.Event(),
        }
        _JOBS[job_id] = job
        if len(_JOBS) > 64:
            completed = sorted(
                (item for item in _JOBS.values() if item.get("status") not in {"queued", "running"}),
                key=lambda item: item.get("updated_at", 0),
            )
            for old in completed[: max(0, len(_JOBS) - 64)]:
                _JOBS.pop(old["job_id"], None)
        return job


def _check_cancel(job: dict[str, Any]) -> None:
    if job["cancel_event"].is_set():
        raise JobCancelled("job cancelled by user")


def _run_job(job: dict[str, Any], function: Callable[[dict[str, Any]], Any]) -> None:
    with _STATE_LOCK:
        job["status"] = "running"
    try:
        result = function(job)
        _check_cancel(job)
        with _STATE_LOCK:
            job["result"] = result
            job["status"] = "completed"
        _emit(job, "complete", 100.0, "Completed")
    except JobCancelled as exc:
        with _STATE_LOCK:
            job["status"] = "cancelled"
            job["error"] = str(exc)
        _emit(job, "cancelled", job.get("progress", 0), "Cancelled", detail=str(exc), level="warning")
    except Exception as exc:
        rendered = traceback.format_exc()
        with _STATE_LOCK:
            job["status"] = "failed"
            job["error"] = str(exc)
            job["traceback"] = rendered
        _emit(job, "failed", job.get("progress", 0), "Failed", detail=str(exc), level="error")
        try:
            path = _job_log_path(job)
            with path.open("a", encoding="utf-8") as handle:
                handle.write("\n===== PYTHON TRACEBACK =====\n")
                handle.write(rendered)
                handle.write("\n")
        except OSError:
            pass


def _track_task(coroutine: Any) -> None:
    task = asyncio.create_task(coroutine)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


def _download_provider_weights(job: dict[str, Any], provider: Any) -> dict[str, Any]:
    from huggingface_hub import hf_hub_download

    key = factory3d_generation.normalize_provider(provider)
    provider_name = factory3d_generation.PROVIDER_PUBLIC[key]["name"]
    files = _provider_weight_files(key)
    root = _model_root()
    root.mkdir(parents=True, exist_ok=True)
    job["provider"] = key
    _emit(job, "weights", 2, f"Preparing {provider_name} weights", detail=str(root))
    for index, relative in enumerate(files):
        _check_cancel(job)
        start = 5 + index / len(files) * 90
        _emit(
            job,
            "weights",
            start,
            f"Downloading {index + 1}/{len(files)}",
            detail=relative,
        )
        spec = factory3d_generation.WEIGHT_SPECS.get(relative)
        hf_hub_download(
            repo_id=str(spec["repo_id"]) if spec else UPSTREAM_REPOSITORY,
            filename=str(spec["filename"]) if spec else relative,
            local_dir=str(root),
            revision=str(spec["revision"]) if spec else UPSTREAM_HF_REVISION,
            token=False,
        )
        _emit(
            job,
            "weights",
            5 + (index + 1) / len(files) * 90,
            f"Verified {index + 1}/{len(files)}",
            detail=relative,
        )
    status = _provider_weights_status(key)
    if not status["ready"]:
        raise RuntimeError(f"{provider_name} weight download finished with missing files")
    return {"provider": key, "weights": status}


def _download_weights(job: dict[str, Any]) -> dict[str, Any]:
    return _download_provider_weights(job, factory3d_generation.TRIPOSPLAT)


def _device() -> str:
    import torch

    try:
        import comfy.model_management as model_management  # type: ignore

        return str(model_management.get_torch_device())
    except Exception:
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
        return "cpu"


def _load_pipeline(paths: dict[str, Path], device: str, job: dict[str, Any]) -> Any:
    """Construct the pinned upstream pipeline with visible component stages."""
    import torch

    from ..data.triposplat import triposplat as engine

    target = torch.device(device)
    load_device = torch.device("cpu") if target.type != "cpu" else target
    dtypes = engine.component_dtypes(target)
    pipeline = engine.TripoSplatPipeline.__new__(engine.TripoSplatPipeline)
    pipeline._device = target
    pipeline._load_device = load_device
    components = (
        (
            "DINOv3 image encoder",
            "dinov3",
            engine.load_dinov3,
            "clip_vision/dino_v3_vit_h.safetensors",
            dtypes["dinov3"],
        ),
        (
            "Flux2 VAE encoder",
            "vae_encoder",
            engine.load_vae_encoder,
            "vae/flux2-vae.safetensors",
            dtypes["vae_encoder"],
        ),
        (
            "BiRefNet background remover",
            "rmbg",
            engine.load_rmbg,
            "background_removal/birefnet.safetensors",
            dtypes["rmbg"],
        ),
        (
            "TripoSplat flow model",
            "flow_model",
            engine.load_flow_model,
            "diffusion_models/triposplat_fp16.safetensors",
            dtypes["flow_model"],
        ),
        (
            "Gaussian decoder",
            "decoder",
            engine.load_decoder,
            "vae/triposplat_vae_decoder_fp16.safetensors",
            dtypes["decoder"],
        ),
    )
    for index, (label, attribute, loader, relative, dtype) in enumerate(components):
        _check_cancel(job)
        progress = 7.0 + index * 2.2
        _emit(
            job,
            "model",
            progress,
            f"Loading {label} ({index + 1}/{len(components)})",
            detail=(
                f"{relative} · {str(dtype).removeprefix('torch.')} · "
                f"load {load_device} / inference {target}"
            ),
        )
        setattr(
            pipeline,
            attribute,
            loader(str(paths[relative]), device=load_device, dtype=dtype),
        )
        _emit(
            job,
            "model",
            progress + 1.8,
            f"Loaded {label}",
            detail=f"{paths[relative].stat().st_size:,} bytes",
        )
    return pipeline


def _pipeline_for_job(job: dict[str, Any]) -> Any:
    global _PIPELINE, _PIPELINE_SIGNATURE

    paths = _weight_paths()
    missing = [relative for relative, path in paths.items() if not _valid_weight(path)]
    if missing:
        raise RuntimeError(
            "TripoSplat weights are not installed. Open Model setup in VNCCS 3D Factory "
            "and download the official weights."
        )
    device = _device()
    signature = (
        device,
        *(f"{path}:{path.stat().st_size}:{path.stat().st_mtime_ns}" for path in paths.values()),
    )
    if _PIPELINE is not None and _PIPELINE_SIGNATURE == signature:
        _emit(job, "model", 12, "Using cached TripoSplat pipeline", detail=device)
        return _PIPELINE

    # Never keep an obsolete pipeline alive while constructing its replacement;
    # doing so briefly doubles host RAM and can make the process unrecoverable.
    if _PIPELINE is not None:
        stale_pipeline = _PIPELINE
        _PIPELINE = None
        _PIPELINE_SIGNATURE = None
        del stale_pipeline
        gc.collect()
        factory3d_generation.release_runtime_memory()

    _emit(job, "model", 5, "Importing the pinned TripoSplat runtime", detail=device)
    _PIPELINE = _load_pipeline(paths, device, job)
    _PIPELINE_SIGNATURE = signature
    _emit(job, "model", 18, "TripoSplat pipeline loaded", detail=device)
    return _PIPELINE


def _decode_image(
    image_bytes: bytes,
    *,
    max_bytes: int = MAX_UPLOAD_BYTES,
) -> Image.Image:
    if not image_bytes or len(image_bytes) > max_bytes:
        raise ValueError("image upload is empty or too large")
    with Image.open(io.BytesIO(image_bytes)) as image:
        width, height = image.size
        if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
            raise ValueError("image dimensions are too large")
        image.load()
        image = ImageOps.exif_transpose(image)
        return image.convert("RGBA" if "A" in image.getbands() else "RGB")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _ply_file_identity(path: Path) -> tuple[int, int, int, int]:
    stat = path.stat()
    return (
        int(getattr(stat, "st_dev", 0)),
        int(getattr(stat, "st_ino", 0)),
        int(stat.st_size),
        int(stat.st_mtime_ns),
    )


def _remember_ply_sha256(path: Path, digest: str) -> None:
    key = _ply_file_identity(path)
    with _SPLAT_CACHE_LOCK:
        if len(_PLY_HASH_CACHE) >= 4096:
            _PLY_HASH_CACHE.clear()
        _PLY_HASH_CACHE[key] = digest


def _verified_ply_sha256(path: Path, claimed: str = "") -> str:
    """Hash a PLY once per immutable file identity and reject stale metadata."""
    key = _ply_file_identity(path)
    with _SPLAT_CACHE_LOCK:
        digest = _PLY_HASH_CACHE.get(key)
    if digest is None:
        digest = _sha256_file(path)
        _remember_ply_sha256(path, digest)
    expected = str(claimed or "").lower()
    if re.fullmatch(r"[a-f0-9]{64}", expected) and expected != digest:
        LOGGER.warning(
            "Ignoring stale PLY checksum metadata for %s: expected %s, actual %s",
            path,
            expected[:16],
            digest[:16],
        )
    return digest


def _prune_splat_cache(*, keep: Path | None = None) -> None:
    """Evict least-recently-used derived SPLAT files above the cache budget."""
    root = _splat_cache_root()
    entries: list[tuple[float, int, Path]] = []
    total = 0
    for path in root.glob("v1-*.splat"):
        try:
            stat = path.stat()
        except OSError:
            continue
        total += stat.st_size
        entries.append((stat.st_mtime, stat.st_size, path))
    limit = _splat_cache_limit_bytes()
    for _mtime, size, path in sorted(entries):
        if total <= limit:
            break
        if keep is not None and path == keep:
            continue
        try:
            path.unlink()
            total -= size
        except OSError:
            LOGGER.debug("Could not evict cached SPLAT %s", path, exc_info=True)


def splat_cache_status() -> dict[str, Any]:
    root = _splat_cache_root()
    files = 0
    used_bytes = 0
    with _SPLAT_CACHE_LOCK:
        for path in root.glob("v1-*.splat"):
            try:
                used_bytes += path.stat().st_size
                files += 1
            except OSError:
                continue
    limit_gb = _splat_cache_limit_gb()
    limit_bytes = limit_gb * 1024**3
    try:
        disk_free_bytes = shutil.disk_usage(root).free
    except OSError:
        disk_free_bytes = 0
    return {
        "limit_gb": limit_gb,
        "limit_bytes": limit_bytes,
        "used_bytes": used_bytes,
        "file_count": files,
        "usage_ratio": used_bytes / limit_bytes if limit_bytes else 0.0,
        "disk_free_bytes": disk_free_bytes,
    }


def configure_splat_cache(limit_gb: Any) -> dict[str, Any]:
    try:
        value = int(limit_gb)
    except (TypeError, ValueError) as exc:
        raise ValueError("SPLAT cache limit must be an integer number of GiB") from exc
    if not MIN_SPLAT_CACHE_LIMIT_GB <= value <= MAX_SPLAT_CACHE_LIMIT_GB:
        raise ValueError(
            f"SPLAT cache limit must be between "
            f"{MIN_SPLAT_CACHE_LIMIT_GB} and {MAX_SPLAT_CACHE_LIMIT_GB} GiB"
        )
    _atomic_json(
        _splat_cache_settings_path(),
        {
            "schema": "vnccs-3d-factory-splat-cache/v1",
            "limit_gb": value,
            "updated_at": _now(),
        },
    )
    with _SPLAT_CACHE_LOCK:
        _prune_splat_cache()
    return splat_cache_status()


def clear_splat_cache() -> dict[str, Any]:
    deleted_files = 0
    deleted_bytes = 0
    failed_files = 0
    with _SPLAT_CACHE_LOCK:
        for path in _splat_cache_root().glob("v1-*.splat"):
            try:
                size = path.stat().st_size
                path.unlink()
                deleted_files += 1
                deleted_bytes += size
            except OSError:
                failed_files += 1
                LOGGER.warning("Could not clear cached SPLAT %s", path, exc_info=True)
    return {
        **splat_cache_status(),
        "deleted_files": deleted_files,
        "deleted_bytes": deleted_bytes,
        "failed_files": failed_files,
    }


def _ensure_cached_splat(
    ply_path: str | os.PathLike[str],
    *,
    ply_sha256: str = "",
) -> Path:
    """Materialize a validated compact SPLAT derived from an immutable PLY."""
    source = Path(ply_path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    digest = _verified_ply_sha256(source, str(ply_sha256 or ""))
    info = inspect_ply(source)
    expected_bytes = info.vertex_count * 32
    target = _splat_cache_root() / f"v1-{digest}.splat"
    with _SPLAT_CACHE_LOCK:
        try:
            valid_cached_file = (
                target.is_file()
                and target.stat().st_size == expected_bytes
            )
        except OSError:
            valid_cached_file = False
        if not valid_cached_file:
            target.unlink(missing_ok=True)
            started = time.monotonic()
            LOGGER.info(
                "Building derived SPLAT cache for %s (%s Gaussians, sha256=%s)",
                source,
                f"{info.vertex_count:,}",
                digest[:16],
            )
            ply_to_splat(source, target)
            validation = validate_splat_payload(
                target,
                expected_gaussians=info.vertex_count,
            )
            LOGGER.info(
                "Derived SPLAT cache ready: %s (%s bytes, %s invalid values, %.2fs)",
                target,
                f"{target.stat().st_size:,}",
                f"{validation['invalid_values']:,}",
                time.monotonic() - started,
            )
            _prune_splat_cache(keep=target)
        else:
            try:
                os.utime(target, None)
            except OSError:
                pass
    return target


def _ensure_object_splat(scene_id: str, object_id: str) -> Path:
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        item = _object_by_id(scene, object_id)
        source = _object_file(scene_id, item, "ply")
        checksum = str(item.get("checksums", {}).get("ply_sha256") or "")
    return _ensure_cached_splat(source, ply_sha256=checksum)


def _generate_object(
    job: dict[str, Any],
    image_bytes: bytes,
    object_id: str,
    object_name: str,
    settings: dict[str, Any],
) -> dict[str, Any]:
    import torch

    scene_id = job["scene_id"]
    scene_root = resolve_scene_dir(scene_id)
    object_root = scene_root / "objects" / object_id
    object_root.mkdir(parents=True, exist_ok=False)
    try:
        _emit(job, "input", 2, "Validating reference image")
        image = _decode_image(image_bytes)
        _emit(
            job,
            "input",
            3,
            "Reference image accepted",
            detail=f"{image.width}×{image.height} · {image.mode} · {len(image_bytes):,} bytes",
        )
        image.save(object_root / "reference.png", format="PNG")
        _check_cancel(job)

        with _FactoryModelOperation(job), torch.inference_mode():
            _check_cancel(job)
            pipeline = _pipeline_for_job(job)
            seed = settings["seed"]
            if seed < 0:
                seed = secrets.randbelow(2**31 - 1)
            _emit(
                job,
                "input",
                4,
                "Generation settings fixed",
                detail=(
                    f"seed={seed} · steps={settings['steps']} · "
                    f"guidance={settings['guidance_scale']:.3f} · "
                    f"gaussians={settings['num_gaussians']:,} · "
                    f"conditioning={settings['conditioning_resolution']}² · "
                    f"prevent_upscale={settings['prevent_upscale']} · "
                    f"remove_background={settings['remove_background']}"
                ),
            )
            generator = torch.Generator(device=pipeline._device).manual_seed(seed)

            _emit(
                job,
                "preprocess",
                22,
                "Removing background and framing subject"
                if settings["remove_background"]
                else "Preserving background and framing source",
            )
            if settings["conditioning_resolution"] in EXPERIMENTAL_CONDITIONING_RESOLUTIONS:
                side = settings["conditioning_resolution"] // 16
                _emit(
                    job,
                    "preprocess",
                    23,
                    "Experimental high-resolution conditioning enabled",
                    detail=(
                        f"requested {settings['conditioning_resolution']}² · "
                        f"{side * side:,} image tokens per encoder branch · "
                        "outside the released 1024² inference regime"
                    ),
                    level="warning",
                )
            prepared = pipeline.preprocess_image(
                image,
                canvas_size=settings["conditioning_resolution"],
                prevent_upscale=settings["prevent_upscale"],
                remove_background=settings["remove_background"],
            )
            prepared.save(object_root / "prepared.png", format="PNG")
            _emit(
                job,
                "preprocess",
                28,
                "Prepared inference image",
                detail=(
                    f"requested {settings['conditioning_resolution']}×"
                    f"{settings['conditioning_resolution']} · effective "
                    f"{prepared.width}×{prepared.height} · {prepared.mode} · "
                    f"prevent upscale {settings['prevent_upscale']} · "
                    f"remove background {settings['remove_background']}"
                ),
            )
            _check_cancel(job)

            _emit(job, "encode", 31, "Encoding image features")
            conditioning = pipeline.encode_image(prepared, generator=generator)
            _emit(
                job,
                "encode",
                35,
                "Image conditioning encoded",
                detail=(
                    f"DINO {tuple(conditioning['feature1'].shape)} · "
                    f"Flux VAE {tuple(conditioning['feature2'].shape)}"
                ),
            )
            _check_cancel(job)

            def callback(step: int, total: int) -> None:
                _check_cancel(job)
                progress = 40.0 + (float(step) / max(1, total)) * 42.0
                _emit(
                    job,
                    "sample",
                    progress,
                    f"Generating Gaussian latent {step}/{total}",
                    detail=f"guidance {settings['guidance_scale']:.2f}",
                )

            _emit(job, "sample", 39, "Starting TripoSplat diffusion")
            latent = pipeline.sample_latent(
                conditioning,
                steps=settings["steps"],
                guidance_scale=settings["guidance_scale"],
                shift=3.0,
                generator=generator,
                show_progress=False,
                callback=callback,
            )
            _check_cancel(job)
            del conditioning
            if pipeline._device.type == "cuda" and torch.cuda.is_available():
                torch.cuda.empty_cache()

            if settings["num_gaussians"] in EXPERIMENTAL_GAUSSIAN_COUNTS:
                decoder_tokens = settings["num_gaussians"] // pipeline.decoder.gaussians_per_point
                memory_detail = ""
                if pipeline._device.type == "cuda" and torch.cuda.is_available():
                    free_bytes, total_bytes = torch.cuda.mem_get_info(pipeline._device)
                    torch.cuda.reset_peak_memory_stats(pipeline._device)
                    memory_detail = (
                        f" · CUDA free {free_bytes / 1024**3:.2f} GiB"
                        f" / {total_bytes / 1024**3:.2f} GiB"
                    )
                _emit(
                    job,
                    "decode",
                    84,
                    (
                        "Extreme-density decode enabled"
                        if settings["num_gaussians"] == 1048576
                        else "Experimental high-density decode enabled"
                    ),
                    detail=(
                        f"{settings['num_gaussians']:,} Gaussians · "
                        f"{decoder_tokens:,} decoder tokens · elevated VRAM and runtime"
                        f"{memory_detail}"
                    ),
                    level="warning",
                )
            _emit(
                job,
                "decode",
                85,
                "Decoding Gaussian representation",
                detail=f"target {settings['num_gaussians']:,} splats",
            )

            def decode_callback(stage: str, step: int, total: int) -> None:
                _check_cancel(job)
                ratio = float(step) / max(1, total)
                if stage == "octree":
                    progress = 85.0 + ratio * 3.5
                    message = f"Sampling octree level {step}/{total}"
                    detail = f"target {settings['num_gaussians']:,} splats"
                else:
                    progress = 88.5 + ratio * 2.0
                    message = (
                        "Predicting Gaussian attributes"
                        if step == 0
                        else "Gaussian attributes predicted"
                    )
                    detail = f"{settings['num_gaussians'] // 32:,} decoder tokens"
                _emit(job, "decode", progress, message, detail=detail)

            gaussian = pipeline.decode_latent(
                latent["latent"],
                num_gaussians=settings["num_gaussians"],
                generator=generator,
                callback=decode_callback,
            )
            gaussian_count = int(gaussian.get_xyz.shape[0])
            gaussian_report = getattr(gaussian, "last_validation_report", None)
            if not isinstance(gaussian_report, dict):
                gaussian_report = gaussian.validate()
            _emit(
                job,
                "validate",
                91,
                "Validated decoded Gaussian tensors",
                detail=(
                    f"{gaussian_count:,} splats · finite xyz/color/opacity/scale/rotation · "
                    f"rotation norms > 1e-12"
                ),
            )
            if settings["num_gaussians"] in EXPERIMENTAL_GAUSSIAN_COUNTS:
                peak_detail = f"{gaussian_count:,} Gaussians decoded"
                if pipeline._device.type == "cuda" and torch.cuda.is_available():
                    peak_bytes = torch.cuda.max_memory_allocated(pipeline._device)
                    peak_detail += f" · CUDA peak allocated {peak_bytes / 1024**3:.2f} GiB"
                _emit(job, "decode", 91.5, "High-density decode completed", detail=peak_detail)
            _check_cancel(job)

            ply_path = object_root / "model.ply"
            _emit(job, "serialize", 92, "Writing Gaussian PLY", detail=f"{gaussian_count:,} splats")

            def ply_callback(completed: int, total: int) -> None:
                _check_cancel(job)
                _emit(
                    job,
                    "serialize",
                    92.0 + (float(completed) / max(1, total)) * 2.0,
                    "Writing Gaussian PLY",
                    detail=f"{completed:,}/{total:,} splats",
                )

            gaussian.save_ply(
                ply_path,
                callback=ply_callback,
                _validated_report=gaussian_report,
            )
            _check_cancel(job)
            ply_info = inspect_ply(ply_path)
            if ply_info.vertex_count != gaussian_count:
                raise RuntimeError(
                    f"serialized PLY contains {ply_info.vertex_count:,} splats; "
                    f"decoder reported {gaussian_count:,}"
                )
            ply_validation = validate_ply_payload(ply_path)
            ply_hash = _sha256_file(ply_path)
            _remember_ply_sha256(ply_path, ply_hash)
            _emit(
                job,
                "validate",
                96,
                "Validated Gaussian PLY",
                detail=(
                    f"{ply_info.vertex_count:,} splats · {ply_path.stat().st_size:,} bytes · "
                    f"{ply_validation['invalid_values']} invalid values · "
                    f"{ply_validation['invalid_scales']} invalid scales · "
                    f"{ply_validation['invalid_quaternions']} invalid quaternions · "
                    f"sha256={ply_hash[:16]}"
                ),
            )
            _emit(
                job,
                "cache",
                97,
                "PLY committed as the source asset",
                detail="Compact SPLAT will be generated once in the shared cache when requested",
            )
            del gaussian, latent

        relative_root = Path("objects") / object_id
        item = {
            "object_id": object_id,
            "name": object_name,
            "created_at": _now(),
            "transform": normalize_transform({}),
            **normalize_object_editor_properties({}),
            "gaussians": gaussian_count,
            "seed": seed,
            "checksums": {
                "ply_sha256": ply_hash,
            },
            "validation": {
                "tensor_ranges": gaussian_report["ranges"],
                "ply": {
                    "invalid_values": ply_validation["invalid_values"],
                    "invalid_scales": ply_validation["invalid_scales"],
                    "invalid_quaternions": ply_validation["invalid_quaternions"],
                },
            },
            "settings": {
                "steps": settings["steps"],
                "guidance_scale": settings["guidance_scale"],
                "num_gaussians": settings["num_gaussians"],
                "conditioning_resolution": settings["conditioning_resolution"],
                "effective_conditioning_resolution": prepared.width,
                "prevent_upscale": settings["prevent_upscale"],
                "remove_background": settings["remove_background"],
            },
            "files": {
                "reference": str(relative_root / "reference.png"),
                "prepared": str(relative_root / "prepared.png"),
                "ply": str(relative_root / "model.ply"),
            },
        }
        _emit(job, "scene", 98, "Adding object to scene", detail=object_name)
        with _STATE_LOCK:
            scene = load_scene(scene_id)
            item["level_id"] = scene["levels"][0]["level_id"]
            item["building_id"] = (
                scene["architecture"]["buildings"][0]["building_id"]
                if scene["architecture"]["buildings"] else ""
            )
            scene["objects"].append(item)
            scene["layers"].append({"type": "object", "object_id": object_id})
            scene["exports"] = {}
            _save_scene(scene)
        return {
            "scene_id": scene_id,
            "object_id": object_id,
            "scene_revision": scene["revision"],
            # Embed the committed manifest in the terminal job response. The
            # frontend can hydrate it immediately even if another modal was
            # open when generation finished, without a second scene request.
            "scene": _public_scene(scene),
        }
    except Exception:
        try:
            shutil.rmtree(object_root)
        except OSError:
            pass
        raise


def _generate_mesh_object(
    job: dict[str, Any],
    image_bytes: bytes,
    object_id: str,
    object_name: str,
    settings: dict[str, Any],
) -> dict[str, Any]:
    scene_id = job["scene_id"]
    provider = factory3d_generation.normalize_provider(settings.get("provider"))
    provider_name = factory3d_generation.PROVIDER_PUBLIC[provider]["name"]
    weights = _provider_weights_status(provider)
    if not weights["ready"]:
        raise RuntimeError(f"{provider_name} weights are not installed")

    scene_root = resolve_scene_dir(scene_id)
    object_root = scene_root / "objects" / object_id
    model_root = object_root / "model"
    object_root.mkdir(parents=True, exist_ok=False)
    model_root.mkdir(parents=True, exist_ok=False)
    try:
        _emit(job, "input", 2, "Validating reference image")
        image = _decode_image(image_bytes)
        reference_path = object_root / "reference.png"
        prepared_path = object_root / "prepared.png"
        model_path = model_root / "model.glb"
        image.save(reference_path, format="PNG")

        thumbnail = ImageOps.exif_transpose(image).convert("RGB")
        thumbnail.thumbnail(OBJECT_THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
        thumbnail.save(object_root / "thumbnail.png", format="PNG", optimize=True)
        seed = int(settings["seed"])
        if seed < 0:
            seed = secrets.randbelow(2**31 - 1)
        effective_settings = {**settings, "provider": provider, "seed": seed}
        job["provider"] = provider
        _emit(
            job,
            "input",
            3,
            f"{provider_name} settings fixed",
            detail=(
                f"seed={seed} · quality={settings['quality']} · "
                f"steps={settings['structure_steps']}/{settings['shape_steps']}/"
                f"{settings['upsample_steps']}/{settings['texture_steps']}"
            ),
        )
        with _FactoryModelOperation(job):
            _release_cached_triposplat_pipeline()
            result = factory3d_generation.run_mesh_generation(
                provider,
                image,
                model_path,
                prepared_path,
                effective_settings,
                emit=lambda stage, progress, message, detail="": _emit(
                    job,
                    stage,
                    progress,
                    message,
                    detail=detail,
                ),
                check_cancel=lambda: _check_cancel(job),
            )
        _check_cancel(job)

        relative_root = Path("objects") / object_id
        item = _standard_model_item(
            scene_root=scene_root,
            object_root=object_root,
            model_root=model_root,
            object_id=object_id,
            main=model_path,
            resources=[],
            logical_resources=[],
            object_name=object_name,
            stored_bytes=result["size"],
        )
        item["seed"] = seed
        item["source"].update({
            "generator": provider,
            "generated": True,
        })
        item["settings"].update({
            "generation_source": provider,
            **effective_settings,
            "prepared_width": result["prepared_width"],
            "prepared_height": result["prepared_height"],
        })
        item["files"].update({
            "reference": str(relative_root / "reference.png"),
            "prepared": str(relative_root / "prepared.png"),
        })
        _emit(job, "scene", 99, "Adding generated mesh to scene", detail=object_name)
        with _STATE_LOCK:
            scene = load_scene(scene_id)
            item["level_id"] = scene["levels"][0]["level_id"]
            item["building_id"] = (
                scene["architecture"]["buildings"][0]["building_id"]
                if scene["architecture"]["buildings"] else ""
            )
            scene["objects"].append(item)
            scene["layers"].append({"type": "object", "object_id": object_id})
            scene["exports"] = {}
            _save_scene(scene)
        return {
            "scene_id": scene_id,
            "object_id": object_id,
            "scene_revision": scene["revision"],
            "provider": provider,
            "scene": _public_scene(scene),
        }
    except Exception:
        shutil.rmtree(object_root, ignore_errors=True)
        raise


def _public_scene(scene: dict[str, Any]) -> dict[str, Any]:
    value = json.loads(json.dumps(scene))
    value.pop("capture_set", None)
    scene_id = value["scene_id"]
    reference = value.get("reference")
    if isinstance(reference, dict):
        reference["url"] = f"{API_BASE}/scenes/{scene_id}/reference"
        reference["preview_url"] = (
            f"{API_BASE}/scenes/{scene_id}/reference/preview"
            f"?v={int(float(reference.get('updated_at', 0) or 0) * 1000)}"
        )
        reference.pop("file", None)
        reference.pop("preview_file", None)
    skydome = value.get("skydome")
    if isinstance(skydome, dict):
        skydome["url"] = (
            f"{API_BASE}/scenes/{scene_id}/skydome/viewport"
            f"?v={int(float(skydome.get('updated_at', 0) or 0) * 1000)}"
        )
        skydome["source_url"] = (
            f"{API_BASE}/scenes/{scene_id}/skydome"
            f"?v={int(float(skydome.get('updated_at', 0) or 0) * 1000)}"
        )
        skydome.pop("file", None)
        skydome.pop("viewport_file", None)
    for texture in value.get("textures", []):
        if not isinstance(texture, dict):
            continue
        texture_id = texture.get("texture_id")
        texture["url"] = (
            f"{API_BASE}/scenes/{scene_id}/textures/{texture_id}"
            f"?v={int(float(texture.get('updated_at', 0) or 0) * 1000)}"
        )
        texture.pop("file", None)
    preview = value.get("preview")
    if isinstance(preview, dict):
        render = _normalize_render_settings(value.get("render"))
        if (
            int(preview.get("revision", -1)) == int(value.get("revision", 0))
            and int(preview.get("render_revision", preview.get("revision", -1)))
            == int(value.get("render_revision", value.get("revision", 0)))
            and int(preview.get("width", 0)) == render["width"]
            and int(preview.get("height", 0)) == render["height"]
        ):
            preview["url"] = f"{API_BASE}/scenes/{scene_id}/preview"
        preview.pop("file", None)
    for item in value.get("objects", []):
        object_id = item["object_id"]
        base = f"{API_BASE}/scenes/{scene_id}/objects/{object_id}"
        if item.get("asset_kind") == "primitive":
            thumbnail_version = int(value.get("edit_revision", value.get("revision", 0)))
            item["urls"] = {
                "thumbnail": f"{base}/asset/thumbnail?v={thumbnail_version}",
            }
        elif item.get("asset_kind") == "mesh":
            item["urls"] = {
                "model": f"{base}/asset/model",
                "resources": {
                    path: f"{base}/asset/resource?{urllib.parse.urlencode({'path': path})}"
                    for path in item.get("source", {}).get("resources", [])
                },
                "thumbnail": f"{base}/asset/thumbnail",
            }
        else:
            item["urls"] = {
                "splat": f"{base}/asset/splat",
                "ply": f"{base}/asset/ply",
                "thumbnail": f"{base}/asset/thumbnail",
                "reference": f"{base}/asset/reference",
                "export_ply": f"{base}/export/ply",
            }
        item.pop("files", None)
    exports = value.get("exports")
    if isinstance(exports, dict) and exports.get("revision") is not None:
        exports["urls"] = {
            "ply": f"{API_BASE}/scenes/{scene_id}/exports/ply",
        }
        exports.pop("files", None)
    return value


def update_scene(scene_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("scene update must be an object")
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        if scene.get("schema_version", 11) >= 12 and payload.get("schema_version") != 12:
            raise ValueError("This scene requires an Editor 12 writer; reload the extension before saving")
        visible_before = _visible_object_ids(scene)
        changed = False
        render_changed = False
        preview_changed = False
        reference_levels = normalize_levels(scene_id, payload["levels"], strict=True) \
            if "levels" in payload else scene.get("levels", [])
        reference_architecture = normalize_architecture(
            scene_id,
            reference_levels,
            payload["architecture"],
            strict=True,
        ) if "architecture" in payload else scene.get("architecture", {})
        valid_building_ids = {
            building["building_id"]
            for building in reference_architecture.get("buildings", [])
        }
        if "name" in payload:
            name = _clean_name(payload["name"], scene["name"])
            if name != scene["name"]:
                scene["name"] = name
                changed = True
        updates = payload.get("objects")
        if updates is not None:
            if not isinstance(updates, list) or len(updates) > len(scene["objects"]):
                raise ValueError("invalid scene object update")
            by_id = {
                str(item.get("object_id")): item
                for item in updates
                if isinstance(item, dict)
            }
            for item in scene["objects"]:
                incoming = by_id.get(item["object_id"])
                if incoming is None:
                    continue
                if "name" in incoming:
                    name = _clean_name(incoming["name"], item["name"], 80)
                    if name != item["name"]:
                        item["name"] = name
                        changed = True
                if "transform" in incoming:
                    transform = normalize_transform(incoming["transform"])
                    if transform != item.get("transform"):
                        item["transform"] = transform
                        changed = True
                        render_changed = True
                if "visible" in incoming:
                    visible = incoming["visible"] is not False
                    if visible != (item.get("visible") is not False):
                        item["visible"] = visible
                        changed = True
                if "level_id" in incoming:
                    level_id = str(incoming.get("level_id") or "")
                    level_source = normalize_levels(scene_id, payload["levels"], strict=True) \
                        if "levels" in payload else scene.get("levels", [])
                    valid_level_ids = {level["level_id"] for level in level_source}
                    if level_id not in valid_level_ids:
                        raise ValueError("scene object references an unknown floor level")
                    if level_id != item.get("level_id"):
                        item["level_id"] = level_id
                        changed = True
                if "building_id" in incoming:
                    building_id = str(incoming.get("building_id") or "")
                    if building_id and building_id not in valid_building_ids:
                        raise ValueError("scene object references an unknown building")
                    if building_id != item.get("building_id"):
                        item["building_id"] = building_id
                        changed = True
                if any(
                    key in incoming
                    for key in (
                        "collision_proxy", "light_transport", "transmission", "locked",
                        "primitive", "emission",
                    )
                ):
                    editor_properties = normalize_object_editor_properties({
                        **item,
                        **incoming,
                    })
                    primitive = editor_properties.get("primitive")
                    if isinstance(primitive, dict) and primitive.get("texture_id"):
                        texture_ids = {
                            texture.get("texture_id")
                            for texture in scene.get("textures", [])
                            if isinstance(texture, dict)
                        }
                        if primitive["texture_id"] not in texture_ids:
                            raise ValueError("primitive references an unknown scene texture")
                    primitive = editor_properties.get("primitive", {})
                    if scene.get("schema_version", 11) < 12 and (
                        primitive.get("kind", "plane") not in {"image", "plane", "terrain"}
                        or primitive.get("height_amplitude", 0) > 0
                    ):
                        raise ValueError("Upgrade a copy before using procedural geometry")
                    previous_editor_properties = normalize_object_editor_properties(item)
                    if editor_properties != previous_editor_properties:
                        item.update(editor_properties)
                        changed = True
                        if "primitive" in incoming or "emission" in incoming:
                            render_changed = True
                        if (
                            editor_properties["light_transport"]
                            != previous_editor_properties["light_transport"]
                            or editor_properties["transmission"]
                            != previous_editor_properties["transmission"]
                            or editor_properties["collision_proxy"]
                            != previous_editor_properties["collision_proxy"]
                            or editor_properties.get("primitive")
                            != previous_editor_properties.get("primitive")
                            or editor_properties["emission"]
                            != previous_editor_properties["emission"]
                        ):
                            preview_changed = True
        if "layers" in payload:
            layers = _normalize_scene_layers(scene, payload["layers"], strict=True)
            if layers != scene.get("layers"):
                scene["layers"] = layers
                changed = True
        if "levels" in payload:
            levels = normalize_levels(scene_id, payload["levels"], strict=True)
            if levels != scene.get("levels"):
                scene["levels"] = levels
                scene["architecture"] = normalize_architecture(
                    scene_id,
                    levels,
                    scene.get("architecture"),
                )
                valid_level_ids = {level["level_id"] for level in levels}
                fallback_level_id = levels[0]["level_id"]
                for item in scene.get("objects", []):
                    if item.get("level_id") not in valid_level_ids:
                        item["level_id"] = fallback_level_id
                for camera in scene.get("cameras", []):
                    if camera.get("level_id") not in valid_level_ids:
                        camera["level_id"] = fallback_level_id
                for light in scene.get("lighting", {}).get("lights", []):
                    if light.get("level_id") not in valid_level_ids:
                        light["level_id"] = fallback_level_id
                changed = True
                preview_changed = True
        if "architecture" in payload:
            architecture = reference_architecture
            texture_ids = {
                item.get("texture_id")
                for item in scene.get("textures", [])
                if isinstance(item, dict)
            }
            texture_fields = ("texture_id", "normal_texture_id", "roughness_texture_id")
            if any(
                material.get(key) and material.get(key) not in texture_ids
                for material in architecture.get("materials", [])
                for key in texture_fields
            ):
                raise ValueError("architecture references an unknown scene texture")
            referenced_building_ids = {
                item.get("building_id") for item in scene.get("objects", [])
            } | {
                camera.get("building_id")
                for camera in (
                    _normalize_scene_cameras(payload["cameras"], strict=True)
                    if "cameras" in payload else scene.get("cameras", [])
                )
            } | {
                light.get("building_id")
                for light in (
                    _normalize_lighting(payload["lighting"])
                    if "lighting" in payload else scene.get("lighting", {})
                ).get("lights", [])
            } | {
                track.get("building_id")
                for track in (
                    normalize_camera_tracks(payload["camera_tracks"], strict=True)
                    if "camera_tracks" in payload else scene.get("camera_tracks", [])
                )
            }
            if any(
                building_id and building_id not in valid_building_ids
                for building_id in referenced_building_ids
            ):
                raise ValueError("scene content references a removed building")
            if architecture != scene.get("architecture"):
                scene["architecture"] = architecture
                changed = True
                preview_changed = True
        if "render" in payload:
            render = _normalize_render_settings(payload["render"])
            previous_render = _normalize_render_settings(scene.get("render"))
            if render != previous_render:
                scene["render"] = render
                changed = True
                preview_changed = (
                    render["width"] != previous_render["width"]
                    or render["height"] != previous_render["height"]
                )
        if "camera" in payload:
            camera = _normalize_camera(payload["camera"])
            if camera != _normalize_camera(scene.get("camera")):
                scene["camera"] = camera
                changed = True
                preview_changed = True
        if "cameras" in payload:
            cameras = _normalize_scene_cameras(payload["cameras"], strict=True)
            valid_level_ids = {level["level_id"] for level in scene.get("levels", [])}
            fallback_level_id = scene.get("levels", [{}])[0].get("level_id", "")
            for camera in cameras:
                if not camera.get("level_id") and fallback_level_id:
                    camera["level_id"] = fallback_level_id
            if any(camera.get("level_id") not in valid_level_ids for camera in cameras):
                raise ValueError("saved camera references an unknown floor level")
            if any(
                camera.get("building_id")
                and camera.get("building_id") not in valid_building_ids
                for camera in cameras
            ):
                raise ValueError("saved camera references an unknown building")
            if cameras != _normalize_scene_cameras(scene.get("cameras")):
                scene["cameras"] = cameras
                changed = True
                preview_changed = True
        if "camera_tracks" in payload:
            camera_tracks = normalize_camera_tracks(payload["camera_tracks"], strict=True)
            if any(
                track.get("building_id")
                and track.get("building_id") not in valid_building_ids
                for track in camera_tracks
            ):
                raise ValueError("camera path references an unknown building")
            if camera_tracks != scene.get("camera_tracks"):
                scene["camera_tracks"] = camera_tracks
                changed = True
        if "lighting" in payload:
            lighting = _normalize_lighting(payload["lighting"])
            valid_level_ids = {level["level_id"] for level in scene.get("levels", [])}
            if any(light.get("level_id") not in valid_level_ids for light in lighting.get("lights", [])):
                raise ValueError("scene light references an unknown floor level")
            if any(
                light.get("building_id")
                and light.get("building_id") not in valid_building_ids
                for light in lighting.get("lights", [])
            ):
                raise ValueError("scene light references an unknown building")
            if lighting != _normalize_lighting(scene.get("lighting")):
                scene["lighting"] = lighting
                changed = True
                preview_changed = True
        if "skydome" in payload and isinstance(scene.get("skydome"), dict):
            incoming = payload.get("skydome")
            if isinstance(incoming, dict):
                current = _normalize_scene_skydome(scene["skydome"])
                if current is not None:
                    updated = {
                        **current,
                        **_normalize_skydome_settings({**current, **incoming}),
                    }
                    if "name" in incoming:
                        updated["name"] = _clean_name(
                            incoming.get("name"),
                            current["name"],
                            96,
                        )
                    if updated != current:
                        scene["skydome"] = updated
                        changed = True
                        preview_changed = True
        if not changed:
            return scene
        render_changed = render_changed or visible_before != _visible_object_ids(scene)
        if render_changed:
            scene["exports"] = {}
        elif preview_changed:
            scene["render_revision"] = max(
                0,
                int(scene.get("render_revision", scene.get("revision", 0))),
            ) + 1
        return _save_scene(
            scene,
            bump_revision=render_changed,
            bump_edit_revision=True,
        )


def _scene_sources(scene: dict[str, Any], only_object_id: str = "") -> list[tuple[Path, Any]]:
    output = []
    visible_ids = _visible_object_ids(scene) if not only_object_id else set()
    for item in scene.get("objects", []):
        if item.get("asset_kind") in {"mesh", "primitive"}:
            continue
        if only_object_id and item.get("object_id") != only_object_id:
            continue
        if not only_object_id and item.get("object_id") not in visible_ids:
            continue
        output.append((_object_file(scene["scene_id"], item, "ply"), item.get("transform")))
    if not output:
        raise ValueError("the scene contains no visible Gaussian objects")
    return output


def _scene_camera_metadata(
    scene: dict[str, Any],
    *,
    revision: int,
    render_revision: int,
) -> dict[str, Any]:
    camera = _normalize_camera(scene.get("camera"))
    saved_cameras = _normalize_scene_cameras(scene.get("cameras"))
    render = _normalize_render_settings(scene.get("render"))

    def camera_entry(value: dict[str, Any]) -> dict[str, Any]:
        return {
            "projection": "perspective",
            "position": value["position"],
            "target": value["target"],
            "up": value["up"],
            "fov": value["fov"],
            "fov_axis": "vertical-degrees",
        }

    return {
        "schema": "vnccs-3d-factory-gaussian-scene/v2",
        "scene_id": scene["scene_id"],
        "scene_revision": revision,
        "render_revision": render_revision,
        "coordinate_system": "right-handed-y-up",
        "camera": camera_entry(camera),
        "cameras": [
            {
                "camera_id": saved["camera_id"],
                "name": saved["name"],
                **camera_entry(saved),
            }
            for saved in saved_cameras
        ],
        "render": {
            "width": render["width"],
            "height": render["height"],
            "aspect": render["aspect"],
            "show_camera_frame": render["show_camera_frame"],
        },
    }


def _scene_camera_fingerprint(metadata: dict[str, Any]) -> str:
    encoded = json.dumps(
        metadata,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


def ensure_scene_ply_export(scene_id: str) -> dict[str, Any]:
    for attempt in range(2):
        with _STATE_LOCK:
            scene = load_scene(scene_id)
            revision = int(scene.get("revision", 0))
            render_revision = int(scene.get("render_revision", revision))
            camera_metadata = _scene_camera_metadata(
                scene,
                revision=revision,
                render_revision=render_revision,
            )
            camera_fingerprint = _scene_camera_fingerprint(camera_metadata)
            existing = scene.get("exports", {})
            if (
                isinstance(existing, dict)
                and existing.get("revision") == revision
                and existing.get("render_revision") == render_revision
                and existing.get("camera_fingerprint") == camera_fingerprint
                and existing.get("format_version") == EXPORT_FORMAT_VERSION
            ):
                try:
                    ply = _object_file(scene_id, {"files": existing["files"]}, "ply")
                    return {"scene": scene, "ply": ply}
                except (KeyError, FileNotFoundError):
                    pass
            sources = _scene_sources(scene)

        export_root = resolve_scene_dir(scene_id) / "exports"
        export_stem = (
            f"scene-v{EXPORT_FORMAT_VERSION}-r{revision}-rr{render_revision}"
        )
        ply = export_root / f"{export_stem}.ply"
        result = export_gaussian_scene(
            sources,
            ply,
            metadata=camera_metadata,
        )
        ply_sha256 = _sha256_file(ply)
        _remember_ply_sha256(ply, ply_sha256)
        relative_ply = str(ply.relative_to(resolve_scene_dir(scene_id)))
        with _STATE_LOCK:
            current = load_scene(scene_id)
            current_camera_metadata = _scene_camera_metadata(
                current,
                revision=int(current.get("revision", 0)),
                render_revision=int(current.get("render_revision", 0)),
            )
            if (
                int(current.get("revision", 0)) != revision
                or int(current.get("render_revision", revision)) != render_revision
                or _scene_camera_fingerprint(current_camera_metadata)
                != camera_fingerprint
            ):
                if attempt == 0:
                    continue
                raise RuntimeError(
                    "scene or export camera changed repeatedly while its "
                    "combined model was being exported"
                )
            current["exports"] = {
                "revision": revision,
                "render_revision": render_revision,
                "camera_fingerprint": camera_fingerprint,
                "format_version": EXPORT_FORMAT_VERSION,
                "ply_sha256": ply_sha256,
                "created_at": _now(),
                "gaussians": result["ply"]["gaussians"],
                "source_gaussians": result["ply"].get(
                    "source_gaussians",
                    result["ply"]["gaussians"],
                ),
                "dropped_gaussians": result["ply"].get("dropped_gaussians", 0),
                "repaired_values": result["ply"].get("repaired_values", 0),
                "objects": result["ply"]["objects"],
                "files": {
                    "ply": relative_ply,
                },
            }
            if (
                result["ply"].get("dropped_gaussians", 0)
                or result["ply"].get("repaired_values", 0)
            ):
                LOGGER.warning(
                    "Scene %s export sanitized %s optional value(s) and removed "
                    "%s invalid Gaussian record(s)",
                    scene_id,
                    f"{result['ply'].get('repaired_values', 0):,}",
                    f"{result['ply'].get('dropped_gaussians', 0):,}",
                )
            _save_scene(current, bump_revision=False)
            return {"scene": current, "ply": ply}
    raise RuntimeError("scene export did not stabilize")


def _ensure_object_ply_export(scene_id: str, object_id: str) -> Path:
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        item = _object_by_id(scene, object_id)
        if item.get("asset_kind") in {"mesh", "primitive"}:
            raise ValueError("only Gaussian objects can be exported as PLY")
        revision = int(scene.get("revision", 0))
        source = _object_file(scene_id, item, "ply")
        transform = item.get("transform")
    root = resolve_scene_dir(scene_id) / "exports" / "objects"
    ply = root / f"{object_id}-v{EXPORT_FORMAT_VERSION}-r{revision}.ply"
    if not ply.is_file():
        export_gaussian_scene([(source, transform)], ply)
    return ply


def _json_error(web: Any, exc: Exception, status: int = 400) -> Any:
    return web.json_response({"error": str(exc), "type": type(exc).__name__}, status=status)


def _content_length_ok(request: Any, maximum: int) -> bool:
    raw = request.headers.get("Content-Length")
    if raw is None:
        return True
    try:
        return 0 <= int(raw) <= maximum
    except (TypeError, ValueError):
        return False


def register_routes(routes: Any) -> None:
    global _REGISTERED
    if _REGISTERED:
        return
    from aiohttp import web

    @routes.get(f"{API_BASE}/capabilities")
    async def factory_capabilities(_request: Any) -> Any:
        return web.json_response(capabilities())

    @routes.get(f"{API_BASE}/splat-cache")
    async def factory_splat_cache_status(_request: Any) -> Any:
        return web.json_response(await asyncio.to_thread(splat_cache_status))

    @routes.post(f"{API_BASE}/splat-cache/settings")
    async def factory_splat_cache_settings(request: Any) -> Any:
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("SPLAT cache settings must be an object")
            status = await asyncio.to_thread(
                configure_splat_cache,
                payload.get("limit_gb"),
            )
            return web.json_response(status)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/splat-cache/clear")
    async def factory_splat_cache_clear(_request: Any) -> Any:
        try:
            return web.json_response(await asyncio.to_thread(clear_splat_cache))
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/weights/download")
    async def factory_weights_download(_request: Any) -> Any:
        try:
            job = _new_job("weights")
            _track_task(asyncio.to_thread(_run_job, job, _download_weights))
            return web.json_response(_job_public(job), status=202)
        except Exception as exc:
            return _json_error(web, exc, 409)

    @routes.post(f"{API_BASE}/generators/{{provider}}/weights/download")
    async def factory_generator_weights_download(request: Any) -> Any:
        try:
            provider = factory3d_generation.normalize_provider(request.match_info["provider"])
            job = _new_job("weights")
            job["provider"] = provider
            _track_task(
                asyncio.to_thread(
                    _run_job,
                    job,
                    lambda current: _download_provider_weights(current, provider),
                )
            )
            return web.json_response(_job_public(job), status=202)
        except Exception as exc:
            return _json_error(web, exc, 409)

    @routes.post(f"{API_BASE}/scenes")
    async def factory_scene_create(request: Any) -> Any:
        try:
            payload = await request.json() if request.can_read_body else {}
            scene = create_scene(payload.get("name") if isinstance(payload, dict) else "")
            return web.json_response(_public_scene(scene), status=201)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/upgrade")
    async def factory_scene_upgrade(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(upgrade_scene, request.match_info["scene_id"])
            return web.json_response(_public_scene(scene))
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes")
    async def factory_scene_list(request: Any) -> Any:
        try:
            limit = int(request.query.get("limit", 100))
            return web.json_response({"scenes": list_scenes(limit)})
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}")
    async def factory_scene_get(request: Any) -> Any:
        try:
            return web.json_response(_public_scene(load_scene(request.match_info["scene_id"])))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.patch(f"{API_BASE}/scenes/{{scene_id}}")
    async def factory_scene_update(request: Any) -> Any:
        try:
            if not _content_length_ok(request, MAX_SCENE_JSON_BYTES):
                return web.json_response({"error": "scene update is too large"}, status=413)
            payload = await request.json()
            scene = update_scene(request.match_info["scene_id"], payload)
            return web.json_response(_public_scene(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except RuntimeError as exc:
            return _json_error(web, exc, 409)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.delete(f"{API_BASE}/scenes/{{scene_id}}")
    async def factory_scene_delete(request: Any) -> Any:
        try:
            result = await asyncio.to_thread(
                delete_scene,
                request.match_info["scene_id"],
            )
            return web.json_response(result)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except RuntimeError as exc:
            return _json_error(web, exc, 409)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/reference")
    async def factory_scene_reference_upload(request: Any) -> Any:
        try:
            if not _content_length_ok(request, MAX_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "image upload is too large"}, status=413)
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            load_scene(scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                raise ValueError("missing image")
            image_bytes = await asyncio.to_thread(
                image_field.file.read,
                MAX_UPLOAD_BYTES + 1,
            )
            scene = await asyncio.to_thread(
                store_scene_reference,
                scene_id,
                image_bytes,
                getattr(image_field, "filename", "reference.png"),
            )
            reference = _public_scene(scene)["reference"]
            reference["edit_revision"] = scene.get("edit_revision", 0)
            return web.json_response(reference, status=201)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/reference")
    async def factory_scene_reference_get(request: Any) -> Any:
        try:
            scene = load_scene(request.match_info["scene_id"])
            return web.FileResponse(_scene_reference_file(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/reference/preview")
    async def factory_scene_reference_preview_get(request: Any) -> Any:
        try:
            scene = load_scene(request.match_info["scene_id"])
            return web.FileResponse(
                await asyncio.to_thread(_ensure_scene_reference_preview, scene),
                headers={"Cache-Control": "private, max-age=31536000, immutable"},
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/skydome")
    async def factory_scene_skydome_upload(request: Any) -> Any:
        try:
            if not _content_length_ok(request, MAX_SKYDOME_BYTES + 1024 * 1024):
                return web.json_response({"error": "skydome upload is too large"}, status=413)
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            load_scene(scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                raise ValueError("missing skydome image")
            image_bytes = await asyncio.to_thread(
                image_field.file.read,
                MAX_SKYDOME_BYTES + 1,
            )
            scene = await asyncio.to_thread(
                store_scene_skydome,
                scene_id,
                image_bytes,
                getattr(image_field, "filename", "skydome.jpg"),
            )
            return web.json_response(_public_scene(scene), status=201)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/skydome")
    async def factory_scene_skydome_get(request: Any) -> Any:
        try:
            scene = load_scene(request.match_info["scene_id"])
            return web.FileResponse(_scene_skydome_file(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/skydome/viewport")
    async def factory_scene_skydome_viewport_get(request: Any) -> Any:
        try:
            scene = load_scene(request.match_info["scene_id"])
            return web.FileResponse(
                await asyncio.to_thread(_ensure_scene_skydome_viewport, scene),
                headers={"Cache-Control": "private, max-age=31536000, immutable"},
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.delete(f"{API_BASE}/scenes/{{scene_id}}/skydome")
    async def factory_scene_skydome_delete(request: Any) -> Any:
        try:
            scene = remove_scene_skydome(request.match_info["scene_id"])
            return web.json_response(_public_scene(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/textures")
    async def factory_scene_texture_upload(request: Any) -> Any:
        try:
            if not _content_length_ok(request, MAX_TEXTURE_BYTES + 1024 * 1024):
                return web.json_response({"error": "texture upload is too large"}, status=413)
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            load_scene(scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                raise ValueError("missing texture image")
            image_bytes = await asyncio.to_thread(
                image_field.file.read,
                MAX_TEXTURE_BYTES + 1,
            )
            scene, entry = await asyncio.to_thread(
                store_scene_texture,
                scene_id,
                image_bytes,
                getattr(image_field, "filename", "texture.png"),
            )
            public_scene = _public_scene(scene)
            public_entry = next(
                item for item in public_scene.get("textures", [])
                if item.get("texture_id") == entry["texture_id"]
            )
            return web.json_response({"texture": public_entry, "scene": public_scene}, status=201)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/textures/{{texture_id}}")
    async def factory_scene_texture_get(request: Any) -> Any:
        try:
            scene = load_scene(request.match_info["scene_id"])
            return web.FileResponse(
                _scene_texture_file(scene, request.match_info["texture_id"]),
                headers={"Cache-Control": "private, max-age=31536000, immutable"},
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.delete(f"{API_BASE}/scenes/{{scene_id}}/textures/{{texture_id}}")
    async def factory_scene_texture_delete(request: Any) -> Any:
        try:
            scene = await asyncio.to_thread(
                remove_scene_texture,
                request.match_info["scene_id"],
                request.match_info["texture_id"],
            )
            return web.json_response(_public_scene(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/preview")
    async def factory_scene_preview_upload(request: Any) -> Any:
        try:
            if not _content_length_ok(request, MAX_PREVIEW_BYTES + 1024 * 1024):
                return web.json_response({"error": "preview upload is too large"}, status=413)
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            load_scene(scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                raise ValueError("missing scene preview image")
            image_bytes = image_field.file.read(MAX_PREVIEW_BYTES + 1)
            scene = store_scene_preview(
                scene_id,
                image_bytes,
                post.get("revision"),
                post.get("render_revision"),
                post.get("capture_token"),
            )
            return web.json_response(_public_scene(scene)["preview"], status=201)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/capture-set")
    async def factory_scene_capture_set_upload(request: Any) -> Any:
        try:
            maximum = (MAX_SCENE_CAMERAS + 1) * MAX_PREVIEW_BYTES + 2 * 1024 * 1024
            if not _content_length_ok(request, maximum):
                return web.json_response(
                    {"error": "camera capture set upload is too large"},
                    status=413,
                )
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            load_scene(scene_id)
            post = await request.post()
            current_field = post.get("current")
            if current_field is None or not hasattr(current_field, "file"):
                raise ValueError("missing current viewport capture")
            try:
                camera_ids = json.loads(str(post.get("camera_ids", "[]")))
            except json.JSONDecodeError as exc:
                raise ValueError("scene camera capture ids are invalid") from exc
            if not isinstance(camera_ids, list):
                raise ValueError("scene camera capture ids are invalid")
            normalized_ids = [
                _validate_id(camera_id, "camera id") for camera_id in camera_ids
            ]
            camera_images: dict[str, Any] = {}
            for camera_id in normalized_ids:
                image_field = post.get(f"camera_{camera_id}")
                if image_field is None or not hasattr(image_field, "file"):
                    raise ValueError(f"missing capture for camera {camera_id}")
                camera_images[camera_id] = image_field.file
            scene = await asyncio.to_thread(
                store_scene_capture_set,
                scene_id,
                current_field.file,
                camera_images,
                normalized_ids,
                post.get("revision"),
                post.get("render_revision"),
                post.get("capture_token"),
            )
            public_scene = _public_scene(scene)
            return web.json_response(
                {
                    "preview": public_scene.get("preview"),
                    "camera_count": len(normalized_ids),
                    "capture_token": scene["preview_sync"]["capture_token"],
                },
                status=201,
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/preview")
    async def factory_scene_preview_get(request: Any) -> Any:
        try:
            scene = load_scene(request.match_info["scene_id"])
            return web.FileResponse(_scene_preview_file(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/preview/error")
    async def factory_scene_preview_error(request: Any) -> Any:
        try:
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError("scene preview failure payload must be an object")
            scene = store_scene_preview_error(
                scene_id,
                payload.get("capture_token"),
                payload.get("error"),
            )
            return web.json_response(
                {
                    "status": "recorded",
                    "capture_token": scene["preview_sync"]["capture_token"],
                },
                status=201,
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/generate")
    async def factory_generate(request: Any) -> Any:
        try:
            if not _content_length_ok(request, MAX_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "image upload is too large"}, status=413)
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            load_scene(scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is not None and hasattr(image_field, "file"):
                image_bytes = image_field.file.read(MAX_UPLOAD_BYTES + 1)
            elif str(post.get("use_scene_reference", "")) == "1":
                image_bytes = _scene_reference_file(load_scene(scene_id)).read_bytes()
            else:
                raise ValueError("missing image")
            _decode_image(image_bytes)
            settings = _generation_settings(post)
            object_id = _new_id()
            name = _clean_name(post.get("name"), f"Object {object_id[:6]}", 80)
            job = _new_job("generation", scene_id)
            provider = settings["provider"]
            job["provider"] = provider
            generator = (
                _generate_mesh_object
                if provider in factory3d_generation.MESH_PROVIDER_KEYS
                else _generate_object
            )
            _track_task(
                asyncio.to_thread(
                    _run_job,
                    job,
                    lambda current: generator(
                        current,
                        image_bytes,
                        object_id,
                        name,
                        settings,
                    ),
                )
            )
            return web.json_response(_job_public(job), status=202)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/jobs/{{job_id}}")
    async def factory_job_get(request: Any) -> Any:
        try:
            job_id = _validate_id(request.match_info["job_id"], "job id")
            with _STATE_LOCK:
                job = _JOBS.get(job_id)
            if job is None:
                raise FileNotFoundError(f"Factory job {job_id} was not found")
            return web.json_response(_job_public(job))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/jobs/{{job_id}}/cancel")
    async def factory_job_cancel(request: Any) -> Any:
        try:
            job_id = _validate_id(request.match_info["job_id"], "job id")
            with _STATE_LOCK:
                job = _JOBS.get(job_id)
                if job is None:
                    raise FileNotFoundError(f"Factory job {job_id} was not found")
                job["cancel_event"].set()
            _emit(job, "cancelling", job.get("progress", 0), "Cancellation requested", level="warning")
            return web.json_response(_job_public(job))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/jobs/{{job_id}}/log")
    async def factory_job_log(request: Any) -> Any:
        try:
            job_id = _validate_id(request.match_info["job_id"], "job id")
            with _STATE_LOCK:
                job = _JOBS.get(job_id)
            if job is None:
                raise FileNotFoundError(f"Factory job {job_id} was not found")
            path = _job_log_path(job)
            if not path.is_file():
                raise FileNotFoundError("job log is not available")
            return web.FileResponse(path, headers={"Content-Disposition": f'attachment; filename="factory-{job_id}.log"'})
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}/asset/{{kind}}")
    async def factory_object_asset(request: Any) -> Any:
        try:
            kind = request.match_info["kind"]
            if kind not in {
                "ply", "splat", "prepared", "reference", "thumbnail", "model", "resource",
            }:
                raise FileNotFoundError("unknown object asset")
            scene = load_scene(request.match_info["scene_id"])
            item = _object_by_id(scene, request.match_info["object_id"])
            if kind == "splat":
                path = await asyncio.to_thread(
                    _ensure_object_splat,
                    scene["scene_id"],
                    item["object_id"],
                )
            elif kind == "thumbnail":
                path = await asyncio.to_thread(
                    _ensure_object_thumbnail,
                    scene["scene_id"],
                    item,
                )
            elif kind == "resource":
                path = _object_model_resource(
                    scene["scene_id"],
                    item,
                    request.query.get("path", ""),
                )
            else:
                path = _object_file(scene["scene_id"], item, kind)
            headers = {"Cache-Control": "private, max-age=31536000, immutable"}
            if kind == "model":
                filename = _clean_name(item.get("source", {}).get("filename"), path.name, 160)
                headers["Content-Disposition"] = (
                    "inline; filename*=UTF-8''" + urllib.parse.quote(filename, safe="")
                )
            return web.FileResponse(
                path,
                headers=headers,
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/objects/import")
    async def factory_object_import(request: Any) -> Any:
        try:
            if not _content_length_ok(request, MAX_PLY_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "PLY upload is too large"}, status=413)
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            load_scene(scene_id)
            post = await request.post()
            ply_field = post.get("ply")
            if ply_field is None or not hasattr(ply_field, "file"):
                raise ValueError("missing PLY file")
            result = await asyncio.to_thread(
                import_ply_object,
                scene_id,
                ply_field.file,
                getattr(ply_field, "filename", "model.ply"),
                post.get("name"),
            )
            return web.json_response(
                {
                    "scene": _public_scene(result["scene"]),
                    "object_id": result["object_id"],
                },
                status=201,
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/objects/import-model")
    async def factory_model_import(request: Any) -> Any:
        try:
            if not _content_length_ok(request, MAX_MODEL_UPLOAD_TOTAL_BYTES + 2 * 1024 * 1024):
                return web.json_response({"error": "3D model upload is too large"}, status=413)
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            load_scene(scene_id)
            post = await request.post()
            fields = [field for field in post.getall("files", []) if hasattr(field, "file")]
            if not fields:
                raise ValueError("missing 3D model files")
            try:
                paths = json.loads(str(post.get("paths") or "[]"))
            except json.JSONDecodeError as exc:
                raise ValueError("3D model file paths are invalid") from exc
            if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
                raise ValueError("3D model file paths are invalid")
            result = await asyncio.to_thread(
                import_model_object,
                scene_id,
                [
                    (getattr(field, "filename", f"asset-{index + 1}"), field.file)
                    for index, field in enumerate(fields)
                ],
                paths=paths,
                main_path=str(post.get("main_path") or ""),
                object_name=post.get("name"),
            )
            return web.json_response(
                {"scene": _public_scene(result["scene"]), "object_id": result["object_id"]},
                status=201,
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/objects/primitive")
    async def factory_primitive_create(request: Any) -> Any:
        try:
            if not _content_length_ok(request, 256 * 1024):
                return web.json_response({"error": "primitive request is too large"}, status=413)
            payload = await request.json()
            result = await asyncio.to_thread(
                create_primitive_object,
                request.match_info["scene_id"],
                payload,
            )
            return web.json_response({
                "scene": _public_scene(result["scene"]),
                "object_id": result["object_id"],
            }, status=201)
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.patch(f"{API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}")
    async def factory_object_update(request: Any) -> Any:
        try:
            payload = await request.json()
            object_id = _validate_id(request.match_info["object_id"], "object id")
            scene = update_scene(
                request.match_info["scene_id"],
                {"objects": [{"object_id": object_id, **(payload if isinstance(payload, dict) else {})}]},
            )
            return web.json_response(_public_scene(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}/duplicate")
    async def factory_object_duplicate(request: Any) -> Any:
        try:
            result = await asyncio.to_thread(
                duplicate_object,
                request.match_info["scene_id"],
                request.match_info["object_id"],
            )
            return web.json_response({
                "scene": _public_scene(result["scene"]),
                "object_id": result["object_id"],
            })
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.delete(f"{API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}")
    async def factory_object_delete(request: Any) -> Any:
        try:
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            object_id = _validate_id(request.match_info["object_id"], "object id")
            with _STATE_LOCK:
                scene = load_scene(scene_id)
                _object_by_id(scene, object_id)
                scene["objects"] = [item for item in scene["objects"] if item.get("object_id") != object_id]
                _remove_object_layer(scene["layers"], object_id)
                scene["exports"] = {}
                _save_scene(scene)
            target = resolve_scene_dir(scene_id) / "objects" / object_id
            if target.is_dir() and target.parent == resolve_scene_dir(scene_id) / "objects":
                shutil.rmtree(target)
            return web.json_response(_public_scene(scene))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}/export/ply")
    async def factory_object_export(request: Any) -> Any:
        try:
            path = await asyncio.to_thread(
                _ensure_object_ply_export,
                request.match_info["scene_id"],
                request.match_info["object_id"],
            )
            download_name = f"{_validate_id(request.match_info['object_id'], 'object id')}.ply"
            return web.FileResponse(
                path,
                headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/export")
    async def factory_scene_export(request: Any) -> Any:
        try:
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            result = await asyncio.to_thread(ensure_scene_ply_export, scene_id)
            return web.json_response(_public_scene(result["scene"]))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/exports/ply")
    async def factory_scene_export_download(request: Any) -> Any:
        try:
            result = await asyncio.to_thread(
                ensure_scene_ply_export,
                request.match_info["scene_id"],
            )
            path = result["ply"]
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            return web.FileResponse(
                path,
                headers={
                    "Content-Disposition":
                    f'attachment; filename="scene-{scene_id}.ply"'
                },
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    # The model library is part of the Factory API and must be added to the
    # exact same ComfyUI RouteTableDef. Keeping this call inside the proven
    # Factory registrar prevents a second, late aiohttp registration path.
    from .factory3d_library import register_routes as register_library_routes

    register_library_routes(routes)
    _REGISTERED = True


register_factory3d_routes = register_routes
