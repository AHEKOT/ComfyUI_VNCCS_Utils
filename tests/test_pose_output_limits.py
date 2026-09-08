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
    def test_animation_image_batch_is_one_batched_image_value(self):
        node = POSE_STUDIO.VNCCS_PoseStudio()
        images = [Image.new("RGB", (2, 3)), Image.new("RGB", (2, 3))]
        batch = object()
        stack_calls = []
        original_decode = POSE_STUDIO._decode_captured_images
        original_from_numpy = getattr(POSE_STUDIO.torch, "from_numpy", None)
        original_stack = getattr(POSE_STUDIO.torch, "stack", None)
        original_create_video = POSE_STUDIO._create_comfy_video
        POSE_STUDIO._decode_captured_images = lambda _captures: images
        POSE_STUDIO.torch.from_numpy = lambda array: array
        POSE_STUDIO.torch.stack = lambda tensors, dim=0: (
            stack_calls.append((tensors, dim)) or batch
        )
        POSE_STUDIO._create_comfy_video = lambda *_args: self.fail(
            "image-batch mode must not create a VIDEO"
        )
        try:
            result = node.generate(json.dumps({
                "export": {
                    "editor_mode": "animation",
                    "view_width": 2,
                    "view_height": 3,
                },
                "captured_images": ["frame-1", "frame-2"],
                "lighting_prompts": ["first", "second"],
            }), animation_image_batch=True)
        finally:
            POSE_STUDIO._decode_captured_images = original_decode
            if original_from_numpy is None:
                del POSE_STUDIO.torch.from_numpy
            else:
                POSE_STUDIO.torch.from_numpy = original_from_numpy
            if original_stack is None:
                del POSE_STUDIO.torch.stack
            else:
                POSE_STUDIO.torch.stack = original_stack
            POSE_STUDIO._create_comfy_video = original_create_video

        self.assertEqual(len(stack_calls), 1)
        self.assertEqual(stack_calls[0][1], 0)
        self.assertEqual(len(stack_calls[0][0]), 2)
        self.assertIs(result[0], batch)
        self.assertEqual(result[1], ["first", "second"])
        self.assertEqual(node.OUTPUT_IS_LIST, (False, True))

    def test_pose_image_dimensions_use_comfyui_height_width_order(self):
        image = types.SimpleNamespace(shape=(1, 768, 1344, 3))
        self.assertEqual(POSE_STUDIO._pose_image_dimensions(image), (1344, 768))

    def test_pose_image_dimensions_reject_unsupported_capture_size(self):
        image = types.SimpleNamespace(shape=(1, 4097, 1, 3))
        with self.assertRaisesRegex(ValueError, "up to 4096 x 4096"):
            POSE_STUDIO._pose_image_dimensions(image)

    def test_capture_image_size_is_forwarded_only_when_enabled(self):
        image = types.SimpleNamespace(shape=(1, 768, 1344, 3))
        calls = []
        node = POSE_STUDIO.VNCCS_PoseStudio()
        node._apply_pose_image_via_frontend = lambda *args: calls.append(args)

        with self.assertRaisesRegex(RuntimeError, "did not receive images"):
            node.generate(json.dumps({"export": {"capture_image_size": True}}), pose_image=image)
        self.assertEqual(calls[-1][4], (1344, 768))

        with self.assertRaisesRegex(RuntimeError, "did not receive images"):
            node.generate(json.dumps({"export": {"capture_image_size": False}}), pose_image=image)
        self.assertIsNone(calls[-1][4])

    def test_pose_image_analysis_mode_isolated_to_pose_manager(self):
        self.assertEqual(POSE_STUDIO._pose_image_analysis_mode({}), "pose")
        self.assertEqual(
            POSE_STUDIO._pose_image_analysis_mode({"export": {"interface_mode": "studio"}}),
            "pose",
        )
        self.assertEqual(
            POSE_STUDIO._pose_image_analysis_mode({"export": {"interface_mode": "manager"}}),
            "manager_proportions",
        )
        self.assertIsNone(
            POSE_STUDIO._pose_image_analysis_mode({
                "export": {
                    "interface_mode": "manager",
                    "manager_auto_analyze_proportions": False,
                },
            }),
        )

    def test_disabled_manager_analysis_never_calls_sam_frontend_path(self):
        node = POSE_STUDIO.VNCCS_PoseStudio()
        calls = []
        node._apply_pose_image_via_frontend = lambda *_args, **_kwargs: calls.append(True)
        state = {
            "export": {
                "interface_mode": "manager",
                "manager_auto_analyze_proportions": False,
            },
        }

        with self.assertRaisesRegex(RuntimeError, "did not receive images"):
            node.generate(json.dumps(state), pose_image=object())
        self.assertEqual(calls, [])

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
