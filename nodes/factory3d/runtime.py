"""Factory generation jobs, model setup and execution."""
from __future__ import annotations
import asyncio
import gc
import os
import secrets
import shutil
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable
from PIL import Image, ImageOps
from . import generation as factory3d_generation
from .gaussian_scene import inspect_ply, normalize_transform, validate_ply_payload
from .schema import normalize_object_editor_properties

from . import storage as backend
from .state import _STATE_LOCK, _JOBS

_INFERENCE_LOCK = threading.RLock()

_PIPELINE: Any = None

_PIPELINE_SIGNATURE: tuple[Any, ...] | None = None

_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()


class JobCancelled(RuntimeError):
    pass


def _model_operation_lock() -> Any:
    """Use UniCanvas' process-wide model lock when that reference is loaded.

    Both editors execute model code outside ComfyUI's normal prompt queue. A
    shared lock prevents one editor from moving or releasing weights while the
    other is sampling. Tests and standalone imports fall back to Factory's own
    lock without importing the full UniCanvas node.
    """
    package_root = (__package__ or "").rsplit(".", 2)[0]
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


def _weight_candidates(relative: str) -> list[Path]:
    root = backend._model_root()
    relative_path = Path(relative)
    candidates = [root / relative_path]
    category = relative_path.parts[0]
    filename = Path(*relative_path.parts[1:])
    candidates.extend(path / filename for path in backend._category_roots(category))
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
    for relative in backend._WEIGHT_FILES:
        candidates = _weight_candidates(relative)
        output[relative] = next((path for path in candidates if _valid_weight(path)), candidates[0])
    return output


