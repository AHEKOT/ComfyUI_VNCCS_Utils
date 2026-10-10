"""Per-user UniCanvas preferences kept in ComfyUI's user directory.

Currently: the models a user picked in the Custom tab, remembered per loader + Mode, so every
UniCanvas (any node, the standalone tab, any browser) starts from the files used last time.

The file is versioned. ``SCHEMA_VERSION`` is the layout this code writes; ``_MIGRATIONS[n]``
upgrades a document from version ``n`` to ``n + 1``. A file written by a NEWER version is read
best-effort and never overwritten, preserving the keys this version does not know.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Callable

from .paths import _EXTENSION_ROOT

SCHEMA_VERSION = 1
FILE_NAME = "unicanvas_model_memory.json"
MAX_ENTRIES = 40
MAX_LORAS = 10
MAX_TEXT = 512
_ASSET_FIELDS = ("ckpt_name", "diffusion_model_name", "gguf_model_name", "clip_name", "vae_name")
_TEXT_FIELDS = ("clip_type", "gguf_arch")

_LOCK = threading.Lock()


def _migrate_v0(document: dict[str, Any]) -> dict[str, Any]:
    """Version 0 = a bare ``{key: entry}`` mapping without the envelope."""
    entries = {key: value for key, value in document.items() if isinstance(value, dict)}
    return {"schema": 1, "entries": entries}


# Add ``1: _migrate_v1`` (etc.) here when the layout changes; each returns the next version.
_MIGRATIONS: dict[int, Callable[[dict[str, Any]], dict[str, Any]]] = {0: _migrate_v0}


def _prefs_path() -> str:
    try:
        import folder_paths

        root = folder_paths.get_user_directory()
    except Exception:
        root = os.path.join(_EXTENSION_ROOT, ".runtime_cache", "user")
    return os.path.join(os.path.abspath(str(root)), "vnccs", FILE_NAME)


def _text(value: Any) -> str:
    return value.strip()[:MAX_TEXT] if isinstance(value, str) else ""


def sanitize_entry(entry: Any) -> dict[str, Any]:
    """Validated copy of one remembered choice; unknown keys and bad types are dropped."""
    if not isinstance(entry, dict):
        return {}
    clean: dict[str, Any] = {}
    for key in (*_ASSET_FIELDS, *_TEXT_FIELDS):
        value = _text(entry.get(key))
        if value:
            clean[key] = value
    loras = []
    for item in (entry.get("lora_stack") if isinstance(entry.get("lora_stack"), list) else [])[:MAX_LORAS]:
        name = _text(item.get("name")) if isinstance(item, dict) else ""
        if not name:
            continue
        try:
            strength = float(item.get("strength", 1))
        except (TypeError, ValueError):
            strength = 1.0
        loras.append({"name": name, "strength": strength if strength == strength else 1.0})
    if not clean and not loras:
        return {}
    clean["lora_stack"] = loras
    try:
        clean["at"] = int(entry.get("at") or 0)
    except (TypeError, ValueError):
        clean["at"] = 0
    return clean


def migrate(document: Any) -> dict[str, Any]:
    """Bring any stored document to the current envelope ``{"schema", "entries", ...}``."""
    if not isinstance(document, dict):
        return {"schema": SCHEMA_VERSION, "entries": {}}
    version = document.get("schema") if isinstance(document.get("schema"), int) else 0
    if version > SCHEMA_VERSION:
        return document  # written by a newer version: read as is, never downgraded
    current = document
    while version < SCHEMA_VERSION:
        step = _MIGRATIONS.get(version)
        if step is None:
            return {"schema": SCHEMA_VERSION, "entries": {}}
        current = step(current)
        version = current.get("schema", version + 1)
    return current


def _entries_of(document: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = document.get("entries")
    entries = {}
    for key, value in (raw.items() if isinstance(raw, dict) else []):
        clean = sanitize_entry(value)
        if isinstance(key, str) and 0 < len(key) <= 200 and clean:
            entries[key] = clean
    return entries


def load_model_memory() -> dict[str, Any]:
    with _LOCK:
        return _load_locked()


def _load_locked() -> dict[str, Any]:
    try:
        with open(_prefs_path(), "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        if not isinstance(raw, dict):
            raise ValueError("model memory must be an object")
        document = migrate(raw)
    except FileNotFoundError:
        document = {"schema": SCHEMA_VERSION, "entries": {}}
    except (OSError, ValueError) as exc:
        raise ValueError(f"Cannot read UniCanvas model memory; original file preserved: {exc}") from exc
    document["entries"] = _entries_of(document)
    return document


def remember_model_choice(key: Any, entry: Any) -> dict[str, Any]:
    """Store one choice (newest wins, oldest evicted) and return the whole document."""
    clean = sanitize_entry(entry)
    if not isinstance(key, str) or not 0 < len(key.strip()) <= 200 or not clean:
        raise ValueError("[VNCCS UniCanvas] model memory needs a key and a non-empty entry.")
    with _LOCK:
        document = _load_locked()
        if document.get("schema", 0) > SCHEMA_VERSION:
            raise ValueError("UniCanvas model memory was written by a newer version; original file preserved")
        entries = document["entries"]
        entries[key.strip()] = clean
        newest = sorted(entries, key=lambda name: entries[name].get("at", 0), reverse=True)[:MAX_ENTRIES]
        document["entries"] = {name: entries[name] for name in newest}
        path = _prefs_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary = f"{path}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, ensure_ascii=False)
        os.replace(temporary, path)
        return document
