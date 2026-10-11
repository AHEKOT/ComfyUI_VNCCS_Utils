"""In-memory draw progress and draw result stores polled by the frontend."""

from __future__ import annotations

import json
import threading
import time
from typing import Any


_DRAW_PROGRESS: dict[str, dict[str, Any]] = {}
_DRAW_PROGRESS_LOCK = threading.Lock()
_DRAW_PROGRESS_MAX = 256
_DRAW_PROGRESS_TTL_SECONDS = 60 * 60
_DRAW_PROGRESS_RUNNING_TTL_SECONDS = 24 * 60 * 60


def _prune_draw_progress(now: float | None = None) -> None:
    now = time.time() if now is None else now
    expired = []
    for draw_id, state in _DRAW_PROGRESS.items():
        age = max(0.0, now - float(state.get("updated_at", now)))
        stage = state.get("stage")
        if (stage in {"complete", "error", "cancelled"} and age > _DRAW_PROGRESS_TTL_SECONDS) or age > _DRAW_PROGRESS_RUNNING_TTL_SECONDS:
            expired.append(draw_id)
    for draw_id in expired:
        _DRAW_PROGRESS.pop(draw_id, None)
    if len(_DRAW_PROGRESS) <= _DRAW_PROGRESS_MAX:
        return
    ordered = sorted(
        _DRAW_PROGRESS.items(),
        key=lambda item: (item[1].get("stage") not in {"complete", "error"}, float(item[1].get("updated_at", 0))),
    )
    for draw_id, _ in ordered[:len(_DRAW_PROGRESS) - _DRAW_PROGRESS_MAX]:
        _DRAW_PROGRESS.pop(draw_id, None)


# Console timing per draw: [draw start, last sampling tick, last printed (stage, message)].
_DRAW_TIMING: dict[str, list[Any]] = {}


def _console_progress(draw_id: str, stage: str, step: int, steps: int, message: str) -> str:
    """Print one console line per stage change and per sampling step; returns the speed suffix."""
    now = time.perf_counter()
    with _DRAW_PROGRESS_LOCK:
        timing = _DRAW_TIMING.setdefault(draw_id, [now, None, None])
        started, last_tick, last_line = timing
        speed = ""
        if stage == "sampling" and steps and step:
            dt = now - (last_tick if last_tick is not None else started)
            timing[1] = now
            if dt > 0:
                speed = f" - {dt:.2f} s/it" if dt >= 1 else f" - {1 / dt:.2f} it/s"
            line = f"Sampling {step}/{steps}{speed}"
        else:
            if stage == "sampling":
                timing[1] = now  # step 0: the first step is timed from here
            line = message
        if line == last_line:
            return speed
        timing[2] = line
        elapsed = now - started
        if stage in {"complete", "error", "cancelled"}:
            _DRAW_TIMING.pop(draw_id, None)
        if len(_DRAW_TIMING) > _DRAW_PROGRESS_MAX:
            _DRAW_TIMING.pop(next(iter(_DRAW_TIMING)), None)
    print(f"[VNCCS UniCanvas] {line} ({elapsed:.1f}s)", flush=True)
    return speed


_TERMINAL_STAGES = frozenset({"complete", "error", "cancelled"})


def interrupt_types() -> tuple[type, ...]:
    """ComfyUI's InterruptProcessingException (what an interrupt raises), or nothing without ComfyUI."""
    try:
        from comfy.model_management import InterruptProcessingException
    except Exception:
        return ()
    return (InterruptProcessingException,)


def set_interrupt(value: bool) -> None:
    """Raise or clear ComfyUI's interrupt flag (the same one POST /interrupt sets)."""
    try:
        import comfy.model_management as model_management

        model_management.interrupt_current_processing(value)
    except Exception:
        pass


def _raise_if_interrupted() -> None:
    try:
        import comfy.model_management as model_management
    except Exception:
        return
    check = getattr(model_management, "throw_exception_if_processing_interrupted", None)  # stubs and old ComfyUI lack it
    if callable(check):
        check()


