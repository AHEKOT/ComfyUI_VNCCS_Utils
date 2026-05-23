"""Small in-memory progress tracker for Pose Studio SAM3D imports."""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar

_TASKS: dict[str, dict] = {}
_LOCK = threading.Lock()
_CURRENT_TASK_ID: ContextVar[str | None] = ContextVar("vnccs_sam3d_task_id", default=None)
_DOWNLOAD_PHASE: ContextVar[tuple[str, int, int]] = ContextVar(
    "vnccs_sam3d_download_phase",
    default=("Downloading model files...", 8, 28),
)
_MAX_TASK_AGE_SECONDS = 60 * 60


def _clamp_progress(value) -> int:
    try:
        number = int(round(float(value)))
    except Exception:
        number = 0
    return max(0, min(100, number))


def _cleanup_locked(now: float) -> None:
    stale = [
        task_id for task_id, task in _TASKS.items()
        if now - float(task.get("updated_at", 0.0)) > _MAX_TASK_AGE_SECONDS
    ]
    for task_id in stale:
        _TASKS.pop(task_id, None)


def start_task(task_id: str | None) -> str | None:
    if not task_id:
        return None
    now = time.time()
    with _LOCK:
        _cleanup_locked(now)
        _TASKS[str(task_id)] = {
            "status": "running",
            "message": "Preparing SAM 3D Body import...",
            "progress": 1,
            "updated_at": now,
        }
    return str(task_id)


@contextmanager
def task_context(task_id: str | None):
    token = _CURRENT_TASK_ID.set(str(task_id) if task_id else None)
    try:
        yield
    finally:
        _CURRENT_TASK_ID.reset(token)


@contextmanager
def download_phase(message: str, base: int, weight: int):
    token = _DOWNLOAD_PHASE.set((str(message), int(base), int(weight)))
    try:
        yield
    finally:
        _DOWNLOAD_PHASE.reset(token)


def update(message: str, progress: int | float | None = None, *, status: str = "running") -> None:
    task_id = _CURRENT_TASK_ID.get()
    if not task_id:
        return
    now = time.time()
    with _LOCK:
        task = _TASKS.setdefault(task_id, {})
        task["status"] = status
        task["message"] = str(message)
        if progress is not None:
            task["progress"] = _clamp_progress(progress)
        task["updated_at"] = now


def finish(message: str = "Done.") -> None:
    update(message, 100, status="complete")


def fail(message: str) -> None:
    update(message, None, status="error")


def get_task(task_id: str) -> dict:
    with _LOCK:
        task = dict(_TASKS.get(str(task_id), {}))
    if not task:
        return {
            "status": "unknown",
            "message": "Waiting for SAM 3D Body import...",
            "progress": 0,
        }
    return {
        "status": task.get("status", "running"),
        "message": task.get("message", ""),
        "progress": _clamp_progress(task.get("progress", 0)),
    }


_TqdmBase = object


class SnapshotDownloadTqdm(_TqdmBase):
    """Best-effort tqdm-compatible hook for HuggingFace downloads."""

    def __init__(self, *args, **kwargs):
        self.phase_base = kwargs.pop("vnccs_phase_base", None)
        self.phase_weight = kwargs.pop("vnccs_phase_weight", None)
        if _TqdmBase is object:
            self.iterable = args[0] if args else None
            self.total = kwargs.get("total")
            self.n = kwargs.get("initial", 0) or 0
        else:
            super().__init__(*args, **kwargs)

    def __enter__(self):
        if _TqdmBase is object:
            return self
        return super().__enter__()

    def __exit__(self, *_args):
        if _TqdmBase is object:
            self.close()
            return False
        return super().__exit__(*_args)

    def __iter__(self):
        if _TqdmBase is object:
            if self.iterable is None:
                return iter(())
            return iter(self.iterable)
        return super().__iter__()

    @classmethod
    def get_lock(cls):
        if _TqdmBase is object:
            return _LOCK
        return super().get_lock()

    @classmethod
    def set_lock(cls, lock):
        if _TqdmBase is object:
            return None
        return super().set_lock(lock)

    def update(self, n=1):
        if _TqdmBase is object:
            self.n += n
            result = None
        else:
            result = super().update(n)
        if self.total:
            message, default_base, default_weight = _DOWNLOAD_PHASE.get()
            base = default_base if self.phase_base is None else self.phase_base
            weight = default_weight if self.phase_weight is None else self.phase_weight
            update(message, base + weight * min(1.0, self.n / self.total))
        return result

    def close(self):
        if _TqdmBase is not object:
            return super().close()
        return None
