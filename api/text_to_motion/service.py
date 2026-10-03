"""HTTP service for Pose Studio text-to-motion.

Model code and weights are optional and loaded lazily on the first generation;
a missing install is reported to the browser with the model's install hint.

Routes (registered by ``register_routes``):
    GET  /vnccs/pose_studio/motion/models        models from config/motion_models
    POST /vnccs/pose_studio/motion/generate      prompt + start pose -> motion frames
    GET  /vnccs/pose_studio/motion/status/{id}  progress of a running generation
    POST /vnccs/pose_studio/motion/unload        free the loaded model
    GET  /vnccs/pose_studio/motion/setup/policy  ComfyUI-Manager pip/git install policy (read-only)
    POST /vnccs/pose_studio/motion/setup/download run a model's "download" setup step
"""

from __future__ import annotations

import asyncio
import random
import re
import sys
import threading
import time

from . import manager_policy, registry, worker_protocol
from .base import BackendUnavailable, MotionRequest
from .transform import align_to_start_pose, motion_to_pose_studio, parse_keypoints


ROUTE_PREFIX = "/vnccs/pose_studio/motion"
MAX_PROMPT_CHARS = 400
MAX_SEED = 2**31 - 1
MAX_REQUEST_BYTES = 1024 * 1024

_SAFE_TASK_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")
_TASK_MAX_AGE_SECONDS = 60 * 60


# --- progress -------------------------------------------------------------------

_TASKS: dict = {}
_TASKS_LOCK = threading.Lock()


def _task_id(value) -> str:
    return _SAFE_TASK_ID_RE.sub("", str(value or ""))[:128]


def set_task(task_id: str, status: str, message: str, progress: float) -> None:
    if not task_id:
        return
    now = time.time()
    with _TASKS_LOCK:
        for stale in [key for key, task in _TASKS.items() if now - task["updated_at"] > _TASK_MAX_AGE_SECONDS]:
            _TASKS.pop(stale, None)
        _TASKS[task_id] = {
            "status": status,
            "message": message,
            "progress": max(0, min(100, int(round(progress)))),
            "updated_at": now,
        }


def get_task(task_id: str) -> dict:
    with _TASKS_LOCK:
        task = _TASKS.get(_task_id(task_id))
        if task is None:
            return {"status": "unknown", "message": "", "progress": 0}
        return {key: value for key, value in task.items() if key != "updated_at"}


# --- models ---------------------------------------------------------------------

_SPECS: dict | None = None


def specs() -> dict:
    global _SPECS
    if _SPECS is None:
        _SPECS = registry.load_specs()
    return _SPECS


def default_model_id() -> str:
    return next(iter(specs()), "")


def make_backend(spec):
    return registry.backend_class(spec.backend)(spec, registry.default_models_dir())


def list_models() -> list:
    models = []
    for spec in specs().values():
        entry = spec.public()
        backend = make_backend(spec)
        try:
            entry["setup"] = backend.setup_status()
        except Exception:
            entry["setup"] = [{**step, "done": None} for step in spec.setup]
        worker = _worker_for(spec.id)
        problem = _worker_problem(spec.id) if worker is None else None
        for step in entry["setup"]:
            if step.get("check") == "worker":
                step["done"] = worker is not None
                if problem:
                    step["detail"] = f"{problem}\n\n{step.get('detail', '')}".strip()
        if worker is not None:
            entry.update(available=True, unavailable_reason="", install_hint="", runner="worker",
                         worker=str(worker.get("worker") or ""))
            models.append(entry)
            continue
        entry["runner"] = "comfyui"
        try:
            backend.check_available()
            entry.update(available=True, unavailable_reason="", install_hint="")
        except BackendUnavailable as exc:
            entry.update(available=False, unavailable_reason=str(exc), install_hint=exc.hint)
        except Exception as exc:
            entry.update(available=False, unavailable_reason=str(exc), install_hint="")
        models.append(entry)
    return models


# --- request validation ---------------------------------------------------------

def _number(value, default, low, high, cast=float):
    try:
        number = cast(value)
    except (TypeError, ValueError, OverflowError):
        return default
    if isinstance(number, float) and number != number:
        return default
    return max(low, min(high, number))


