"""Small durable catalog; canvas snapshots remain in the existing state cache."""
import json
import math
import os
import re
import stat
import tempfile
import threading
import uuid
from datetime import datetime, timezone

from . import cache

LOCK = threading.RLock()
_STATE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
_CANVAS_ID = re.compile(r"[a-f0-9]{32}\Z")


class CanvasConflict(RuntimeError):
    pass


def _validate_id(value, pattern, field):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f"invalid {field}")
    return value


def _name(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 160:
        raise ValueError("name must contain 1 to 160 characters")
    return value.strip()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _directory():
    return os.path.join(cache._UNICANVAS_STATE_CACHE_DIR, "documents")


def _path(canvas_id):
    _validate_id(canvas_id, _CANVAS_ID, "canvas_id")
    return os.path.join(_directory(), f"{canvas_id}.json")


def _validate_manifest(value):
    if not isinstance(value, dict):
        raise ValueError("manifest must be an object")
    _validate_id(value.get("canvas_id"), _CANVAS_ID, "canvas_id")
    _validate_id(value.get("state_id"), _STATE_ID, "state_id")
    if "state_ids" in value:
        state_ids = value["state_ids"]
        if not isinstance(state_ids, list) or not state_ids:
            raise ValueError("state_ids must be a nonempty list")
        for state_id in state_ids:
            _validate_id(state_id, _STATE_ID, "state_ids entry")
        if len(set(state_ids)) != len(state_ids) or value["state_id"] not in state_ids:
            raise ValueError("state_ids must be unique and contain the current state_id")
    _name(value.get("name"))
    for field in ("created_at", "updated_at"):
        stamp = value.get(field)
        if not isinstance(stamp, str) or datetime.fromisoformat(stamp).tzinfo is None:
            raise ValueError(f"invalid {field}")
    for field in ("layer_count", "width", "height"):
        if type(value.get(field)) is not int or value[field] < 0:
            raise ValueError(f"invalid {field}")
    if type(value.get("panorama")) is not bool or type(value.get("deleted")) is not bool:
        raise ValueError("invalid manifest flags")
    return value


def _validate_active(value):
    if not isinstance(value, dict):
        raise ValueError("active pointer must be an object")
    _validate_id(value.get("canvas_id"), _CANVAS_ID, "canvas_id")
    return value


def _read_valid(path, validate):
    with open(path, "r", encoding="utf-8") as handle:
        value = validate(json.load(handle))
    if validate is _validate_manifest and value["canvas_id"] != os.path.basename(path).split(".", 1)[0]:
        raise ValueError("Canvas catalog identity does not match its filename")
    return value


def _read_record(path, validate):
    damaged = False
    for candidate in (path, path + ".bak"):
        try:
            return _read_valid(candidate, validate)
        except FileNotFoundError:
            continue
        except (ValueError, TypeError, UnicodeError):
            damaged = True
    if damaged:
        raise OSError(f"Corrupt canvas catalog record without a valid backup: {os.path.basename(path)}")
    return None


def _atomic_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=os.path.dirname(path),
                                         prefix=".document_", delete=False) as handle:
            temp_path = handle.name
            json.dump(value, handle, ensure_ascii=False, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        if os.name == "posix":
            directory_fd = os.open(os.path.dirname(path), os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


def _write_record(path, value, validate):
    validate(value)
    previous = _read_record(path, validate)
    if previous is not None:
        try:
            _read_valid(path, validate)
        except FileNotFoundError:
            pass
        except (ValueError, TypeError, UnicodeError):
            # Keep damaged bytes for recovery; never promote them into the backup.
            os.replace(path, path + f".corrupt.{uuid.uuid4().hex}")
        backup = previous
        if validate is _validate_manifest:
            # Recovery may roll metadata back, but cannot release any owned snapshot.
            backup = {**previous, "state_ids": list(dict.fromkeys([*_owned_state_ids(previous), *_owned_state_ids(value)]))}
        _atomic_json(path + ".bak", backup)
    _atomic_json(path, value)


def _manifest(canvas_id):
    value = _read_record(_path(canvas_id), _validate_manifest)
    if value is None:
        raise FileNotFoundError("Canvas not found")
    return value


def _manifests():
    try:
        names = os.listdir(_directory())
    except FileNotFoundError:
        return []
    ids = {name.split(".", 1)[0] for name in names
           if re.fullmatch(r"[a-f0-9]{32}\.json(?:\.bak)?", name)}
    return [_manifest(canvas_id) for canvas_id in sorted(ids)]


def _public(value, *, include_cache_size=True):
    result = {key: item for key, item in value.items() if key not in ("deleted", "state_ids")}
    if include_cache_size:
        total = current = 0
        counted = set()
        directories = set((cache._UNICANVAS_STATE_CACHE_DIR, cache._UNICANVAS_LEGACY_STATE_CACHE_DIR))
        for state_id in _owned_state_ids(value):
            for directory in directories:
                for cache_id in (state_id, f"{state_id}_out"):
                    path = os.path.join(directory, f"{cache_id}.json")
                    try:
                        info = os.stat(path, follow_symlinks=False)
                    except FileNotFoundError:
                        continue
                    if stat.S_ISREG(info.st_mode):
                        if path not in counted:
                            total += info.st_size
                            counted.add(path)
                        if state_id == value["state_id"]:
                            current += info.st_size
        result.update(cache_bytes=total, current_cache_bytes=current, snapshot_count=len(_owned_state_ids(value)))
    return result


def _owned_state_ids(value):
    return value.get("state_ids", [value["state_id"]])


def _remember_state_id(value, state_id):
    value["state_ids"] = [*_owned_state_ids(value)]
    if state_id not in value["state_ids"]:
        value["state_ids"].append(state_id)


def _summary(state):
    if not isinstance(state, dict) or not isinstance(state.get("layers"), list):
        raise ValueError("state.layers must be a list")
    if type(state.get("version")) is not int or not 1 <= state["version"] <= 3:
        raise ValueError("state.version must be 1, 2 or 3")
    size = state.get("size") or {}
    if not isinstance(size, dict):
        raise ValueError("state.size must be an object")
    dimensions = {}
    for field in ("width", "height"):
        value = size.get(field, 0)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError(f"invalid state.size.{field}")
        dimensions[field] = int(value)
    return {"layer_count": len(state["layers"]), "panorama": bool(state.get("panorama")), **dimensions}


def _cached_summary(state_id):
    _validate_id(state_id, _STATE_ID, "state_id")
    entry = cache.VNCCS_UNICANVAS_STATE_CACHE.get(state_id)
    if entry is None:
        path = cache._unicanvas_state_cache_path(state_id)
        if path is None:
            raise FileNotFoundError("Canvas state not found")
        # Read legacy caches without rewriting their original bytes.
        with open(path, "r", encoding="utf-8") as handle:
            try:
                entry = json.load(handle)
            except (ValueError, UnicodeError) as exc:
                raise OSError("Corrupt canvas state cache") from exc
    if not isinstance(entry, dict):
        raise ValueError("canvas cache must be an object")
    return _summary(entry.get("state"))


def validate_document_state(state_id, state):
    _validate_id(state_id, _STATE_ID, "state_id")
    return _summary(state)


def _ensure_available(state_id, canvas_id=None):
    for value in _manifests():
        if state_id in _owned_state_ids(value) and value["canvas_id"] != canvas_id:
            raise CanvasConflict("Canvas state already belongs to another or deleted document")


def validate_unmanaged_state(state_id):
    with LOCK:
        _ensure_available(state_id)


def validate_output_state(state_id, state, previous):
    if not state_id.endswith("_out"):
        return
    with LOCK:
        for value in _manifests():
            if state_id[:-4] in _owned_state_ids(value):
                if value["deleted"] or (isinstance(previous, dict) and previous.get("state") != state):
                    raise CanvasConflict("Saved canvas outputs are immutable; save changes in a new state_id")


def list_documents():
    with LOCK:
        values = [_public(value) for value in _manifests() if not value["deleted"]]
        values.sort(key=lambda value: (value["updated_at"], value["canvas_id"]), reverse=True)
        active = _read_record(os.path.join(_directory(), "active.json"), _validate_active)
        active_id = active["canvas_id"] if active else None
        if not any(value["canvas_id"] == active_id for value in values):
            active_id = values[0]["canvas_id"] if values else None
        return {"documents": values, "active_canvas_id": active_id}


def get_document(canvas_id):
    with LOCK:
        value = _manifest(canvas_id)
        if value["deleted"]:
            raise FileNotFoundError("Canvas was deleted")
        return _public(value)


def register_document(state_id, name=None):
    with LOCK:
        _validate_id(state_id, _STATE_ID, "state_id")
        if name is not None:
            name = _name(name)
        for value in _manifests():
            if state_id in _owned_state_ids(value):
                if value["deleted"] or value["state_id"] != state_id:
                    raise CanvasConflict("Canvas snapshot is retired or deleted; create a new canvas state")
                return _public(value)
        now = _now()
        value = {"canvas_id": uuid.uuid4().hex, "state_id": state_id, "state_ids": [state_id],
                 "name": name or "Untitled canvas", "created_at": now, "updated_at": now,
                 "deleted": False, **_cached_summary(state_id)}
        _write_record(_path(value["canvas_id"]), value, _validate_manifest)
        return _public(value)


def validate_state_owner(canvas_id, expected_state_id, state_id=None):
    with LOCK:
        _validate_id(expected_state_id, _STATE_ID, "expected_state_id")
        value = _manifest(canvas_id)
        if value["deleted"] or value["state_id"] != expected_state_id:
            raise CanvasConflict("Canvas changed or was deleted; reload before saving")
        if state_id is not None:
            _validate_id(state_id, _STATE_ID, "state_id")
            _ensure_available(state_id, canvas_id)
        return _public(value, include_cache_size=False)


def update_document(canvas_id, *, name=None, state_id=None, expected_state_id=None):
    with LOCK:
        validate_state_owner(canvas_id, expected_state_id)
        value = _manifest(canvas_id)
        if name is None and state_id is None:
            raise ValueError("name or state_id is required")
        if name is not None:
            value["name"] = _name(name)
        if state_id is not None:
            _validate_id(state_id, _STATE_ID, "state_id")
            _ensure_available(state_id, canvas_id)
            _remember_state_id(value, state_id)
            value.update(state_id=state_id, **_cached_summary(state_id))
        value["updated_at"] = _now()
        _write_record(_path(canvas_id), value, _validate_manifest)
        return _public(value)


def note_state_saved(canvas_id, state_id, state, expected_state_id):
    with LOCK:
        validate_state_owner(canvas_id, expected_state_id)
        _validate_id(state_id, _STATE_ID, "state_id")
        _ensure_available(state_id, canvas_id)
        value = _manifest(canvas_id)
        _remember_state_id(value, state_id)
        value.update(state_id=state_id, updated_at=_now(), **_summary(state))
        _write_record(_path(canvas_id), value, _validate_manifest)
        return _public(value, include_cache_size=False)


def set_active_document(canvas_id):
    with LOCK:
        get_document(canvas_id)
        _write_record(os.path.join(_directory(), "active.json"), {"canvas_id": canvas_id}, _validate_active)
        return canvas_id


def delete_document(canvas_id, expected_state_id):
    with LOCK:
        validate_state_owner(canvas_id, expected_state_id)
        value = _manifest(canvas_id)
        value.update(deleted=True, updated_at=_now())
        _write_record(_path(canvas_id), value, _validate_manifest)
        # A damaged primary must not restore the live document after deletion.
        _atomic_json(_path(canvas_id) + ".bak", value)
