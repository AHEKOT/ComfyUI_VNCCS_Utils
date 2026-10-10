"""Atomic JSON documents and reusable cards in the node-owned prompt library."""

import hashlib
import json
import os
import re
import secrets
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from .prompt_designer import MAX_STATE_CHARS, prompt_template
from .shared.paths import _EXTENSION_ROOT

_LOCK = threading.RLock()
_ID = re.compile(r"[a-f0-9]{32}\Z")
_DIGEST = re.compile(r"[a-f0-9]{64}\Z")
_HISTORY_LIMIT = 20


class RevisionConflict(ValueError):
    """A newer document exists; the submitted JSON draft is retained."""


class StorageError(RuntimeError):
    """Invalid stored data must be retained rather than replaced with defaults."""


def storage_path():
    return Path(_EXTENSION_ROOT) / "PromptLibrary"


def validate_id(document_id):
    if not isinstance(document_id, str) or not _ID.fullmatch(document_id):
        raise ValueError("Invalid Prompt Designer document ID.")


def validate_state(state):
    if not isinstance(state, dict):
        raise ValueError("Invalid Prompt Designer document.")
    if "savedPrompt" in state:
        prompt = state["savedPrompt"]
        if (not isinstance(prompt, dict) or not {"name", "category"} <= set(prompt)
                or not set(prompt) <= {"name", "category", "color"}
                or not isinstance(prompt["name"], str) or not prompt["name"].strip() or len(prompt["name"]) > 128
                or not isinstance(prompt["category"], str) or len(prompt["category"]) > 128
                or ("color" in prompt and (not isinstance(prompt["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", prompt["color"])))):
            raise ValueError("Invalid saved prompt name, category or color.")
    raw = json.dumps(state, ensure_ascii=False)
    # An unfinished seed is a draft, not a reason to discard authored text.
    prompt_template(json.dumps({**state, "seed": "0"}, ensure_ascii=False))
    if len(raw) > MAX_STATE_CHARS:
        raise ValueError("Prompt Designer state is too large.")
    return raw


@contextmanager
def _locked():
    with _LOCK:
        root = storage_path()
        root.mkdir(parents=True, exist_ok=True)
        with (root / ".library.lock").open("a+b") as lock:
            if os.name == "nt":
                import msvcrt
                if lock.seek(0, os.SEEK_END) == 0:
                    lock.write(b"\0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if os.name == "nt":
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path):
    try:
        if path.stat().st_size > MAX_STATE_CHARS * 8:
            raise ValueError("Stored JSON is too large.")
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise StorageError(f"Damaged JSON in {path.name}. Existing data was retained.") from exc


def _read_record(path):
    record = _read_json(path)
    try:
        if (not isinstance(record, dict) or set(record) != {"revision", "state", "digest"}
                or type(record["revision"]) is not int or not 1 <= record["revision"] <= 2**53 - 1
                or not isinstance(record["digest"], str) or not _DIGEST.fullmatch(record["digest"])):
            raise ValueError("Invalid stored document metadata.")
        raw = validate_state(record["state"])
        if hashlib.sha256(raw.encode("utf-8")).hexdigest() != record["digest"]:
            raise ValueError("Stored document checksum does not match.")
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise StorageError(f"Damaged document in {path.name}. Existing data was retained.") from exc
    return record


def _document_path(document_id):
    return storage_path() / "user" / f"{document_id}.json"


def _load_record(document_id):
    path = _document_path(document_id)
    backup = path.with_suffix(".backup.json")
    if not path.exists() and not backup.exists():
        return None
    try:
        return _read_record(path)
    except (FileNotFoundError, StorageError):
        if not backup.exists():
            raise StorageError(f"Could not restore {path.name}; no valid backup is available. Existing data was retained.")
        record = _read_record(backup)
        # Validate the backup first; keep the damaged original before restoring it.
        if path.exists():
            os.replace(path, path.with_name(f"{document_id}.corrupt.{time.time_ns()}.json"))
        _atomic_json(path, record)
        return record


def _backup(path, record):
    if record is not None:
        _atomic_json(path.with_suffix(".backup.json"), record)


def _snapshot(digest, state):
    path = storage_path() / "history" / f"{digest}.json"
    if path.exists():
        raw = validate_state(_read_json(path))
        if hashlib.sha256(raw.encode("utf-8")).hexdigest() != digest:
            raise StorageError("A retained draft is damaged. Existing data was retained.")
    else:
        _atomic_json(path, state)
        return path


def load_document(document_id):
    validate_id(document_id)
    with _locked():
        record = _load_record(document_id)
        return {"revision": record["revision"], "state": record["state"]} if record else {"revision": 0, "state": None}


def save_document(document_id, state, revision):
    validate_id(document_id)
    if type(revision) is not int or not 0 <= revision <= 2**53 - 2:
        raise ValueError("Invalid document revision.")
    raw = validate_state(state)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    with _locked():
        path = _document_path(document_id)
        current = _load_record(document_id)
        # A backup failure must prevent changes to the current document.
        _backup(path, current)
        if current and current["digest"] == digest:
            return {"revision": current["revision"]}
        snapshot = _snapshot(digest, state)
        if (current["revision"] if current else 0) != revision:
            raise RevisionConflict("Newer edits exist. Your JSON draft is retained; save it as a separate document.")
        record = {"revision": revision + 1, "state": state, "digest": digest}
        _atomic_json(path, record)
        _backup(path, record)
        # Rotate successful autosaves only; retain existing, conflicting and interrupted drafts.
        if snapshot is not None:
            history = storage_path() / "history" / document_id
            history.mkdir(parents=True, exist_ok=True)
            os.replace(snapshot, history / f"{(revision + 1) % _HISTORY_LIMIT}.json")
        return {"revision": revision + 1}


def _document_ids():
    # Backups also identify documents whose main file needs recovery.
    identifiers = set()
    for path in (storage_path() / "user").glob("*.json"):
        identifier = path.name.split(".")[0]
        if _ID.fullmatch(identifier) and path.name in (f"{identifier}.json", f"{identifier}.backup.json"):
            identifiers.add(identifier)
    return sorted(identifiers)


def list_prompts(query="", offset=0):
    if not isinstance(query, str) or len(query) > 128 or type(offset) is not int or offset < 0:
        raise ValueError("Invalid library search.")
    with _locked():
        prompts = []
        for identifier in _document_ids():
            record = _load_record(identifier)
            metadata = record["state"].get("savedPrompt")
            if metadata and query.casefold() in metadata["name"].casefold():
                preview = "".join(part.get("text", "") for part in record["state"].get("parts", []))[:160]
                prompts.append({"id": identifier, "revision": record["revision"], **metadata, "text": preview})
        prompts.sort(key=lambda prompt: (prompt["name"].casefold(), prompt["id"]))
        return {"prompts": prompts[offset:offset + 50], "total": len(prompts), "offset": offset}


def list_cards(query="", offset=0):
    if not isinstance(query, str) or len(query) > 128 or type(offset) is not int or offset < 0:
        raise ValueError("Invalid library search.")
    with _locked():
        cards, categories = {}, {}
        for identifier in _document_ids():
            record = _load_record(identifier)
            for category in record["state"].get("categories", []):
                if category["name"] not in categories or category.get("color"):
                    categories[category["name"]] = category
            for block in record["state"].get("blocks", []):
                if query.casefold() in block["name"].casefold():
                    key = (block["name"], block["text"], block.get("mode"), block.get("color"), block.get("category"))
                    cards.setdefault(key, block)
        values = sorted(cards.values(), key=lambda block: (block["name"].casefold(), block["text"]))
        return {"cards": values[offset:offset + 50], "categories": list(categories.values()), "total": len(values), "offset": offset}