def _provider_weight_files(provider: Any) -> tuple[str, ...]:
    key = factory3d_generation.normalize_provider(provider)
    if key == factory3d_generation.TRIPOSPLAT:
        return backend._WEIGHT_FILES
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
                "repository": spec.get("repo_id", backend.UPSTREAM_REPOSITORY),
                "revision": spec.get("revision", backend.UPSTREAM_HF_REVISION),
            }
        )
    repositories = sorted({str(item["repository"]) for item in files})
    return {
        "ready": ready,
        "root": str(backend._model_root()),
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
        "schema_version": backend.SCHEMA_VERSION,
        "backend": "TripoSplat",
        "backend_repository": "https://github.com/VAST-AI-Research/TripoSplat",
        "backend_commit": backend.UPSTREAM_COMMIT,
        "formats": ["ply", "glb"],
        "generators": generators,
        "import_formats": ["glb", "gltf", "fbx", "obj", "stl", "ply", "zip"],
        "model_texture_formats": ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tga"],
        "gaussian_counts": list(backend.GAUSSIAN_COUNTS),
        "experimental_gaussian_counts": list(backend.EXPERIMENTAL_GAUSSIAN_COUNTS),
        "conditioning_resolutions": list(backend.CONDITIONING_RESOLUTIONS),
        "experimental_conditioning_resolutions": list(backend.EXPERIMENTAL_CONDITIONING_RESOLUTIONS),
        "scene_render": {
            "min_side": 64,
            "max_side": 4096,
            "max_cameras": backend.MAX_SCENE_CAMERAS,
            "aspect_presets": sorted(backend._ASPECT_PRESETS),
            "defaults": dict(backend._DEFAULT_RENDER_SETTINGS),
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
        "splat_cache": backend.splat_cache_status(),
    }


def _job_log_path(job: dict[str, Any]) -> Path:
    scene_id = job.get("scene_id")
    if isinstance(scene_id, str) and backend._ID_RE.fullmatch(scene_id):
        root = backend.resolve_scene_dir(scene_id)
    else:
        root = backend._factory_root()
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
    timestamp = backend._now()
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
        if len(logs) > backend.MAX_JOB_LOG_LINES:
            del logs[: len(logs) - backend.MAX_JOB_LOG_LINES]
    elapsed = max(0.0, timestamp - float(job.get("created_at", timestamp)))
    line = (
        f"[VNCCS 3D Factory][{job['job_id'][:8]}]"
        f"[{percent:6.1f}%][{elapsed:8.1f}s][{stage}] {message}"
        + (f" — {detail}" if detail else "")
    )
    getattr(backend.LOGGER, level if hasattr(backend.LOGGER, level) else "info")(line)
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
        backend.LOGGER.exception("Could not persist Factory job log")


def _new_job(kind: str, scene_id: str = "") -> dict[str, Any]:
    with _STATE_LOCK:
        active = sum(job.get("status") in {"queued", "running"} for job in _JOBS.values())
        if active >= backend.MAX_ACTIVE_JOBS:
            raise RuntimeError("3D Factory job capacity is full; wait for the active job to finish")
        job_id = backend._new_id()
        timestamp = backend._now()
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
    root = backend._model_root()
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
            repo_id=str(spec["repo_id"]) if spec else backend.UPSTREAM_REPOSITORY,
            filename=str(spec["filename"]) if spec else relative,
            local_dir=str(root),
            revision=str(spec["revision"]) if spec else backend.UPSTREAM_HF_REVISION,
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

    from ...data.triposplat import triposplat as engine

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


def _generate_object(
    job: dict[str, Any],
    image_bytes: bytes,
    object_id: str,
    object_name: str,
    settings: dict[str, Any],
) -> dict[str, Any]:
    import torch

    scene_id = job["scene_id"]
    scene_root = backend.resolve_scene_dir(scene_id)
    object_root = scene_root / "objects" / object_id
    object_root.mkdir(parents=True, exist_ok=False)
    try:
        _emit(job, "input", 2, "Validating reference image")
        image = backend._decode_image(image_bytes)
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
            if settings["conditioning_resolution"] in backend.EXPERIMENTAL_CONDITIONING_RESOLUTIONS:
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

            if settings["num_gaussians"] in backend.EXPERIMENTAL_GAUSSIAN_COUNTS:
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
            if settings["num_gaussians"] in backend.EXPERIMENTAL_GAUSSIAN_COUNTS:
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
            ply_hash = backend._sha256_file(ply_path)
            backend._remember_ply_sha256(ply_path, ply_hash)
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
            "created_at": backend._now(),
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
            scene = backend.load_scene(scene_id)
            item["level_id"] = scene["levels"][0]["level_id"]
            item["building_id"] = (
                scene["architecture"]["buildings"][0]["building_id"]
                if scene["architecture"]["buildings"] else ""
            )
            scene["objects"].append(item)
            scene["layers"].append({"type": "object", "object_id": object_id})
            scene["exports"] = {}
            backend._save_scene(scene)
        return {
            "scene_id": scene_id,
            "object_id": object_id,
            "scene_revision": scene["revision"],
            # Embed the committed manifest in the terminal job response. The
            # frontend can hydrate it immediately even if another modal was
            # open when generation finished, without a second scene request.
            "scene": backend._public_scene(scene),
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

    scene_root = backend.resolve_scene_dir(scene_id)
    object_root = scene_root / "objects" / object_id
    model_root = object_root / "model"
    object_root.mkdir(parents=True, exist_ok=False)
    model_root.mkdir(parents=True, exist_ok=False)
    try:
        _emit(job, "input", 2, "Validating reference image")
        image = backend._decode_image(image_bytes)
        reference_path = object_root / "reference.png"
        prepared_path = object_root / "prepared.png"
        model_path = model_root / "model.glb"
        image.save(reference_path, format="PNG")

        thumbnail = ImageOps.exif_transpose(image).convert("RGB")
        thumbnail.thumbnail(backend.OBJECT_THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
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
        item = backend._standard_model_item(
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
            scene = backend.load_scene(scene_id)
            item["level_id"] = scene["levels"][0]["level_id"]
            item["building_id"] = (
                scene["architecture"]["buildings"][0]["building_id"]
                if scene["architecture"]["buildings"] else ""
            )
            scene["objects"].append(item)
            scene["layers"].append({"type": "object", "object_id": object_id})
            scene["exports"] = {}
            backend._save_scene(scene)
        return {
            "scene_id": scene_id,
            "object_id": object_id,
            "scene_revision": scene["revision"],
            "provider": provider,
            "scene": backend._public_scene(scene),
        }
    except Exception:
        shutil.rmtree(object_root, ignore_errors=True)
        raise
