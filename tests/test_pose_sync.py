import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path


class StubResponse:
    def __init__(self, data, status=200):
        self.status = status
        self.body = json.dumps(data).encode("utf-8")


stub_aiohttp = types.ModuleType("aiohttp")
stub_aiohttp.web = types.SimpleNamespace(
    json_response=lambda data, status=200: StubResponse(data, status),
)

MODULE_PATH = Path(__file__).resolve().parents[1] / "api" / "pose_sync.py"
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