def _set_draw_progress(draw_id: str, stage: str, progress: float, step: int = 0, steps: int = 0, message: str | None = None, *, cancel_before_start: bool = False) -> None:
    # Every step and stage change is a checkpoint: a Stop (ComfyUI's interrupt flag) ends the draw here.
    if stage not in _TERMINAL_STAGES:
        _raise_if_interrupted()
    message = message or stage
    speed = _console_progress(draw_id, stage, int(step or 0), int(steps or 0), message)
    payload = {
        "draw_id": draw_id,
        "stage": stage,
        "progress": max(0.0, min(1.0, float(progress))),
        "step": max(0, int(step or 0)),
        "steps": max(0, int(steps or 0)),
        "message": message + speed if stage == "sampling" and step else message,
        "updated_at": time.time(),
    }
    if cancel_before_start:
        payload["cancel_before_start"] = True
    with _DRAW_PROGRESS_LOCK:
        _DRAW_PROGRESS[draw_id] = payload
        _prune_draw_progress()


def consume_draw_cancellation(draw_id: str) -> bool:
    with _DRAW_PROGRESS_LOCK:
        state = _DRAW_PROGRESS.get(draw_id)
        return bool(state and state.pop("cancel_before_start", False))


def _get_draw_progress(draw_id: str) -> dict[str, Any]:
    with _DRAW_PROGRESS_LOCK:
        _prune_draw_progress()
        return dict(_DRAW_PROGRESS.get(draw_id) or {
            "draw_id": draw_id,
            "stage": "unknown",
            "progress": 0,
            "step": 0,
            "steps": 0,
            "message": "Waiting",
            "updated_at": time.time(),
        })


_DRAW_RESULTS: dict[str, dict[str, Any]] = {}
_DRAW_RESULTS_LOCK = threading.Lock()
_DRAW_RESULTS_TTL_SECONDS = 60 * 60
_DRAW_RESULTS_MAX = 256
_DRAW_RESULTS_MAX_BYTES = 128 * 1024 * 1024


def _prune_draw_results(now: float | None = None) -> None:
    # Caller must hold _DRAW_RESULTS_LOCK (same contract as _prune_draw_progress).
    now = time.time() if now is None else now
    expired = []
    for draw_id, result in _DRAW_RESULTS.items():
        age = max(0.0, now - float(result.get("stored_at", now)))
        if age > _DRAW_RESULTS_TTL_SECONDS:
            expired.append(draw_id)
    for draw_id in expired:
        _DRAW_RESULTS.pop(draw_id, None)
    size = sum(result.get("size_bytes", 0) for result in _DRAW_RESULTS.values())
    for draw_id in list(_DRAW_RESULTS):
        if len(_DRAW_RESULTS) <= _DRAW_RESULTS_MAX and size <= _DRAW_RESULTS_MAX_BYTES:
            break
        size -= _DRAW_RESULTS.pop(draw_id).get("size_bytes", 0)


def _store_draw_result(draw_id: str, result: dict[str, Any]) -> None:
    stored = dict(result)
    stored["size_bytes"] = len(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    with _DRAW_RESULTS_LOCK:
        _prune_draw_results()
        # "stored_at" is the TTL clock for this entry; _get_draw_result filters it out.
        stored["stored_at"] = time.time()
        # Replacing an id makes it newest, too.
        _DRAW_RESULTS.pop(str(draw_id), None)
        _DRAW_RESULTS[str(draw_id)] = stored
        _prune_draw_results()


def _get_draw_result(draw_id: str) -> dict[str, Any]:
    with _DRAW_RESULTS_LOCK:
        _prune_draw_results()
        result = _DRAW_RESULTS.get(str(draw_id))
        if not result:
            return {"present": False}
        return {"present": True, "images": result.get("images") or [], "mask": result.get("mask")}
