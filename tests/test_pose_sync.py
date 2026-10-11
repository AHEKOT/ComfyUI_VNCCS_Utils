import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class StubResponse:
    def __init__(self, data, status=200):
        self.status = status
        self.body = json.dumps(data).encode("utf-8")


stub_aiohttp = types.ModuleType("aiohttp")
stub_aiohttp.web = types.SimpleNamespace(
    json_response=lambda data, status=200: StubResponse(data, status),
)

MODULE_PATH = Path(__file__).resolve().parents[1] / "api" / "pose_capture_sync.py"
SPEC = importlib.util.spec_from_file_location("vnccs_pose_sync_test_module", MODULE_PATH)
POSE_SYNC = importlib.util.module_from_spec(SPEC)
previous_aiohttp = sys.modules.get("aiohttp")
try:
    sys.modules["aiohttp"] = stub_aiohttp
    SPEC.loader.exec_module(POSE_SYNC)
finally:
    if previous_aiohttp is None:
        sys.modules.pop("aiohttp", None)
    else:
        sys.modules["aiohttp"] = previous_aiohttp


class FakeRequest:
    def __init__(self, data):
        self._data = data
        self.headers = {"Content-Length": str(len(json.dumps(data)))}
        self.can_read_body = True

    async def json(self):
        return self._data


class FakeRouter:
    def __init__(self):
        self.posts = []

    def add_post(self, path, handler):
        self.posts.append((path, handler))


class PoseSyncTests(unittest.TestCase):
    def test_invalid_json_objects_and_node_ids_are_rejected_before_disk_access(self):
        invalid_payloads = [None, [], "text", {"node_id": []}, {"node_id": {}}, {"node_id": True}]
        mock_temp = unittest.mock.Mock(side_effect=AssertionError("No disk access"))
        with patch.dict(sys.modules, {"folder_paths": types.SimpleNamespace(
                get_temp_directory=mock_temp)}):
            for payload in invalid_payloads:
                with self.subTest(payload=payload):
                    response = asyncio.run(POSE_SYNC.upload_pose_sync(FakeRequest(payload)))
                    self.assertEqual(response.status, 400)
            mock_temp.assert_not_called()

    def test_invalid_json_and_negative_content_length_do_not_write_captures(self):
        invalid_json = FakeRequest({"node_id": "42"})
        invalid_json.json = unittest.mock.AsyncMock(side_effect=ValueError("Invalid JSON"))
        self.assertEqual(asyncio.run(POSE_SYNC.upload_pose_sync(invalid_json)).status, 400)
        negative = FakeRequest({"node_id": "42"})
        negative.headers["Content-Length"] = "-1"
        negative.json = unittest.mock.AsyncMock()
        self.assertEqual(asyncio.run(POSE_SYNC.upload_pose_sync(negative)).status, 413)
        negative.json.assert_not_called()

    def test_failed_write_preserves_previous_capture_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "vnccs_debug_42.json"
            path.write_text('{"captured_images": ["old"]}')
            def fail_dump(_data, handle):
                handle.write("partial")
                raise OSError("disk full")
            with patch.dict(sys.modules, {"folder_paths": types.SimpleNamespace(get_temp_directory=lambda: root)}), \
                    patch.object(POSE_SYNC.json, "dump", side_effect=fail_dump):
                response = asyncio.run(POSE_SYNC.upload_pose_sync(FakeRequest({"node_id": "42"})))
            self.assertEqual(response.status, 500)
            self.assertEqual(json.loads(path.read_text()), {"captured_images": ["old"]})
            self.assertEqual(list(Path(root).iterdir()), [path])

    def test_registers_current_and_legacy_routes(self):
        app = types.SimpleNamespace(router=FakeRouter())

        POSE_SYNC.register_routes(app)

        self.assertEqual(
            [path for path, _handler in app.router.posts],
            ["/vnccs/pose_sync/upload_capture", "/vnccs/debug/upload_capture"],
        )
        self.assertTrue(all(handler is POSE_SYNC.upload_pose_sync for _path, handler in app.router.posts))

    def test_upload_writes_the_backend_compatible_sync_file(self):
        payload = {
            "node_id": "42/token?",
            "captured_images": ["data:image/png;base64,example"],
            "lighting_prompts": ["studio light"],
        }
        previous_folder_paths = sys.modules.get("folder_paths")
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                sys.modules["folder_paths"] = types.SimpleNamespace(
                    get_temp_directory=lambda: temp_dir,
                )

                response = asyncio.run(POSE_SYNC.upload_pose_sync(FakeRequest(payload)))

                self.assertEqual(response.status, 200)
                sync_path = Path(temp_dir) / "vnccs_debug_42_token.json"
                self.assertEqual(json.loads(sync_path.read_text()), payload)
        finally:
            if previous_folder_paths is None:
                sys.modules.pop("folder_paths", None)
            else:
                sys.modules["folder_paths"] = previous_folder_paths


if __name__ == "__main__":
    unittest.main()
