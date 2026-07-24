"""ComfyUI server API for the VNCCS 3D Factory scene editor."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
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

from .gaussian_scene import export_gaussian_scene, inspect_ply, normalize_transform


LOGGER = logging.getLogger("vnccs.3d_factory")
API_BASE = "/vnccs/3d-factory"
SCHEMA_VERSION = 1
EXPORT_FORMAT_VERSION = 2
UPSTREAM_REPOSITORY = "VAST-AI/TripoSplat"
UPSTREAM_COMMIT = "a78fa12d06dbf1381ca548bfac32bb68cb8c451d"
MAX_UPLOAD_BYTES = 32 * 1024 * 1024
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
    return value


def _save_scene(scene: dict[str, Any], *, bump_revision: bool = True) -> dict[str, Any]:
    scene_id = _validate_id(scene.get("scene_id"), "scene id")
    if bump_revision:
        scene["revision"] = max(0, int(scene.get("revision", 0))) + 1
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
        "created_at": timestamp,
        "updated_at": timestamp,
        "objects": [],
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


def _scene_preview_file(scene: dict[str, Any]) -> Path:
    preview = scene.get("preview", {})
    relative = preview.get("file") if isinstance(preview, dict) else None
    if not isinstance(relative, str) or not relative:
        raise FileNotFoundError("scene has no saved 3D preview")
    if int(preview.get("revision", -1)) != int(scene.get("revision", 0)):
        raise FileNotFoundError("scene 3D preview is stale")
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


def store_scene_preview(scene_id: str, image_bytes: bytes) -> dict[str, Any]:
    """Persist a clean render of the current browser-side 3D viewport."""
    image = _decode_image(image_bytes).convert("RGB")
    root = resolve_scene_dir(scene_id)
    preview_root = root / "preview"
    preview_root.mkdir(parents=True, exist_ok=True)
    target = preview_root / "scene.png"
    temporary = preview_root / f".scene.{secrets.token_hex(6)}.tmp"
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
        scene["preview"] = {
            "file": str(target.relative_to(root)),
            "mime": "image/png",
            "width": image.width,
            "height": image.height,
            "size": target.stat().st_size,
            "revision": int(scene.get("revision", 0)),
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
        "formats": ["ply", "splat"],
        "gaussian_counts": list(GAUSSIAN_COUNTS),
        "experimental_gaussian_counts": list(EXPERIMENTAL_GAUSSIAN_COUNTS),
        "conditioning_resolutions": list(CONDITIONING_RESOLUTIONS),
        "experimental_conditioning_resolutions": list(EXPERIMENTAL_CONDITIONING_RESOLUTIONS),
        "defaults": {
            "steps": 20,
            "guidance_scale": 3.0,
            "num_gaussians": 131072,
            "conditioning_resolution": 1024,
            "prevent_upscale": False,
            "erode_radius": 1,
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
    return {
        "steps": max(1, min(100, int(data.get("steps", 20)))),
        "guidance_scale": max(1.0, min(20.0, float(data.get("guidance_scale", 3.0)))),
        "num_gaussians": max(
            GAUSSIAN_COUNTS[0],
            min(GAUSSIAN_COUNTS[-1], round(int(data.get("num_gaussians", 131072)) / 32) * 32),
        ),
        "conditioning_resolution": conditioning_resolution,
        "prevent_upscale": prevent_upscale,
        "erode_radius": max(0, min(8, int(data.get("erode_radius", 1)))),
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

    from ..triposplat_backend import triposplat as engine

    target = torch.device(device)
    pipeline = engine.TripoSplatPipeline.__new__(engine.TripoSplatPipeline)
    pipeline._device = target
    components = (
        (
            "DINOv3 image encoder",
            "dinov3",
            engine.load_dinov3,
            "clip_vision/dino_v3_vit_h.safetensors",
            torch.bfloat16,
        ),
        (
            "Flux2 VAE encoder",
            "vae_encoder",
            engine.load_vae_encoder,
            "vae/flux2-vae.safetensors",
            torch.bfloat16,
        ),
        (
            "BiRefNet background remover",
            "rmbg",
            engine.load_rmbg,
            "background_removal/birefnet.safetensors",
            torch.float16,
        ),
        (
            "TripoSplat flow model",
            "flow_model",
            engine.load_flow_model,
            "diffusion_models/triposplat_fp16.safetensors",
            torch.float16,
        ),
        (
            "Gaussian decoder",
            "decoder",
            engine.load_decoder,
            "vae/triposplat_vae_decoder_fp16.safetensors",
            torch.float16,
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
            detail=f"{relative} · {str(dtype).removeprefix('torch.')} · {device}",
        )
        setattr(
            pipeline,
            attribute,
            loader(str(paths[relative]), device=target, dtype=dtype),
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


def _decode_image(image_bytes: bytes) -> Image.Image:
    if not image_bytes or len(image_bytes) > MAX_UPLOAD_BYTES:
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
                    f"erosion={settings['erode_radius']}"
                ),
            )
            generator = torch.Generator(device=pipeline._device).manual_seed(seed)

            _emit(job, "preprocess", 22, "Removing background and framing subject")
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
                erode_radius=settings["erode_radius"],
                canvas_size=settings["conditioning_resolution"],
                prevent_upscale=settings["prevent_upscale"],
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
                    f"prevent upscale {settings['prevent_upscale']}"
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
            gaussian = pipeline.decode_latent(latent["latent"], num_gaussians=settings["num_gaussians"])
            gaussian_count = int(gaussian.get_xyz.shape[0])
            if settings["num_gaussians"] in EXPERIMENTAL_GAUSSIAN_COUNTS:
                peak_detail = f"{gaussian_count:,} Gaussians decoded"
                if pipeline._device.type == "cuda" and torch.cuda.is_available():
                    peak_bytes = torch.cuda.max_memory_allocated(pipeline._device)
                    peak_detail += f" · CUDA peak allocated {peak_bytes / 1024**3:.2f} GiB"
                _emit(job, "decode", 90, "High-density decode completed", detail=peak_detail)
            _check_cancel(job)

            ply_path = object_root / "model.ply"
            splat_path = object_root / "model.splat"
            _emit(job, "serialize", 92, "Writing Gaussian PLY", detail=f"{gaussian_count:,} splats")
            gaussian.save_ply(ply_path)
            _check_cancel(job)
            ply_info = inspect_ply(ply_path)
            if ply_info.vertex_count != gaussian_count:
                raise RuntimeError(
                    f"serialized PLY contains {ply_info.vertex_count:,} splats; "
                    f"decoder reported {gaussian_count:,}"
                )
            ply_hash = _sha256_file(ply_path)
            _emit(
                job,
                "validate",
                94,
                "Validated Gaussian PLY",
                detail=(
                    f"{ply_info.vertex_count:,} splats · {ply_path.stat().st_size:,} bytes · "
                    f"sha256={ply_hash[:16]}"
                ),
            )
            _emit(job, "serialize", 96, "Writing compact SPLAT", detail=f"{gaussian_count:,} splats")
            gaussian.save_splat(splat_path)
            expected_splat_bytes = gaussian_count * 32
            if splat_path.stat().st_size != expected_splat_bytes:
                raise RuntimeError(
                    f"serialized SPLAT is {splat_path.stat().st_size:,} bytes; "
                    f"expected {expected_splat_bytes:,}"
                )
            splat_hash = _sha256_file(splat_path)
            _emit(
                job,
                "validate",
                97,
                "Validated compact SPLAT",
                detail=(
                    f"{gaussian_count:,} splats · {expected_splat_bytes:,} bytes · "
                    f"sha256={splat_hash[:16]}"
                ),
            )
            del gaussian, latent, conditioning

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
            "settings": {
                "steps": settings["steps"],
                "guidance_scale": settings["guidance_scale"],
                "num_gaussians": settings["num_gaussians"],
                "conditioning_resolution": settings["conditioning_resolution"],
                "effective_conditioning_resolution": prepared.width,
                "prevent_upscale": settings["prevent_upscale"],
                "erode_radius": settings["erode_radius"],
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
        if int(preview.get("revision", -1)) == int(value.get("revision", 0)):
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
        }
        item.pop("files", None)
    exports = value.get("exports")
    if isinstance(exports, dict) and exports.get("revision") is not None:
        exports["urls"] = {
            "ply": f"{API_BASE}/scenes/{scene_id}/exports/ply",
            "splat": f"{API_BASE}/scenes/{scene_id}/exports/splat",
        }
        exports.pop("files", None)
    return value


def update_scene(scene_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("scene update must be an object")
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        changed = False
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
        if not changed:
            return scene
        scene["exports"] = {}
        return _save_scene(scene)


def _scene_sources(scene: dict[str, Any], only_object_id: str = "") -> list[tuple[Path, Any]]:
    output = []
    for item in scene.get("objects", []):
        if only_object_id and item.get("object_id") != only_object_id:
            continue
        output.append((_object_file(scene["scene_id"], item, "ply"), item.get("transform")))
    if not output:
        raise ValueError("the scene contains no Gaussian objects")
    return output


def ensure_scene_exports(scene_id: str) -> dict[str, Any]:
    for attempt in range(2):
        with _STATE_LOCK:
            scene = load_scene(scene_id)
            revision = int(scene.get("revision", 0))
            existing = scene.get("exports", {})
            if (
                isinstance(existing, dict)
                and existing.get("revision") == revision
                and existing.get("format_version") == EXPORT_FORMAT_VERSION
            ):
                try:
                    ply = _object_file(scene_id, {"files": existing["files"]}, "ply")
                    splat = _object_file(scene_id, {"files": existing["files"]}, "splat")
                    return {"scene": scene, "ply": ply, "splat": splat}
                except (KeyError, FileNotFoundError):
                    pass
            sources = _scene_sources(scene)

        export_root = resolve_scene_dir(scene_id) / "exports"
        ply = export_root / f"scene-v{EXPORT_FORMAT_VERSION}-r{revision}.ply"
        splat = export_root / f"scene-v{EXPORT_FORMAT_VERSION}-r{revision}.splat"
        result = export_gaussian_scene(sources, ply, splat)
        relative_ply = str(ply.relative_to(resolve_scene_dir(scene_id)))
        relative_splat = str(splat.relative_to(resolve_scene_dir(scene_id)))
        with _STATE_LOCK:
            current = load_scene(scene_id)
            if int(current.get("revision", 0)) != revision:
                if attempt == 0:
                    continue
                raise RuntimeError("scene changed repeatedly while its combined model was being exported")
            current["exports"] = {
                "revision": revision,
                "format_version": EXPORT_FORMAT_VERSION,
                "created_at": _now(),
                "gaussians": result["ply"]["gaussians"],
                "objects": result["ply"]["objects"],
                "files": {"ply": relative_ply, "splat": relative_splat},
            }
            _save_scene(current, bump_revision=False)
            return {"scene": current, "ply": ply, "splat": splat}
    raise RuntimeError("scene export did not stabilize")


def _ensure_object_export(scene_id: str, object_id: str, format_name: str) -> Path:
    with _STATE_LOCK:
        scene = load_scene(scene_id)
        item = _object_by_id(scene, object_id)
        revision = int(scene.get("revision", 0))
        source = _object_file(scene_id, item, "ply")
        transform = item.get("transform")
    root = resolve_scene_dir(scene_id) / "exports" / "objects"
    ply = root / f"{object_id}-v{EXPORT_FORMAT_VERSION}-r{revision}.ply"
    splat = root / f"{object_id}-v{EXPORT_FORMAT_VERSION}-r{revision}.splat"
    target = ply if format_name == "ply" else splat
    if not target.is_file():
        export_gaussian_scene([(source, transform)], ply, splat if format_name == "splat" else None)
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
            if not _content_length_ok(request, MAX_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "preview upload is too large"}, status=413)
            scene_id = _validate_id(request.match_info["scene_id"], "scene id")
            load_scene(scene_id)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                raise ValueError("missing scene preview image")
            image_bytes = image_field.file.read(MAX_UPLOAD_BYTES + 1)
            scene = store_scene_preview(scene_id, image_bytes)
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
            if format_name not in {"ply", "splat"}:
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
            result = await asyncio.to_thread(ensure_scene_exports, scene_id)
            return web.json_response(_public_scene(result["scene"]))
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    @routes.get(f"{API_BASE}/scenes/{{scene_id}}/exports/{{format_name}}")
    async def factory_scene_export_download(request: Any) -> Any:
        try:
            format_name = request.match_info["format_name"]
            if format_name not in {"ply", "splat"}:
                raise FileNotFoundError("unknown export format")
            result = await asyncio.to_thread(ensure_scene_exports, request.match_info["scene_id"])
            path = result[format_name]
            return web.FileResponse(
                path,
                headers={"Content-Disposition": f'attachment; filename="{path.name}"'},
            )
        except FileNotFoundError as exc:
            return _json_error(web, exc, 404)
        except Exception as exc:
            return _json_error(web, exc)

    _REGISTERED = True


register_factory3d_routes = register_routes
