"""ComfyUI server API for the VNCCS 3D Factory scene editor."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import math
import os
import re
import secrets
import shutil
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageOps

from .gaussian_scene import (
    export_gaussian_scene,
    inspect_ply,
    normalize_transform,
    validate_ply_payload,
    validate_splat_payload,
)
from .gaussian_mesh import export_gaussian_ply_glb


LOGGER = logging.getLogger("vnccs.3d_factory")
API_BASE = "/vnccs/3d-factory"
SCHEMA_VERSION = 4
EXPORT_FORMAT_VERSION = 5
GLB_FORMAT_VERSION = 3
UPSTREAM_REPOSITORY = "VAST-AI/TripoSplat"
UPSTREAM_COMMIT = "a78fa12d06dbf1381ca548bfac32bb68cb8c451d"
MAX_UPLOAD_BYTES = 32 * 1024 * 1024
MAX_PREVIEW_BYTES = 64 * 1024 * 1024
MAX_IMAGE_PIXELS = 4096 * 4096
MAX_SCENE_JSON_BYTES = 2 * 1024 * 1024
MAX_JOB_LOG_LINES = 800
MAX_ACTIVE_JOBS = 2
GAUSSIAN_COUNTS = (32768, 65536, 131072, 262144, 524288, 1048576)
EXPERIMENTAL_GAUSSIAN_COUNTS = (524288, 1048576)
CONDITIONING_RESOLUTIONS = (1024, 1536, 2048)
EXPERIMENTAL_CONDITIONING_RESOLUTIONS = (1536, 2048)
_ID_RE = re.compile(r"^[a-f0-9]{32}$")
_SAFE_NAME_RE = re.compile(r"[\x00-\x1f\x7f]+")
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
_WEIGHT_FILES = (
    "diffusion_models/triposplat_fp16.safetensors",
    "vae/triposplat_vae_decoder_fp16.safetensors",
    "clip_vision/dino_v3_vit_h.safetensors",
    "vae/flux2-vae.safetensors",
    "background_removal/birefnet.safetensors",
)

_STATE_LOCK = threading.RLock()
_INFERENCE_LOCK = threading.Lock()
_PIPELINE: Any = None
_PIPELINE_SIGNATURE: tuple[Any, ...] | None = None
_JOBS: dict[str, dict[str, Any]] = {}
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()
_REGISTERED = False


class JobCancelled(RuntimeError):
    pass


def _now() -> float:
    return time.time()


def _factory_root() -> Path:
    configured = os.environ.get("VNCCS_3D_FACTORY_OUTPUT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    try:
        import folder_paths  # type: ignore

        return Path(folder_paths.get_output_directory()).resolve() / "vnccs_3d_factory"
    except Exception:
        return Path.cwd().resolve() / "output" / "vnccs_3d_factory"


def _model_root() -> Path:
    configured = os.environ.get("VNCCS_TRIPOSPLAT_MODELS", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    try:
        import folder_paths  # type: ignore

        return Path(folder_paths.models_dir).resolve()
    except Exception:
        return Path.cwd().resolve() / "models"


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
    return {
        "position": vector("position"),
        "target": vector("target"),
        "fov": max(5.0, min(120.0, fov)),
    }


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
    }


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
    visible: set[str] = set()
    for layer in _normalize_scene_layers(scene):
        if layer["type"] == "object":
            object_id = layer["object_id"]
            if objects[object_id].get("visible") is not False:
                visible.add(object_id)
            continue
        if layer.get("visible") is False:
            continue
        for object_id in layer["children"]:
            if objects[object_id].get("visible") is not False:
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


def load_scene(scene_id: str) -> dict[str, Any]:
    path = _scene_path(scene_id)
    if not path.is_file():
        raise FileNotFoundError(f"Factory scene {_validate_id(scene_id, 'scene id')} was not found")
    if path.stat().st_size > MAX_SCENE_JSON_BYTES:
        raise ValueError("scene metadata is too large")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("scene_id") != scene_id:
        raise ValueError("scene metadata is invalid")
    if not isinstance(value.get("objects"), list):
        value["objects"] = []
    value["layers"] = _normalize_scene_layers(value)
    value["render"] = _normalize_render_settings(value.get("render"))
    value["camera"] = _normalize_camera(value.get("camera"))
    value["lighting"] = _normalize_lighting(value.get("lighting"))
    value["render_revision"] = max(
        0,
        int(value.get("render_revision", value.get("revision", 0))),
    )
    value["schema_version"] = SCHEMA_VERSION
    return value


def _save_scene(scene: dict[str, Any], *, bump_revision: bool = True) -> dict[str, Any]:
    scene_id = _validate_id(scene.get("scene_id"), "scene id")
    if bump_revision:
        scene["revision"] = max(0, int(scene.get("revision", 0))) + 1
        scene["render_revision"] = max(
            0,
            int(scene.get("render_revision", scene["revision"] - 1)),
        ) + 1
    scene["updated_at"] = _now()
    _atomic_json(_scene_path(scene_id), scene)
    return scene


def create_scene(name: Any = "") -> dict[str, Any]:
    scene_id = _new_id()
    timestamp = _now()
    scene = {
        "schema_version": SCHEMA_VERSION,
        "scene_id": scene_id,
        "name": _clean_name(name, "Untitled scene"),
        "revision": 0,
        "render_revision": 0,
        "created_at": timestamp,
        "updated_at": timestamp,
        "objects": [],
        "layers": [],
        "render": dict(_DEFAULT_RENDER_SETTINGS),
        "camera": {
            "position": list(_DEFAULT_CAMERA["position"]),
            "target": list(_DEFAULT_CAMERA["target"]),
            "fov": _DEFAULT_CAMERA["fov"],
        },
        "lighting": dict(_DEFAULT_LIGHTING),
        "exports": {},
    }
    with _STATE_LOCK:
        resolve_scene_dir(scene_id).mkdir(parents=True, exist_ok=False)
        _save_scene(scene, bump_revision=False)
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
                }
            )
        except (OSError, ValueError, json.JSONDecodeError):
            LOGGER.warning("Skipping invalid Factory scene at %s", path, exc_info=True)
    entries.sort(key=lambda item: item["updated_at"], reverse=True)
    return entries[: max(1, min(500, int(limit)))]


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
        "splat": "model.splat",
    }
    try:
        with _STATE_LOCK:
            scene = load_scene(safe_scene_id)
            source_item = _object_by_id(scene, safe_object_id)
            duplicate_root.mkdir(parents=True, exist_ok=False)
            duplicate_files: dict[str, str] = {}
            for key, file_name in file_names.items():
                try:
                    source = _object_file(safe_scene_id, source_item, key)
                except FileNotFoundError:
                    if key in {"ply", "splat"}:
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


def _object_file(scene_id: str, item: dict[str, Any], key: str) -> Path:
    relative = item.get("files", {}).get(key)
    if not isinstance(relative, str) or not relative:
        raise FileNotFoundError(f"object has no {key} asset")
    root = resolve_scene_dir(scene_id)
    target = (root / relative).resolve()
    if root not in target.parents or not target.is_file():
        raise FileNotFoundError(f"object {key} asset is missing")
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
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        scene["reference"] = {
            "file": str(target.relative_to(root)),
            "name": safe_name,
            "mime": "image/png",
            "width": image.width,
            "height": image.height,
            "size": target.stat().st_size,
            "updated_at": _now(),
        }
        _save_scene(scene, bump_revision=False)
        return scene


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
    if not os.environ.get("VNCCS_TRIPOSPLAT_MODELS", "").strip():
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


def _weights_status() -> dict[str, Any]:
    root = _model_root()
    files = []
    ready = True
    total_size = 0
    for relative, path in _weight_paths().items():
        exists = _valid_weight(path)
        size = path.stat().st_size if exists else 0
        total_size += size
        ready = ready and exists
        files.append(
            {
                "path": relative,
                "ready": exists,
                "size": size,
                "resolved_path": str(path),
                "searched_paths": [str(candidate) for candidate in _weight_candidates(relative)],
            }
        )
    return {
        "ready": ready,
        "root": str(root),
        "files": files,
        "installed_bytes": total_size,
        "repository": UPSTREAM_REPOSITORY,
    }


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
    return {
        "schema_version": SCHEMA_VERSION,
        "backend": "TripoSplat",
        "backend_repository": "https://github.com/VAST-AI-Research/TripoSplat",
        "backend_commit": UPSTREAM_COMMIT,
        "formats": ["ply", "splat", "glb"],
        "gaussian_counts": list(GAUSSIAN_COUNTS),
        "experimental_gaussian_counts": list(EXPERIMENTAL_GAUSSIAN_COUNTS),
        "conditioning_resolutions": list(CONDITIONING_RESOLUTIONS),
        "experimental_conditioning_resolutions": list(EXPERIMENTAL_CONDITIONING_RESOLUTIONS),
        "scene_render": {
            "min_side": 64,
            "max_side": 4096,
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
    }


def _generation_settings(values: Any) -> dict[str, Any]:
    data = values if hasattr(values, "get") else {}
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


def _download_weights(job: dict[str, Any]) -> dict[str, Any]:
    from huggingface_hub import hf_hub_download

    root = _model_root()
    root.mkdir(parents=True, exist_ok=True)
    _emit(job, "weights", 2, "Preparing TripoSplat weights", detail=str(root))
    for index, relative in enumerate(_WEIGHT_FILES):
        _check_cancel(job)
        start = 5 + index / len(_WEIGHT_FILES) * 90
        _emit(
            job,
            "weights",
            start,
            f"Downloading {index + 1}/{len(_WEIGHT_FILES)}",
            detail=relative,
        )
        hf_hub_download(
            repo_id=UPSTREAM_REPOSITORY,
            filename=relative,
            local_dir=str(root),
        )
        _emit(
            job,
            "weights",
            5 + (index + 1) / len(_WEIGHT_FILES) * 90,
            f"Verified {index + 1}/{len(_WEIGHT_FILES)}",
            detail=relative,
        )
    status = _weights_status()
    if not status["ready"]:
        raise RuntimeError("TripoSplat weight download finished with missing files")
    return {"weights": status}


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

        with _INFERENCE_LOCK:
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
            splat_path = object_root / "model.splat"
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
            _emit(
                job,
                "validate",
                94,
                "Validated Gaussian PLY",
                detail=(
                    f"{ply_info.vertex_count:,} splats · {ply_path.stat().st_size:,} bytes · "
                    f"{ply_validation['invalid_values']} invalid values · "
                    f"{ply_validation['invalid_scales']} invalid scales · "
                    f"{ply_validation['invalid_quaternions']} invalid quaternions · "
                    f"sha256={ply_hash[:16]}"
                ),
            )
            _emit(job, "serialize", 96, "Writing compact SPLAT", detail=f"{gaussian_count:,} splats")

            def splat_callback(completed: int, total: int) -> None:
                _check_cancel(job)
                _emit(
                    job,
                    "serialize",
                    96.0 + (float(completed) / max(1, total)),
                    "Writing compact SPLAT",
                    detail=f"{completed:,}/{total:,} splats",
                )

            gaussian.save_splat(
                splat_path,
                callback=splat_callback,
                _validated_report=gaussian_report,
            )
            expected_splat_bytes = gaussian_count * 32
            if splat_path.stat().st_size != expected_splat_bytes:
                raise RuntimeError(
                    f"serialized SPLAT is {splat_path.stat().st_size:,} bytes; "
                    f"expected {expected_splat_bytes:,}"
                )
            splat_validation = validate_splat_payload(
                splat_path,
                expected_gaussians=gaussian_count,
            )
            splat_hash = _sha256_file(splat_path)
            _emit(
                job,
                "validate",
                97,
                "Validated compact SPLAT",
                detail=(
                    f"{gaussian_count:,} splats · {expected_splat_bytes:,} bytes · "
                    f"{splat_validation['invalid_values']} invalid values · "
                    f"{splat_validation['invalid_scales']} invalid scales · "
                    f"{splat_validation['invalid_rotations']} invalid rotations · "
                    f"sha256={splat_hash[:16]}"
                ),
            )
            del gaussian, latent

        relative_root = Path("objects") / object_id
        item = {
            "object_id": object_id,
            "name": object_name,
            "created_at": _now(),
            "transform": normalize_transform({}),
            "gaussians": gaussian_count,
            "seed": seed,
            "checksums": {
                "ply_sha256": ply_hash,
                "splat_sha256": splat_hash,
            },
            "validation": {
                "tensor_ranges": gaussian_report["ranges"],
                "ply": {
                    "invalid_values": ply_validation["invalid_values"],
                    "invalid_scales": ply_validation["invalid_scales"],
                    "invalid_quaternions": ply_validation["invalid_quaternions"],
                },
                "splat": {
                    "invalid_values": splat_validation["invalid_values"],
                    "invalid_scales": splat_validation["invalid_scales"],
                    "invalid_rotations": splat_validation["invalid_rotations"],
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
                "splat": str(relative_root / "model.splat"),
            },
        }
        _emit(job, "scene", 98, "Adding object to scene", detail=object_name)
        with _STATE_LOCK:
            scene = load_scene(scene_id)
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


def _public_scene(scene: dict[str, Any]) -> dict[str, Any]:
    value = json.loads(json.dumps(scene))
    scene_id = value["scene_id"]
    reference = value.get("reference")
    if isinstance(reference, dict):
        reference["url"] = f"{API_BASE}/scenes/{scene_id}/reference"
        reference.pop("file", None)
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
        item["urls"] = {
            "splat": f"{API_BASE}/scenes/{scene_id}/objects/{object_id}/asset/splat",
            "ply": f"{API_BASE}/scenes/{scene_id}/objects/{object_id}/asset/ply",
            "thumbnail": f"{API_BASE}/scenes/{scene_id}/objects/{object_id}/asset/prepared",
            "reference": f"{API_BASE}/scenes/{scene_id}/objects/{object_id}/asset/reference",
            "export_ply": f"{API_BASE}/scenes/{scene_id}/objects/{object_id}/export/ply",
            "export_splat": f"{API_BASE}/scenes/{scene_id}/objects/{object_id}/export/splat",
            "export_glb": f"{API_BASE}/scenes/{scene_id}/objects/{object_id}/export/glb",
        }
        item.pop("files", None)
    exports = value.get("exports")
    if isinstance(exports, dict) and exports.get("revision") is not None:
        exports["urls"] = {
            "ply": f"{API_BASE}/scenes/{scene_id}/exports/ply",
            "splat": f"{API_BASE}/scenes/{scene_id}/exports/splat",
            "glb": f"{API_BASE}/scenes/{scene_id}/exports/glb",
            "camera": f"{API_BASE}/scenes/{scene_id}/exports/camera",
        }
        exports.pop("files", None)
    return value


def update_scene(scene_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("scene update must be an object")
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        visible_before = _visible_object_ids(scene)
        changed = False
        render_changed = False
        preview_changed = False
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
        if "layers" in payload:
            layers = _normalize_scene_layers(scene, payload["layers"], strict=True)
            if layers != scene.get("layers"):
                scene["layers"] = layers
                changed = True
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
        if "lighting" in payload:
            lighting = _normalize_lighting(payload["lighting"])
            if lighting != _normalize_lighting(scene.get("lighting")):
                scene["lighting"] = lighting
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
        return _save_scene(scene, bump_revision=render_changed)


def _scene_sources(scene: dict[str, Any], only_object_id: str = "") -> list[tuple[Path, Any]]:
    output = []
    visible_ids = _visible_object_ids(scene) if not only_object_id else set()
    for item in scene.get("objects", []):
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
    render = _normalize_render_settings(scene.get("render"))
    return {
        "schema": "vnccs-3d-factory-gaussian-scene/v1",
        "scene_id": scene["scene_id"],
        "scene_revision": revision,
        "render_revision": render_revision,
        "coordinate_system": "right-handed-y-up",
        "camera": {
            "projection": "perspective",
            "position": camera["position"],
            "target": camera["target"],
            "up": [0.0, 1.0, 0.0],
            "fov": camera["fov"],
            "fov_axis": "vertical-degrees",
        },
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


def ensure_scene_exports(scene_id: str) -> dict[str, Any]:
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
                    splat = _object_file(scene_id, {"files": existing["files"]}, "splat")
                    camera_manifest = _object_file(
                        scene_id,
                        {"files": existing["files"]},
                        "camera",
                    )
                    result = {
                        "scene": scene,
                        "ply": ply,
                        "splat": splat,
                        "camera": camera_manifest,
                    }
                    glb_file = existing.get("files", {}).get("glb")
                    if glb_file:
                        try:
                            result["glb"] = _object_file(
                                scene_id,
                                {"files": existing["files"]},
                                "glb",
                            )
                        except FileNotFoundError:
                            pass
                    return result
                except (KeyError, FileNotFoundError):
                    pass
            sources = _scene_sources(scene)

        export_root = resolve_scene_dir(scene_id) / "exports"
        export_stem = (
            f"scene-v{EXPORT_FORMAT_VERSION}-r{revision}-rr{render_revision}"
        )
        ply = export_root / f"{export_stem}.ply"
        splat = export_root / f"{export_stem}.splat"
        camera_manifest = export_root / f"{export_stem}.camera.json"
        result = export_gaussian_scene(
            sources,
            ply,
            splat,
            metadata=camera_metadata,
        )
        camera_manifest_value = {
            **camera_metadata,
            "assets": {
                "ply": {
                    "file": ply.name,
                    "sha256": _sha256_file(ply),
                    "gaussians": result["ply"]["gaussians"],
                },
                "splat": {
                    "file": splat.name,
                    "sha256": _sha256_file(splat),
                    "gaussians": result["splat"]["gaussians"],
                },
            },
        }
        _atomic_json(camera_manifest, camera_manifest_value)
        relative_ply = str(ply.relative_to(resolve_scene_dir(scene_id)))
        relative_splat = str(splat.relative_to(resolve_scene_dir(scene_id)))
        relative_camera = str(camera_manifest.relative_to(resolve_scene_dir(scene_id)))
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
                    "splat": relative_splat,
                    "camera": relative_camera,
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
            return {
                "scene": current,
                "ply": ply,
                "splat": splat,
                "camera": camera_manifest,
            }
    raise RuntimeError("scene export did not stabilize")


def ensure_scene_glb(scene_id: str) -> dict[str, Any]:
    for attempt in range(2):
        base = ensure_scene_exports(scene_id)
        with _STATE_LOCK:
            scene = load_scene(scene_id)
            revision = int(scene.get("revision", 0))
            existing = scene.get("exports", {})
            glb_file = existing.get("files", {}).get("glb") if isinstance(existing, dict) else None
            if (
                existing.get("revision") == revision
                and existing.get("format_version") == EXPORT_FORMAT_VERSION
                and existing.get("gaussian_glb", {}).get("format_version")
                == GLB_FORMAT_VERSION
                and glb_file
            ):
                try:
                    glb = _object_file(scene_id, {"files": existing["files"]}, "glb")
                    return {**base, "scene": scene, "glb": glb}
                except FileNotFoundError:
                    pass
            camera_metadata = _scene_camera_metadata(
                scene,
                revision=revision,
                render_revision=int(scene.get("render_revision", revision)),
            )
            scene_name = str(scene.get("name") or "Gaussian scene")

        export_root = resolve_scene_dir(scene_id) / "exports"
        glb = export_root / (
            f"scene-glb-v{GLB_FORMAT_VERSION}-r{revision}.glb"
        )
        glb_result = export_gaussian_ply_glb(
            base["ply"],
            glb,
            name=scene_name,
            metadata=camera_metadata,
        )
        relative_glb = str(glb.relative_to(resolve_scene_dir(scene_id)))
        with _STATE_LOCK:
            current = load_scene(scene_id)
            if int(current.get("revision", 0)) != revision:
                try:
                    glb.unlink()
                except OSError:
                    pass
                if attempt == 0:
                    continue
                raise RuntimeError(
                    "scene changed repeatedly while its Gaussian GLB was being exported"
                )
            exports = current.get("exports", {})
            if (
                not isinstance(exports, dict)
                or exports.get("revision") != revision
                or exports.get("format_version") != EXPORT_FORMAT_VERSION
            ):
                if attempt == 0:
                    continue
                raise RuntimeError("Gaussian scene exports changed while GLB was being written")
            exports.setdefault("files", {})["glb"] = relative_glb
            exports.pop("mesh", None)
            exports["gaussian_glb"] = {
                "format_version": GLB_FORMAT_VERSION,
                "extension": glb_result["extension"],
                "gaussians": glb_result["gaussians"],
                "sh_degree": glb_result["sh_degree"],
                "camera": glb_result["camera"],
                "bytes": glb_result["bytes"],
            }
            exports["glb_created_at"] = _now()
            _save_scene(current, bump_revision=False)
            return {**base, "scene": current, "glb": glb}
    raise RuntimeError("scene GLB export did not stabilize")


def _ensure_object_export(scene_id: str, object_id: str, format_name: str) -> Path:
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        item = _object_by_id(scene, object_id)
        revision = int(scene.get("revision", 0))
        source = _object_file(scene_id, item, "ply")
        transform = item.get("transform")
        object_name = str(item.get("name") or "Gaussian object")
    root = resolve_scene_dir(scene_id) / "exports" / "objects"
    ply = root / f"{object_id}-v{EXPORT_FORMAT_VERSION}-r{revision}.ply"
    splat = root / f"{object_id}-v{EXPORT_FORMAT_VERSION}-r{revision}.splat"
    glb = root / f"{object_id}-glb-v{GLB_FORMAT_VERSION}-r{revision}.glb"
    target = {"ply": ply, "splat": splat, "glb": glb}[format_name]
    if not target.is_file():
        if format_name == "glb":
            if not ply.is_file():
                export_gaussian_scene([(source, transform)], ply)
            export_gaussian_ply_glb(ply, glb, name=object_name)
        else:
            export_gaussian_scene(
                [(source, transform)],
                ply,
                splat if format_name == "splat" else None,
            )
    return target


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

    @routes.post(f"{API_BASE}/weights/download")
    async def factory_weights_download(_request: Any) -> Any:
        try:
            job = _new_job("weights")
            _track_task(asyncio.to_thread(_run_job, job, _download_weights))
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
            image_bytes = image_field.file.read(MAX_UPLOAD_BYTES + 1)
            scene = store_scene_reference(
                scene_id,
                image_bytes,
                getattr(image_field, "filename", "reference.png"),
            )
            return web.json_response(_public_scene(scene)["reference"], status=201)
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
            _track_task(
                asyncio.to_thread(
                    _run_job,
                    job,
                    lambda current: _generate_object(
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
            if kind not in {"ply", "splat", "prepared", "reference"}:
                raise FileNotFoundError("unknown object asset")
            scene = load_scene(request.match_info["scene_id"])
            item = _object_by_id(scene, request.match_info["object_id"])
            return web.FileResponse(_object_file(scene["scene_id"], item, kind))
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

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/objects/{{object_id}}/export/{{format_name}}")
    async def factory_object_export(request: Any) -> Any:
        try:
            format_name = request.match_info["format_name"]
            if format_name not in {"ply", "splat", "glb"}:
                raise FileNotFoundError("unknown export format")
            path = await asyncio.to_thread(
                _ensure_object_export,
                request.match_info["scene_id"],
                request.match_info["object_id"],
                format_name,
            )
            return web.FileResponse(
                path,
                headers={"Content-Disposition": f'attachment; filename="{path.name}"'},
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.post(f"{API_BASE}/scenes/{{scene_id}}/export")
    async def factory_scene_export(request: Any) -> Any:
        try:
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            try:
                payload = await request.json()
            except Exception:
                payload = {}
            format_name = str(payload.get("format", "ply")).lower() if isinstance(payload, dict) else "ply"
            if format_name not in {"ply", "splat", "glb"}:
                raise ValueError("unknown export format")
            exporter = ensure_scene_glb if format_name == "glb" else ensure_scene_exports
            result = await asyncio.to_thread(exporter, scene_id)
            return web.json_response(_public_scene(result["scene"]))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/exports/{{format_name}}")
    async def factory_scene_export_download(request: Any) -> Any:
        try:
            format_name = request.match_info["format_name"]
            if format_name not in {"ply", "splat", "glb", "camera"}:
                raise FileNotFoundError("unknown export format")
            exporter = ensure_scene_glb if format_name == "glb" else ensure_scene_exports
            result = await asyncio.to_thread(exporter, request.match_info["scene_id"])
            path = result[format_name]
            return web.FileResponse(
                path,
                headers={"Content-Disposition": f'attachment; filename="{path.name}"'},
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
