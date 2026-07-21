import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


def _load_pose_studio_module():
    fake_torch = types.ModuleType("torch")
    fake_torch.Tensor = object
    previous_torch = sys.modules.get("torch")
    package = types.ModuleType("vnccs_pose_limit_testpkg")
    package.__path__ = [str(ROOT)]
    nodes_package = types.ModuleType("vnccs_pose_limit_testpkg.nodes")
    nodes_package.__path__ = [str(ROOT / "nodes")]
    sys.modules["torch"] = fake_torch
    sys.modules[package.__name__] = package
    sys.modules[nodes_package.__name__] = nodes_package
    try:
        name = "vnccs_pose_limit_testpkg.nodes.pose_studio"
        spec = importlib.util.spec_from_file_location(name, ROOT / "nodes" / "pose_studio.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        if previous_torch is None:
            sys.modules.pop("torch", None)
        else:
            sys.modules["torch"] = previous_torch


POSE_STUDIO = _load_pose_studio_module()


class PoseOutputLimitTests(unittest.TestCase):
    def test_generate_rejects_oversized_view_before_rendering(self):
        state = {
            "export": {"view_width": POSE_STUDIO._POSE_OUTPUT_MAX_PIXELS + 1, "view_height": 1},
            "poses": [{}],
        }

        with self.assertRaisesRegex(ValueError, "dimensions are too large"):
            POSE_STUDIO.VNCCS_PoseStudio().generate(json.dumps(state))

    def test_grid_columns_must_be_positive(self):
        with self.assertRaisesRegex(ValueError, "positive integer"):
            POSE_STUDIO.VNCCS_PoseStudio()._make_grid([Image.new("RGB", (1, 1))], 0)

    def test_grid_total_pixels_are_limited(self):
        fake_image = types.SimpleNamespace(size=(4096, 4096))

        with self.assertRaisesRegex(ValueError, "grid dimensions are too large"):
            POSE_STUDIO.VNCCS_PoseStudio()._make_grid([fake_image, fake_image], 2)

    def test_generate_requires_widget_capture_without_backend_renderer(self):
        with self.assertRaisesRegex(RuntimeError, "Backend 3D rendering has been removed"):
            POSE_STUDIO.VNCCS_PoseStudio().generate("{}")

    def test_frontend_sync_error_marker_fails_without_waiting_for_stale_data(self):
        node = POSE_STUDIO.VNCCS_PoseStudio()
        node._wait_for_frontend_sync = lambda *_args, **_kwargs: {"sync_error": "payload rejected"}
        server_module = types.ModuleType("server")
        server_module.PromptServer = types.SimpleNamespace(
            instance=types.SimpleNamespace(send_sync=lambda *_args, **_kwargs: None),
        )
        previous_server = sys.modules.get("server")
        sys.modules["server"] = server_module
        try:
            with self.assertRaisesRegex(RuntimeError, "frontend sync failed: payload rejected"):
                node.generate("{}", unique_id="42")
        finally:
            if previous_server is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = previous_server


if __name__ == "__main__":
    unittest.main()