def parse_generation_request(data):
    """Validate the browser request; returns ``(model spec, MotionRequest, task id)``."""
    if not isinstance(data, dict):
        raise ValueError("request body must be a JSON object")
    model_id = str(data.get("model") or default_model_id())
    spec = specs().get(model_id)
    if spec is None:
        raise ValueError(f"unknown text-to-motion model: {model_id}")
    caps = spec.capabilities

    prompt = " ".join(str(data.get("prompt") or "").split())
    if not prompt:
        raise ValueError("describe the motion in the prompt")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError(f"prompt is longer than {MAX_PROMPT_CHARS} characters")

    seed_value = data.get("seed")
    if seed_value is None or seed_value == "" or int(_number(seed_value, -1, -1, MAX_SEED, int)) < 0:
        seed = random.randint(0, MAX_SEED)
    else:
        seed = int(_number(seed_value, 0, 0, MAX_SEED, int))

    keypoints = parse_keypoints(data.get("keypoints") or {})
    if not keypoints:
        raise ValueError("the current pose landmarks are missing")
    rest_keypoints = parse_keypoints(data.get("rest_keypoints") or {})

    head_axes = None
    raw_head = data.get("head_axes")
    if isinstance(raw_head, dict):
        axes = parse_keypoints({key: raw_head.get(key) for key in ("up", "forward") if raw_head.get(key) is not None})
        if len(axes) == 2:
            head_axes = axes

    characters = int(_number(data.get("characters"), 1, 1, 8, int))
    if characters > caps["max_characters"]:
        raise ValueError(
            f"{spec.name} generates the motion of one character at a time"
            if caps["max_characters"] == 1
            else f"{spec.name} handles at most {caps['max_characters']} characters"
        )

    duration = caps["duration"]
    steps = caps.get("steps")
    guidance = caps.get("guidance")
    request = MotionRequest(
        prompt=prompt,
        duration=float(_number(data.get("duration"), duration["default"], duration["min"], duration["max"])),
        seed=seed,
        steps=None if steps is None else int(_number(
            data.get("steps", data.get("diffusion_steps")), steps["default"], steps["min"], steps["max"], int,
        )),
        guidance=None if guidance is None else float(_number(
            data.get("guidance"), guidance["default"], guidance["min"], guidance["max"],
        )),
        use_start_pose=bool(data.get("use_start_pose", True)),
        characters=characters,
        keypoints=keypoints,
        rest_keypoints=rest_keypoints,
        head_axes=head_axes,
    )
    return spec, request, _task_id(data.get("task_id"))


# --- generation -----------------------------------------------------------------

_MODEL_LOCK = threading.Lock()
_LOADED: dict = {"id": None, "backend": None}


def _model_operation_lock():
    """UniCanvas' process-wide model lock when it is loaded, else our own lock.

    Motion models run outside ComfyUI's prompt queue like UniCanvas and 3D Factory,
    so one editor must not unload or move weights while another is sampling.
    """
    package = __package__ or ""
    suffix = ".api.text_to_motion"
    root = package[: -len(suffix)] if package.endswith(suffix) else ""
    module = sys.modules.get(f"{root}.nodes.unicanvas") if root else None
    lock = getattr(module, "_COMFY_MODEL_OP_LOCK", None)
    return lock if hasattr(lock, "acquire") and hasattr(lock, "release") else _MODEL_LOCK


def _worker_for(model_id: str):
    try:
        return worker_protocol.worker_for(registry.default_models_dir(), model_id)
    except (OSError, ValueError):
        return None


def _worker_problem(model_id: str):
    """Why a running worker that was asked to serve ``model_id`` cannot (shown in the card)."""
    try:
        beats = worker_protocol.live_workers(registry.default_models_dir())
    except (OSError, ValueError):
        return None
    for beat in beats:
        info = (beat.get("unavailable") or {}).get(model_id)
        if isinstance(info, dict) and info.get("reason"):
            return f"The worker '{beat.get('worker')}' is running but cannot use this model: {info['reason']}"
    return None


def unload_model() -> bool:
    backend = _LOADED.get("backend")
    _LOADED.update(id=None, backend=None)
    if backend is None:
        return False
    backend.unload()
    return True


def _backend_for(spec, report):
    if _LOADED["backend"] is not None and _LOADED["id"] == spec.id:
        return _LOADED["backend"]
    unload_model()
    backend = make_backend(spec)
    backend.check_available()
    backend.load(report)
    _LOADED.update(id=spec.id, backend=backend)
    return backend


def generate_motion(spec, request: MotionRequest, task_id: str = "") -> dict:
    """Run the model synchronously (call from a worker thread)."""

    def report(message, progress):
        set_task(task_id, "running", message, progress)

    worker = _worker_for(spec.id)
    if worker is not None:
        # Isolated worker: no ComfyUI lock and no VRAM eviction, other flows keep running.
        report(f"Sending the job to the motion worker '{worker['worker']}'...", 2)
        try:
            source = worker_protocol.run_job(registry.default_models_dir(), worker["worker"], spec.id, request, report)
        except worker_protocol.WorkerError as exc:
            if exc.unavailable:
                raise BackendUnavailable(str(exc), exc.hint) from exc
            raise RuntimeError(str(exc)) from exc
    else:
        with _model_operation_lock():
            report(f"Preparing {spec.name}...", 2)
            backend = _backend_for(spec, report)
            source = backend.generate(request, report)

    report("Mapping the motion onto Pose Studio...", 97)
    motion = motion_to_pose_studio(source, align_to_start_pose(source, request.keypoints))
    motion.update(
        seed=request.seed,
        prompt=request.prompt,
        model=spec.id,
        duration=request.duration,
        use_start_pose=request.use_start_pose,
        start_pose_constraint=bool(request.use_start_pose and spec.capabilities["start_pose_constraint"]),
    )
    return motion


