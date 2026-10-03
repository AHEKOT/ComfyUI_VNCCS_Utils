"""File-based job protocol between ComfyUI and an isolated motion worker.

Motion models pin their own torch / transformers / numpy versions, which break
ComfyUI's Python when installed into it. They run instead in a separate process
with its own environment: a venv next to this extension, or a Docker container.
ComfyUI and the worker share only a folder (``<ComfyUI>/models/text_to_motion``,
bind-mounted into the container) and talk through small JSON files in it:

    workers/<worker>.json             heartbeat: models it serves, state (every 2 s)
    jobs/<worker>/inbox/<job>.json    a request written by ComfyUI
    jobs/<worker>/processing/         the job the worker is running
    jobs/<worker>/status/<job>.json   progress written by the worker
    jobs/<worker>/outbox/<job>.json   the result (a SourceMotion) or an error

Every file is written to a temporary name and renamed, so a reader never sees half
a file. No network, no process spawning: ComfyUI keeps running its own flows while
the worker generates, and a broken model environment cannot affect ComfyUI.
Pure stdlib + numpy, so both sides import it.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path

import numpy as np

from .base import MotionRequest
from .transform import SourceMotion

PROTOCOL_VERSION = 1
HEARTBEAT_SECONDS = 2.0
HEARTBEAT_STALE_SECONDS = 15.0
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_MAX_FILE_BYTES = 256 * 1024 * 1024


def safe_name(value: str) -> str:
    text = str(value or "")
    if not _NAME_RE.match(text):
        raise ValueError(f"invalid worker or job name: {value!r}")
    return text


def write_json(path: Path, data) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    os.replace(temp, path)


def read_json(path: Path):
    path = Path(path)
    try:
        if path.stat().st_size > _MAX_FILE_BYTES:
            raise ValueError(f"{path.name} is too large")
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None


def job_dir(root: Path, worker: str, box: str) -> Path:
    return Path(root) / "jobs" / safe_name(worker) / box


# --- heartbeats -------------------------------------------------------------------

def heartbeat_path(root: Path, worker: str) -> Path:
    return Path(root) / "workers" / f"{safe_name(worker)}.json"


def write_heartbeat(root: Path, worker: str, models: list, **state) -> None:
    write_json(heartbeat_path(root, worker), {
        "protocol": PROTOCOL_VERSION, "worker": worker, "models": list(models),
        "updated_at": time.time(), **state,
    })


def live_workers(root: Path, now: float | None = None) -> list:
    """Heartbeats of workers that wrote one recently (newest first)."""
    now = time.time() if now is None else now
    folder = Path(root) / "workers"
    workers = []
    for path in sorted(folder.glob("*.json")) if folder.is_dir() else []:
        try:
            beat = read_json(path)
        except (OSError, ValueError):
            continue
        if not isinstance(beat, dict) or beat.get("protocol") != PROTOCOL_VERSION:
            continue
        if now - float(beat.get("updated_at") or 0) > HEARTBEAT_STALE_SECONDS:
            continue
        workers.append(beat)
    return sorted(workers, key=lambda beat: -float(beat["updated_at"]))


def worker_for(root: Path, model_id: str, now: float | None = None):
    """The live worker that serves ``model_id`` and reports it ready, else None."""
    for beat in live_workers(root, now):
        if model_id in (beat.get("models") or []):
            return beat
    return None


# --- payloads ---------------------------------------------------------------------

def _listify(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, dict):
        return {key: _listify(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_listify(item) for item in value]
    return value


def request_to_dict(request: MotionRequest) -> dict:
    return {
        "prompt": request.prompt, "duration": request.duration, "seed": request.seed,
        "steps": request.steps, "guidance": request.guidance, "use_start_pose": request.use_start_pose,
        "keypoints": _listify(request.keypoints), "rest_keypoints": _listify(request.rest_keypoints),
        "head_axes": _listify(request.head_axes), "characters": request.characters,
    }


def request_from_dict(data: dict) -> MotionRequest:
    points = lambda raw: {str(k): np.asarray(v, dtype=np.float64) for k, v in (raw or {}).items()}
    head = data.get("head_axes")
    return MotionRequest(
        prompt=str(data["prompt"]), duration=float(data["duration"]), seed=int(data["seed"]),
        steps=None if data.get("steps") is None else int(data["steps"]),
        guidance=None if data.get("guidance") is None else float(data["guidance"]),
        use_start_pose=bool(data.get("use_start_pose", True)),
        keypoints=points(data.get("keypoints")), rest_keypoints=points(data.get("rest_keypoints")),
        head_axes=None if head is None else {k: np.asarray(v, dtype=np.float64) for k, v in head.items()},
        characters=int(data.get("characters") or 1),
    )


def motion_to_dict(motion: SourceMotion) -> dict:
    return {
        "fps": float(motion.fps), "joint_names": list(motion.joint_names),
        "positions": np.asarray(motion.positions, dtype=np.float32).tolist(),
        "rotations": None if motion.rotations is None else np.asarray(motion.rotations, dtype=np.float32).tolist(),
        "joint_map": dict(motion.joint_map), "rotation_map": dict(motion.rotation_map),
        "hips": list(motion.hips), "legs": [list(leg) for leg in motion.legs], "root": motion.root,
    }


def motion_from_dict(data: dict) -> SourceMotion:
    positions = np.asarray(data["positions"], dtype=np.float64)
    names = [str(name) for name in data["joint_names"]]
    if positions.ndim != 3 or positions.shape[1:] != (len(names), 3):
        raise ValueError("the worker returned a motion of unexpected shape")
    rotations = data.get("rotations")
    rotations = None if rotations is None else np.asarray(rotations, dtype=np.float64)
    if rotations is not None and rotations.shape != positions.shape[:2] + (3, 3):
        rotations = None
    return SourceMotion(
        fps=float(data["fps"]), joint_names=names, positions=positions, rotations=rotations,
        joint_map={str(k): str(v) for k, v in data["joint_map"].items()},
        rotation_map={str(k): str(v) for k, v in data["rotation_map"].items()},
        hips=tuple(data["hips"]), legs=tuple(tuple(leg) for leg in data["legs"]), root=str(data["root"]),
    )


# --- ComfyUI side -----------------------------------------------------------------

class WorkerError(RuntimeError):
    def __init__(self, message: str, hint: str = "", unavailable: bool = False):
        super().__init__(message)
        self.hint = hint
        self.unavailable = unavailable


def run_job(root: Path, worker: str, model_id: str, request: MotionRequest, report,
            timeout: float = 30 * 60, poll: float = 0.25, sleep=time.sleep) -> SourceMotion:
    """Hand one generation to a worker and wait for it (call from a background thread)."""
    job = uuid.uuid4().hex
    write_json(job_dir(root, worker, "inbox") / f"{job}.json",
               {"protocol": PROTOCOL_VERSION, "id": job, "model": model_id, "request": request_to_dict(request)})
    status_path = job_dir(root, worker, "status") / f"{job}.json"
    result_path = job_dir(root, worker, "outbox") / f"{job}.json"
    deadline = time.time() + timeout
    try:
        while True:
            result = read_json(result_path)
            if result is not None:
                if not result.get("ok"):
                    raise WorkerError(str(result.get("error") or "the worker failed"),
                                      str(result.get("hint") or ""), bool(result.get("unavailable")))
                return motion_from_dict(result["motion"])
            status = read_json(status_path)
            if isinstance(status, dict) and status.get("message"):
                report(str(status["message"]), float(status.get("progress") or 0))
            if not any(beat.get("worker") == worker for beat in live_workers(root)):
                raise WorkerError(f"The motion worker '{worker}' stopped while generating.")
            if time.time() > deadline:
                raise WorkerError("The motion worker did not answer in time.")
            sleep(poll)
    finally:
        for path in (job_dir(root, worker, "inbox") / f"{job}.json", status_path, result_path):
            try:
                path.unlink()
            except OSError:
                pass
