import ast
import os
import re
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _load_cache_helpers():
    tree = ast.parse((ROOT / "__init__.py").read_text())
    wanted = {
        "_vnccs_safe_id",
        "_vnccs_prune_cache_dir",
        "vnccs_get_capture_cache",
    }
    selected = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in wanted]
    namespace = {
        "os": os,
        "time": time,
        "_SAFE_ID_RE": re.compile(r"[^A-Za-z0-9_-]+"),
        "_DISK_CACHE_TTL_SECONDS": 180 * 24 * 60 * 60,
        "VNCCS_CAPTURE_CACHE": {},
    }
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(ROOT / "__init__.py"), "exec"), namespace)
    return namespace


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