# --- routes ---------------------------------------------------------------------

def _content_length_ok(request, max_bytes) -> bool:
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        return int(raw_length) <= int(max_bytes)
    except Exception:
        return False


async def handle_models(request):
    from aiohttp import web

    models = await asyncio.to_thread(list_models)
    return web.json_response({"models": models, "default": default_model_id()})


async def handle_generate(request):
    from aiohttp import web

    if not _content_length_ok(request, MAX_REQUEST_BYTES):
        return web.json_response({"error": "request is too large"}, status=413)
    try:
        spec, generation, task_id = parse_generation_request(await request.json())
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception:
        return web.json_response({"error": "request body must be valid JSON"}, status=400)

    set_task(task_id, "running", "Waiting for the motion model...", 1)
    try:
        motion = await asyncio.to_thread(generate_motion, spec, generation, task_id)
    except BackendUnavailable as exc:
        set_task(task_id, "error", str(exc), 100)
        return web.json_response(
            {"error": str(exc), "install_hint": exc.hint, "model_missing": True}, status=503,
        )
    except ValueError as exc:
        set_task(task_id, "error", str(exc), 100)
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        import traceback

        traceback.print_exc()
        set_task(task_id, "error", str(exc), 100)
        return web.json_response({"error": f"{spec.name} generation failed: {exc}"}, status=500)

    set_task(task_id, "done", "Motion ready.", 100)
    return web.json_response({"status": "success", "motion": motion})


async def handle_status(request):
    from aiohttp import web

    return web.json_response(get_task(request.match_info.get("task_id", "")))


async def handle_unload(request):
    from aiohttp import web

    def unload():
        with _model_operation_lock():
            return unload_model()

    return web.json_response({"status": "success", "unloaded": await asyncio.to_thread(unload)})


def _same_origin_request(request) -> bool:
    """State-changing setup calls must come from this ComfyUI page (our marker header, not cross-site)."""
    if request.headers.get("X-VNCCS-CSRF") != "1":
        return False
    if (request.headers.get("Sec-Fetch-Site") or "").lower() == "cross-site":
        return False
    origin = request.headers.get("Origin")
    if origin:
        host = (request.headers.get("Host") or "").lower()
        netloc = origin.split("://", 1)[-1].split("/", 1)[0].lower()
        if host and netloc != host:
            return False
    return True


async def handle_setup_policy(request):
    from aiohttp import web

    try:
        return web.json_response(await asyncio.to_thread(manager_policy.install_policy))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


def run_setup_download(spec, step_id: str, task_id: str) -> None:
    step = next((s for s in spec.setup if s["id"] == step_id and s["kind"] == "download"), None)
    if step is None:
        raise ValueError(f"{spec.name} has no download step {step_id!r}")
    with _model_operation_lock():
        make_backend(spec).run_download(step, lambda message, progress: set_task(task_id, "running", message, progress))


async def handle_setup_download(request):
    from aiohttp import web

    if not _same_origin_request(request):
        return web.json_response({"error": "request rejected"}, status=403)
    if not _content_length_ok(request, 4096):
        return web.json_response({"error": "request is too large"}, status=413)
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "request body must be valid JSON"}, status=400)
    if not isinstance(data, dict):
        return web.json_response({"error": "request body must be a JSON object"}, status=400)
    spec = specs().get(str(data.get("model") or ""))
    if spec is None:
        return web.json_response({"error": "unknown model"}, status=400)
    task_id = _task_id(data.get("task_id"))
    set_task(task_id, "running", "Starting the download...", 1)
    try:
        await asyncio.to_thread(run_setup_download, spec, str(data.get("step") or ""), task_id)
    except ValueError as exc:
        set_task(task_id, "error", str(exc), 100)
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        set_task(task_id, "error", str(exc), 100)
        return web.json_response({"error": f"Download failed: {exc}"}, status=500)
    set_task(task_id, "done", "Downloaded.", 100)
    return web.json_response({"status": "success"})


def register_routes(routes) -> None:
    routes.get(f"{ROUTE_PREFIX}/models")(handle_models)
    routes.post(f"{ROUTE_PREFIX}/generate")(handle_generate)
    routes.get(f"{ROUTE_PREFIX}/status/{{task_id}}")(handle_status)
    routes.post(f"{ROUTE_PREFIX}/unload")(handle_unload)
    routes.get(f"{ROUTE_PREFIX}/setup/policy")(handle_setup_policy)
    routes.post(f"{ROUTE_PREFIX}/setup/download")(handle_setup_download)
