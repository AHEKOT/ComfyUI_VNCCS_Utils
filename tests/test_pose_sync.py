import asyncio
import json
import sys
import tempfile
import types
import unittest
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest.mock import patch

from aiohttp import StreamReader, web
from aiohttp.test_utils import make_mocked_request

from helpers.backend_package import ROOT, service_package, stub_imports


POSE_SYNC = service_package("vnccs_pose_sync_test")("api.pose_capture_sync")


class FakeRequest:
    def __init__(self, data):
        self._data = data
        self.headers = {"Content-Length": str(len(json.dumps(data)))}
        self.can_read_body = True

    async def json(self):
        return self._data


class PoseSyncTests(unittest.TestCase):
    def test_chunked_capture_and_sync_error_obey_body_limits(self):
        async def upload(raw, client_limit=1024, *, chunked=True):
            stream = StreamReader(unittest.mock.Mock(_reading_paused=False), 1024)
            stream.feed_data(raw[:8])
            stream.feed_data(raw[8:])
            stream.feed_eof()
            framing = {"Transfer-Encoding": "chunked"} if chunked else {"Content-Length": str(len(raw))}
            request = make_mocked_request(
                "POST", "/api/vnccs/pose_sync/upload_capture",
                headers={**framing, "Content-Type": "application/json"},
                payload=stream, client_max_size=client_limit,
            )
            return await POSE_SYNC.upload_pose_sync(request)

        with tempfile.TemporaryDirectory() as root, patch.dict(sys.modules, {
            "folder_paths": types.SimpleNamespace(get_temp_directory=lambda: root),
        }):
            path = Path(root) / "vnccs_debug_42.json"
            for payload in (
                {"node_id": "42", "captured_images": ["data:image/png;base64,example"]},
                {"node_id": "42", "sync_token": "run-1", "sync_error": "Capture failed"},
            ):
                with self.subTest(payload=payload):
                    raw = json.dumps(payload).encode()
                    with patch.object(POSE_SYNC, "MAX_SYNC_CAPTURE_CHARS", len(raw)):
                        self.assertEqual(asyncio.run(upload(raw)).status, 200)
                        self.assertEqual(json.loads(path.read_text()), payload)
                        self.assertEqual(asyncio.run(upload(raw + b" ")).status, 413)
                        for chunked in (True, False):
                            with self.subTest(chunked=chunked):
                                response = asyncio.run(upload(raw, client_limit=len(raw) - 1, chunked=chunked))
                                self.assertEqual(response.status, 413)
                                self.assertEqual(json.loads(response.body), {"error": "capture payload is too large"})
                        self.assertEqual(json.loads(path.read_text()), payload)

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

    def test_startup_registers_current_and_legacy_routes(self):
        package = "vnccs_pose_sync_startup_test"
        service_package(package)
        spec = spec_from_file_location(package, ROOT / "__init__.py")
        extension = module_from_spec(spec)
        app = web.Application()
        server = types.SimpleNamespace(app=app, routes=web.RouteTableDef())
        # Keep the HTTP modules real while stubbing the model-backed node imports.
        stubs = {f"{package}.{name}": unittest.mock.Mock() for name in (
            "nodes.vnccs_nodes", "nodes.vnccs_bbox_extractor", "nodes.pose_studio",
            "nodes.pose_library_creator", "nodes.vncss_config", "nodes.factory3d.render",
            "vnccs_sam3d.pose_import", "api.factory3d_scene_editor",
        )}
        unicanvas = sys.modules[f"{package}.nodes.unicanvas"]
        unicanvas.VNCCS_UniCanvas = object()
        unicanvas.register_unicanvas_routes = unittest.mock.Mock()
        sys.modules[f"{package}.nodes.factory3d"].VNCCS_3DFactory = object()
        with tempfile.TemporaryDirectory() as root, stub_imports({
            **stubs,
            package: extension,
            "server": types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=server)),
            "folder_paths": types.SimpleNamespace(get_temp_directory=lambda: root, get_user_directory=lambda: root),
        }):
            spec.loader.exec_module(extension)

        handler = sys.modules[f"{package}.api.pose_capture_sync"].upload_pose_sync
        self.assertEqual(
            [route.resource.canonical for route in app.router.routes() if route.method == "POST" and route.handler is handler],
            ["/vnccs/pose_sync/upload_capture", "/api/vnccs/pose_sync/upload_capture", "/vnccs/debug/upload_capture"],
        )

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
