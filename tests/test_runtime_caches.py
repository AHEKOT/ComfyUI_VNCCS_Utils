import os
import re
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _safe_id(value, fallback="item"):
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "")).strip("_")
    return cleaned[:128] or fallback


def _prune_cache_dir(directory, max_files, max_total_bytes, protected_path=None):
    protected_path = os.path.abspath(protected_path) if protected_path else None
    files = []
    for entry in os.scandir(directory):
        if entry.is_file(follow_symlinks=False) and entry.name.endswith(".json"):
            stat = entry.stat(follow_symlinks=False)
            files.append([stat.st_mtime, stat.st_size, entry.path, os.path.abspath(entry.path)])
    files.sort(key=lambda item: item[0])
    total_bytes = sum(item[1] for item in files)
    blocked = set()
    while len(files) > max_files or total_bytes > max_total_bytes:
        candidate = next((item for item in files if item[3] != protected_path and item[3] not in blocked), None)
        if candidate is None:
            break
        files.remove(candidate)
        try:
            os.unlink(candidate[2])
            total_bytes -= candidate[1]
        except OSError:
            blocked.add(candidate[3])


_CAPTURE_CACHE = {}


def _get_capture_cache(capture_id):
    capture_id = _safe_id(capture_id, "capture")
    entry = _CAPTURE_CACHE.pop(capture_id, None)
    if entry is not None:
        _CAPTURE_CACHE[capture_id] = entry
    return entry


def _load_cache_helpers():
    return {
        "VNCCS_CAPTURE_CACHE": _CAPTURE_CACHE,
        "vnccs_get_capture_cache": _get_capture_cache,
        "_vnccs_prune_cache_dir": _prune_cache_dir,
    }


CACHE = _load_cache_helpers()


class RuntimeCacheTests(unittest.TestCase):
    def test_capture_reads_refresh_lru_order(self):
        cache = CACHE["VNCCS_CAPTURE_CACHE"]
        cache.clear()
        cache.update({"a": {"value": 1}, "b": {"value": 2}, "c": {"value": 3}})

        self.assertEqual(CACHE["vnccs_get_capture_cache"]("a"), {"value": 1})
        self.assertEqual(list(cache), ["b", "c", "a"])

    def test_disk_pruning_keeps_recent_and_protected_files(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = []
            now = time.time()
            for index in range(4):
                path = Path(temp_dir) / f"{index}.json"
                path.write_text("x" * 10)
                os.utime(path, (now + index, now + index))
                paths.append(path)

            CACHE["_vnccs_prune_cache_dir"](
                temp_dir,
                max_files=2,
                max_total_bytes=20,
                protected_path=str(paths[0]),
            )

            remaining = {path.name for path in Path(temp_dir).glob("*.json")}
            self.assertEqual(remaining, {"0.json", "3.json"})


if __name__ == "__main__":
    unittest.main()
