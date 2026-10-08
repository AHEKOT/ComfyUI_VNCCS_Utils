import asyncio
import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from helpers.runtime_caches import load_runtime_caches
from helpers.unicanvas_package import load_unicanvas_package


class RuntimeCacheTests(unittest.TestCase):
    def test_canvas_node_reads_the_same_normalized_ids_as_upload_api(self):
        state_module = load_unicanvas_package("vnccs_cache_reader_test").state
        directory = self.cache["_UNICANVAS_STATE_CACHE_DIR"]
        with mock.patch.object(state_module, "_UNICANVAS_STATE_CACHE_DIR", directory):
            for state_id in ("a" * 96, "b" * 97, "c" * 128, "___" + "d" * 128 + "___", "e" * 127 + "__more", "!bad/name!"):
                with self.subTest(state_id=state_id):
                    state = {"layers": [], "marker": state_id}
                    class Request:
                        headers = {"Content-Length": "1000"}

                        async def json(self):
                            return {"state_id": state_id, "state": state}

                    response = asyncio.run(self.cache["routes"]["/vnccs/unicanvas_state_upload"](Request()))
                    self.assertEqual(response.status, 200)
                    self.assertEqual(state_module._read_unicanvas_state_cache(state_id), state)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = load_runtime_caches(self.root)

    def test_capture_reads_refresh_lru_order(self):
        cache = self.cache["VNCCS_CAPTURE_CACHE"]
        cache.update({"a": {"value": 1}, "b": {"value": 2}, "c": {"value": 3}})
        self.assertEqual(self.cache["vnccs_get_capture_cache"]("a"), {"value": 1})
        self.assertEqual(list(cache), ["b", "c", "a"])

    def test_saved_files_survive_count_size_age_and_restart(self):
        for kind, limit in (("unicanvas_state", 65), ("pose_animation", 257)):
            write = self.cache[f"_vnccs_write_{kind}_cache_file"]
            path = self.cache[f"_vnccs_{kind}_cache_path"]
            write("old", {"value": "saved"})
            old = path("old")
            old_time = time.time() - 181 * 86400
            os.utime(old, (old_time, old_time))
            # Sparse file exceeds the old byte limit without allocating gigabytes.
            with open(path("large"), "wb") as handle:
                handle.truncate(1024 ** 3 + 1)
            for index in range(limit):
                write(f"saved_{index}", {"value": index})
            self.assertTrue(Path(old).is_file())
            self.assertTrue(Path(path("saved_0")).is_file())
            shutil.rmtree(self.root / "temp", ignore_errors=True)
            self.cache = load_runtime_caches(self.root)
            self.assertEqual(self.cache[f"_vnccs_read_{kind}_cache_file"]("old"), {"value": "saved"})

    def test_animation_legacy_temp_files_are_read_and_saved_persistently(self):
        legacy = Path(self.cache["_POSE_ANIMATION_LEGACY_CACHE_DIR"])
        legacy.mkdir(parents=True, exist_ok=True)
        entry = {"animation": {"tracks": {}}, "revision": 7}
        (legacy / "old.json").write_text(json.dumps(entry))
        self.assertEqual(self.cache["vnccs_get_pose_animation_cache"]("old"), entry)
        shutil.rmtree(self.root / "temp")
        self.cache = load_runtime_caches(self.root)
        self.assertEqual(self.cache["vnccs_get_pose_animation_cache"]("old"), entry)

    def test_legacy_canvas_read_migrates_before_temp_cleanup(self):
        legacy = Path(self.cache["_UNICANVAS_LEGACY_STATE_CACHE_DIR"])
        legacy.mkdir(parents=True, exist_ok=True)
        entry = {"state": {"layers": []}}
        (legacy / "old.json").write_text(json.dumps(entry))
        self.assertEqual(self.cache["_vnccs_read_unicanvas_state_cache_file"]("old"), entry)
        shutil.rmtree(self.root / "temp")
        self.cache = load_runtime_caches(self.root)
        self.assertEqual(self.cache["_vnccs_read_unicanvas_state_cache_file"]("old"), entry)

    def test_canvas_rejects_late_revision_after_memory_eviction(self):
        upload = self.cache["routes"]["/vnccs/unicanvas_state_upload"]
        gate = asyncio.Event()

        class Request:
            headers = {"Content-Length": "100"}

            def __init__(self, revision, wait=False):
                self.revision, self.wait = revision, wait

            async def json(self):
                if self.wait:
                    await gate.wait()
                return {"state_id": "same", "revision": self.revision,
                        "state": {"layers": [{"dataURL": f"pixels-{self.revision}"}]}}

        async def run():
            older = asyncio.create_task(upload(Request(1, wait=True)))
            await asyncio.sleep(0)
            self.assertEqual((await upload(Request(2))).status, 200)
            self.cache["VNCCS_UNICANVAS_STATE_CACHE"].clear()
            gate.set()
            self.assertEqual((await older).data["status"], "stale_ignored")
            self.assertEqual((await upload(Request(-1))).status, 400)

        asyncio.run(run())
        entry = self.cache["_vnccs_read_unicanvas_state_cache_file"]("same")
        self.assertEqual(entry["state"]["layers"][0]["dataURL"], "pixels-2")

    def test_canvas_accepts_legacy_payloads(self):
        class Request:
            headers = {"Content-Length": "100"}

            async def json(self):
                return {"state_id": "legacy", "state": {"layers": []}}

        response = asyncio.run(self.cache["routes"]["/vnccs/unicanvas_state_upload"](Request()))
        self.assertEqual(response.status, 200)

    def test_build_info_keeps_extension_root_after_cache_extraction(self):
        self.assertEqual(Path(self.cache["_EXTENSION_ROOT"]), Path(__file__).resolve().parents[1])
        self.cache["_EXTENSION_ROOT"] = str(self.root)
        git = self.root / ".git"
        git.mkdir()
        (git / "HEAD").write_text("a" * 40)
        web = self.root / "web"
        web.mkdir()
        entry = web / "vnccs_unicanvas.js"
        entry.write_text("// fixture")
        os.utime(entry, (1800000000, 1800000000))
        self.assertEqual(self.cache["_vnccs_unicanvas_build_info"](), {"commit": "aaaaaaa", "version": "1800000000000"})


if __name__ == "__main__":
    unittest.main()
