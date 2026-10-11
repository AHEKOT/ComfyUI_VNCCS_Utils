"""Progress shared by Pose and Factory repository operations."""
import time
import threading

_REPOSITORY_PROGRESS = {}

_REPOSITORY_PROGRESS_LOCK = threading.Lock()

_REPOSITORY_PROGRESS_MAX = 256

_REPOSITORY_PROGRESS_TTL_SECONDS = 60 * 60

_REPOSITORY_PROGRESS_RUNNING_TTL_SECONDS = 24 * 60 * 60


def _prune_repository_progress(now=None):
    now = time.time() if now is None else now
    expired = []
    for task_id, state in _REPOSITORY_PROGRESS.items():
        age = max(0.0, now - float(state.get("updated_at", now)))
        status = state.get("status")
        if (status != "running" and age > _REPOSITORY_PROGRESS_TTL_SECONDS) or age > _REPOSITORY_PROGRESS_RUNNING_TTL_SECONDS:
            expired.append(task_id)
    for task_id in expired:
        _REPOSITORY_PROGRESS.pop(task_id, None)
    if len(_REPOSITORY_PROGRESS) <= _REPOSITORY_PROGRESS_MAX:
        return
    ordered = sorted(
        _REPOSITORY_PROGRESS.items(),
        key=lambda item: (item[1].get("status") == "running", float(item[1].get("updated_at", 0))),
    )
    for task_id, _ in ordered[:len(_REPOSITORY_PROGRESS) - _REPOSITORY_PROGRESS_MAX]:
        _REPOSITORY_PROGRESS.pop(task_id, None)


def repository_progress_start(task_id, message="Starting repository operation..."):
    if not task_id:
        return
    with _REPOSITORY_PROGRESS_LOCK:
        _REPOSITORY_PROGRESS[task_id] = {
            "status": "running",
            "message": message,
            "progress": 0,
            "current_file": "",
            "file_index": 0,
            "total_files": 0,
            "bytes_done": 0,
            "bytes_total": 0,
            "updated_at": time.time(),
        }
        _prune_repository_progress()


def repository_progress_update(task_id, **kwargs):
    if not task_id:
        return
    with _REPOSITORY_PROGRESS_LOCK:
        state = _REPOSITORY_PROGRESS.setdefault(task_id, {"status": "running", "progress": 0})
        state.update(kwargs)
        state["updated_at"] = time.time()
        _prune_repository_progress()


def repository_progress_finish(task_id, message="Done."):
    if not task_id:
        return
    repository_progress_update(task_id, status="success", message=message, progress=100)


def repository_progress_fail(task_id, message):
    if not task_id:
        return
    repository_progress_update(task_id, status="error", message=str(message), progress=100)


def get_repository_progress(task_id):
    with _REPOSITORY_PROGRESS_LOCK:
        _prune_repository_progress()
        state = _REPOSITORY_PROGRESS.get(task_id)
        if not state:
            return {
                "status": "unknown",
                "message": "Waiting for repository operation...",
                "progress": 0,
            }
        return dict(state)
