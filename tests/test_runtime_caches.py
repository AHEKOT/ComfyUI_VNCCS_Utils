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
    def test_standalone_upload_checks_the_revision_read_by_each_tab(self):
        upload = self.cache["routes"]["/vnccs/unicanvas_state_upload"]
        state_id = "vnccs_unicanvas_standalone_tab"

        def save(revision, base_revision, marker):
            class Request:
                headers = {"Content-Length": "1000"}
                async def json(self):
                    return {"state_id": state_id, "state": {"layers": [], "marker": marker},
                            "revision": revision, "base_revision": base_revision}
            return asyncio.run(upload(Request()))

        self.assertEqual(save(10, -1, "original").status, 200)
        self.assertEqual(save(20, 10, "first tab").status, 200)
        self.assertEqual(save(20, 10, "first tab").status, 200, "lost acknowledgements can be retried")
        self.cache["VNCCS_UNICANVAS_STATE_CACHE"].clear()
        self.assertEqual(save(30, 10, "stale tab").status, 409)
        self.assertEqual(save(30, True, "invalid").status, 400)
        self.assertEqual(save(30, None, "old client").status, 400)
        self.assertEqual(self.cache["_vnccs_read_unicanvas_state_cache_file"](state_id)["state"]["marker"], "first tab")
        self.assertEqual(save(30, 20, "first tab again").status, 200)

    def test_stale_standalone_tab_cannot_clear_another_tabs_edits(self):
        state_id = "vnccs_unicanvas_standalone_tab"
        entry = {"state": {"layers": [], "marker": "new edit"}, "revision": 20}
        self.cache["_vnccs_write_unicanvas_state_cache_file"](state_id, entry)
        class Request:
            headers = {"Content-Length": "1000"}
            async def json(self):
                return {"state_id": state_id, "revision": 30, "base_revision": 10}
        response = asyncio.run(self.cache["routes"]["/vnccs/unicanvas_state_delete"](Request()))
        self.assertEqual(response.status, 409)
        self.assertEqual(self.cache["_vnccs_read_unicanvas_state_cache_file"](state_id), entry)

    def test_canvas_node_reads_the_same_normalized_ids_as_upload_api(self):
        state_module = load_unicanvas_package("vnccs_cache_reader_test").state
        directory = self.cache["_UNICANVAS_STATE_CACHE_DIR"]
        with mock.patch.object(state_module.cache, "_UNICANVAS_STATE_CACHE_DIR", directory):
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

    def test_canvas_delete_removes_current_output_legacy_and_blocks_late_uploads(self):
        write = self.cache["_vnccs_write_unicanvas_state_cache_file"]
        directory = Path(self.cache["_UNICANVAS_STATE_CACHE_DIR"])
        legacy = Path(self.cache["_UNICANVAS_LEGACY_STATE_CACHE_DIR"])
        legacy.mkdir(parents=True)
        for state_id in ("current", "current_out", "saved_workflow"):
            entry = {"state": {"layers": [{"dataURL": "pixels"}]}, "revision": 7}
            write(state_id, entry)
            self.cache["VNCCS_UNICANVAS_STATE_CACHE"][state_id] = entry
            (legacy / f"{state_id}.json").write_text(json.dumps(entry))

        class Request:
            headers = {"Content-Length": "100"}
            async def json(self):
                return {"state_id": "current", "revision": 9}

        delete = self.cache["routes"]["/vnccs/unicanvas_state_delete"]
        self.assertEqual(asyncio.run(delete(Request())).status, 200)
        self.assertEqual([path.name for path in legacy.iterdir()], ["saved_workflow.json"])
        self.assertEqual(json.loads((directory / "saved_workflow.json").read_text())["state"]["layers"], [{"dataURL": "pixels"}])
        self.cache["VNCCS_UNICANVAS_STATE_CACHE"].clear()
        for state_id in ("current", "current_out"):
            class LateUpload(Request):
                async def json(self):
                    return {"state_id": state_id, "revision": 8, "state": {"layers": [{"dataURL": "old pixels"}]}}
            upload = self.cache["routes"]["/vnccs/unicanvas_state_upload"]
            self.assertEqual(asyncio.run(upload(LateUpload())).data["status"], "stale_ignored")
            path = directory / f"{state_id}.json"
            self.assertLess(path.stat().st_size, 100, "only the empty revision marker remains")
            self.assertEqual(json.loads(path.read_text())["state"]["layers"], [])
        self.assertEqual(asyncio.run(delete(Request())).status, 200, "already deleted files are harmless")

    def test_canvas_delete_rejects_invalid_request_and_reports_disk_failure(self):
        delete = self.cache["routes"]["/vnccs/unicanvas_state_delete"]
        class Request:
            headers = {"Content-Length": "100"}
            payload = {}
            async def json(self):
                return self.payload
        request = Request()
        for payload in ({}, {"state_id": []}, {"state_id": "current", "revision": True},
                        {"state_id": "current", "revision": -1}):
            request.payload = payload
            self.assertEqual(asyncio.run(delete(request)).status, 400)
        request.headers = {"Content-Length": "1025"}
        self.assertEqual(asyncio.run(delete(request)).status, 413)
        request.headers = {"Content-Length": "100"}
        request.payload = {"state_id": "current", "revision": 1}
        with mock.patch.object(self.cache["canvas_service"].os, "remove", side_effect=PermissionError("denied")):
            self.assertEqual(asyncio.run(delete(request)).status, 500)

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

    def test_stale_delete_and_legacy_upload_preserve_newer_disk_snapshots(self):
        write = self.cache["_vnccs_write_unicanvas_state_cache_file"]
        read = self.cache["_vnccs_read_unicanvas_state_cache_file"]
        previous = {"state": {"layers": [{"dataURL": "new pixels"}]}, "revision": 200}
        for state_id in ("same", "same_out"):
            write(state_id, previous)
        class Request:
            headers = {"Content-Length": "100"}
            payload = {"state_id": "same", "revision": 100}
            async def json(self):
                return self.payload
        request = Request()
        delete = self.cache["routes"]["/vnccs/unicanvas_state_delete"]
        self.assertEqual(asyncio.run(delete(request)).data["status"], "stale_ignored")
        self.assertEqual(read("same"), previous)
        self.assertEqual(read("same_out"), previous)
        request.payload = {"state_id": "same", "state": {"layers": []}}
        upload = self.cache["routes"]["/vnccs/unicanvas_state_upload"]
        self.assertEqual(asyncio.run(upload(request)).data["status"], "stale_ignored")
        self.assertEqual(read("same"), previous)
        # A newer output alone must prevent a partial deletion of the document.
        write("same", {**previous, "revision": 50})
        request.payload = {"state_id": "same", "revision": 100}
        self.assertEqual(asyncio.run(delete(request)).data["status"], "stale_ignored")
        self.assertEqual(read("same")["revision"], 50)
        self.assertEqual(read("same_out"), previous)

    def test_canvas_failed_disk_write_preserves_previous_memory_and_disk_state(self):
        previous = {"state": {"layers": [{"dataURL": "old"}]}, "revision": 1}
        self.cache["_vnccs_write_unicanvas_state_cache_file"]("same", previous)
        self.cache["VNCCS_UNICANVAS_STATE_CACHE"]["same"] = previous
        class Request:
            headers = {"Content-Length": "100"}
            async def json(self):
                return {"state_id": "same", "revision": 2, "state": {"layers": [{"dataURL": "new"}]}}
        with mock.patch.object(self.cache["canvas_service"], "_vnccs_write_unicanvas_state_cache_file", side_effect=OSError("disk full")):
            response = asyncio.run(self.cache["routes"]["/vnccs/unicanvas_state_upload"](Request()))
        self.assertEqual(response.status, 500)
        self.assertEqual(self.cache["VNCCS_UNICANVAS_STATE_CACHE"]["same"], previous)
        self.assertEqual(self.cache["_vnccs_read_unicanvas_state_cache_file"]("same"), previous)

    def test_animation_failed_disk_write_preserves_previous_memory_and_disk_state(self):
        previous = {"animation": {"tracks": {}}, "revision": 1}
        self.cache["_vnccs_write_pose_animation_cache_file"]("same", previous)
        self.cache["VNCCS_POSE_ANIMATION_CACHE"]["same"] = previous
        class Request:
            headers = {"Content-Length": "100"}
            async def json(self):
                return {"animation_id": "same", "revision": 2, "animation": {"tracks": {}}}
        with mock.patch.object(self.cache["pose_service"], "_vnccs_write_pose_animation_cache_file", side_effect=OSError("disk full")):
            response = asyncio.run(self.cache["routes"]["/vnccs/pose_animation_upload"](Request()))
        self.assertEqual(response.status, 500)
        self.assertEqual(self.cache["VNCCS_POSE_ANIMATION_CACHE"]["same"], previous)
        self.assertEqual(self.cache["_vnccs_read_pose_animation_cache_file"]("same"), previous)

    def test_failed_atomic_cache_write_preserves_file_and_cleans_temporary_file(self):
        for kind in ("pose_animation", "unicanvas_state"):
            with self.subTest(kind=kind):
                write = self.cache[f"_vnccs_write_{kind}_cache_file"]
                path = Path(self.cache[f"_vnccs_{kind}_cache_path"]("saved"))
                write("saved", {"value": "old"})
                def fail_dump(_entry, handle, **_kwargs):
                    handle.write("partial")
                    raise OSError("disk full")
                with mock.patch.object(self.cache["json"], "dump", side_effect=fail_dump):
                    with self.assertRaisesRegex(OSError, "disk full"):
                        write("saved", {"value": "new"})
                self.assertEqual(json.loads(path.read_text()), {"value": "old"})
                self.assertEqual(list(path.parent.iterdir()), [path])

    def test_build_info_keeps_extension_root_after_cache_extraction(self):
        self.assertEqual(Path(self.cache["_EXTENSION_ROOT"]), Path(__file__).resolve().parents[1])
        self.cache["build_service"]._EXTENSION_ROOT = str(self.root)
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
