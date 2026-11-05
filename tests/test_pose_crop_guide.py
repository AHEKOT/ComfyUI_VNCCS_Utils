import base64
import importlib.util
import io
import json
import re
import sys
import types
import unittest
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
torch = None
POSE_STUDIO = None


def _load_crop_guide():
    """nodes/posestudio/crop_guide.py is pure Python: these tests run without PyTorch."""
    name = "vnccs_pose_crop_logic"
    spec = importlib.util.spec_from_file_location(name, ROOT / "nodes" / "posestudio" / "crop_guide.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load(module, path):
    package = types.ModuleType("vnccs_pose_crop_testpkg")
    package.__path__ = [str(ROOT)]
    nodes_package = types.ModuleType("vnccs_pose_crop_testpkg.nodes")
    nodes_package.__path__ = [str(ROOT / "nodes")]
    sys.modules.setdefault(package.__name__, package)
    sys.modules.setdefault(nodes_package.__name__, nodes_package)
    name = f"vnccs_pose_crop_testpkg.nodes.{module}"
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


def _require_node():
    """Tensor-dependent node tests are skipped where CI does not install PyTorch."""
    global torch, POSE_STUDIO
    torch = pytest.importorskip("torch")
    if POSE_STUDIO is None:
        POSE_STUDIO = _load("pose_studio", ROOT / "nodes" / "pose_studio.py")


CROP = _load_crop_guide()
CASES = json.loads((ROOT / "tests" / "fixtures" / "crop_guide_cases.json").read_text(encoding="utf-8"))
WIDTH, HEIGHT = 40, 30


def _png(array):
    encoded = io.BytesIO()
    Image.fromarray(np.asarray(array, dtype=np.uint8)).save(encoded, format="PNG")
    return "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")


def _capture(index, width=WIDTH, height=HEIGHT):
    """Every pixel encodes its own position, so any crop can be checked exactly."""
    ys, xs = np.mgrid[0:height, 0:width]
    return np.stack([xs * 5 % 256, ys * 7 % 256, np.full_like(xs, 10 + index)], axis=-1).astype(np.uint8)


def _guide(x, y, w, h, enabled=True, **extra):
    return {"schema_version": 1, "enabled": enabled, "x": x, "y": y, "width": w, "height": h, **extra}


def _run(guides, outputs=("crop_json", "crop_image", "crop_preview"), output_mode="LIST",
         editor_mode="image", interface_mode="studio", key="captured_crop_guides", mutate=None, linked=None):
    _require_node()
    arrays = [_capture(index) for index in range(len(guides))]
    data = {
        "export": {
            "view_width": WIDTH, "view_height": HEIGHT, "output_mode": output_mode, "grid_columns": 2,
            "editor_mode": editor_mode, "interface_mode": interface_mode, "additional_outputs": list(outputs),
            "linked_additional_outputs": list(outputs if linked is None else linked),
        },
        "captured_images": [_png(array) for array in arrays],
        "lighting_prompts": ["" for _ in arrays],
        key: [dict(guide, pose_index=index) if guide is not None and key == "captured_crop_guides" else guide
              for index, guide in enumerate(guides)],
    }
    if mutate:
        mutate(data)
    node = POSE_STUDIO.VNCCS_PoseStudio()
    return node, node.generate(json.dumps(data)), arrays


def _uint8(tensor):
    return (tensor[0].numpy() * 255).round().astype(np.uint8)


class CropGuideCoordinateTests(unittest.TestCase):
    def test_pixel_rects_match_the_shared_fixture(self):
        for item in CASES["pixel_rects"]:
            x, y, w, h = item["rect"]
            rect = CROP.crop_pixel_rect({"x": x, "y": y, "width": w, "height": h}, *item["size"])
            self.assertEqual([rect["x"], rect["y"], rect["width"], rect["height"]], item["expected"], item["name"])

    def test_normalization_matches_the_shared_fixture(self):
        for item in CASES["normalize"]:
            guide = CROP.normalize_crop_guide(item["input"])
            for key, value in item["expected"].items():
                self.assertEqual(guide[key], value, f"{item['name']}: {key}")
        for bad in (float("nan"), float("inf"), float("-inf")):
            guide = CROP.normalize_crop_guide(_guide(0.1, 0.1, bad, 0.5))
            self.assertFalse(guide["enabled"])

    def test_build_crop_json_matches_the_widget_record(self):
        record = CROP.build_crop_json(_guide(0.1, 0.2, 0.3, 0.4, aspect_ratio="custom", custom_aspect_ratio=[2, 3]),
                                      1280, 720, 4)
        self.assertEqual(list(record), [
            "schema_version", "type", "enabled", "coordinate_system", "source", "rect", "pixel_rect",
            "aspect_ratio", "aspect_ratio_value", "aspect_ratio_locked", "pose_index", "custom_aspect_ratio",
        ])
        self.assertEqual(record["pixel_rect"], {"x": 128, "y": 144, "width": 384, "height": 288})
        self.assertEqual(record["source"], {"width": 1280, "height": 720})
        self.assertAlmostEqual(record["aspect_ratio_value"], 2 / 3)
        self.assertTrue(record["aspect_ratio_locked"])
        self.assertEqual(json.loads(json.dumps(record)), record, "JSON round trip is exact")

    def test_widget_output_names_match(self):
        source = (ROOT / "web" / "pose_studio" / "crop_guide.mjs").read_text(encoding="utf-8")
        block = source[source.index("POSE_CROP_GUIDE_OUTPUTS = Object.freeze(["):]
        block = block[:block.index("]);")]
        names = tuple(re.findall(r'name: "(\w+)"', block))
        self.assertEqual(names, CROP.POSE_CROP_GUIDE_OUTPUTS)
        self.assertEqual(tuple(re.findall(r'type: "(\w+)"', block)), ("STRING", "IMAGE", "IMAGE"))


class PoseStudioCropOutputTests(unittest.TestCase):
    def test_images_stay_full_and_crops_match_crop_json(self):
        guides = [_guide(0.25, 0.1, 0.5, 0.6), _guide(0.0, 0.5, 0.35, 0.5)]
        node, result, arrays = _run(guides)
        self.assertEqual(len(result), 13)
        self.assertEqual(node.OUTPUT_IS_LIST, (True,) * 13)
        images, _prompts = result[0], result[1]
        crop_json, crop_images, previews = result[2:5]
        self.assertEqual(len(crop_json), len(images))
        for index, (image, text, crop, preview) in enumerate(zip(images, crop_json, crop_images, previews)):
            self.assertEqual(tuple(image.shape), (1, HEIGHT, WIDTH, 3), "images are never cropped")
            np.testing.assert_array_equal(_uint8(image), arrays[index])
            record = json.loads(text)
            self.assertEqual(record["pose_index"], index)
            self.assertEqual(record["source"], {"width": WIDTH, "height": HEIGHT})
            rect = record["pixel_rect"]
            self.assertEqual(rect, CROP.crop_pixel_rect(record["rect"], WIDTH, HEIGHT))
            expected = arrays[index][rect["y"]:rect["y"] + rect["height"], rect["x"]:rect["x"] + rect["width"]]
            self.assertEqual(tuple(crop.shape), (1, rect["height"], rect["width"], 3))
            np.testing.assert_array_equal(_uint8(crop), expected, "crop_image is exactly the pixel_rect")
            # crop_preview: the full image with the outside dimmed and the border inside the crop.
            self.assertEqual(tuple(preview.shape), tuple(image.shape))
            pixels = _uint8(preview)
            color = (np.array(CROP.CROP_PREVIEW_COLOR) * 255).round().astype(np.uint8)
            x, y, w, h = rect["x"], rect["y"], rect["width"], rect["height"]
            for px, py in ((x, y), (x + w - 1, y), (x, y + h - 1), (x + w - 1, y + h - 1), (x + w // 2, y)):
                np.testing.assert_array_equal(pixels[py, px], color, f"border pixel {px},{py}")
            np.testing.assert_array_equal(pixels[y + h // 2, x + w // 2], arrays[index][y + h // 2, x + w // 2])
            outside = [(px, py) for px, py in ((0, 0), (WIDTH - 1, HEIGHT - 1), (WIDTH - 1, 0), (0, HEIGHT - 1))
                       if not (x <= px < x + w and y <= py < y + h)]
            self.assertTrue(outside)
            for px, py in outside:
                np.testing.assert_allclose(preview[0, py, px].numpy(), image[0, py, px].numpy() * CROP.CROP_PREVIEW_DIM,
                                           atol=1e-6)
            self.assertFalse(np.array_equal(_uint8(image), pixels), "the preview is a copy")

    def test_disabled_guides_pass_the_full_image_and_old_payloads_fall_back(self):
        _node, result, arrays = _run([_guide(0.1, 0.1, 0.2, 0.2, enabled=False), None])
        crop_json, crops, previews = result[2:5]
        for index in range(2):
            self.assertFalse(json.loads(crop_json[index])["enabled"])
            self.assertIs(crops[index], result[0][index])
            self.assertIs(previews[index], result[0][index])
        # A payload without captured_crop_guides uses the per-tab crop_guides.
        _node, result, arrays = _run([_guide(0.5, 0.5, 0.5, 0.5), _guide(0, 0, 0.5, 0.5)], key="crop_guides")
        self.assertEqual(json.loads(result[2][1])["pixel_rect"], {"x": 0, "y": 0, "width": 20, "height": 15})
        self.assertEqual(tuple(result[3][0].shape), (1, 15, 20, 3))
        # ...except in Debug Mode, whose single image is a library pose, not a tab.
        _node, result, _arrays = _run([_guide(0.5, 0.5, 0.5, 0.5)], key="crop_guides",
                                      mutate=lambda data: data["export"].update(debugMode=True))
        self.assertFalse(json.loads(result[2][0])["enabled"])

    def test_crop_image_is_a_copy_and_images_stay_intact(self):
        _node, result, _arrays = _run([_guide(0.25, 0.25, 0.5, 0.5)])
        before = result[0][0].clone()
        result[3][0].fill_(1.0)
        torch.testing.assert_close(result[0][0], before, msg="crop_image is a copy; images stay intact")

    def test_outputs_without_a_link_copy_and_draw_nothing(self):
        _require_node()
        calls = []
        original_crop, original_preview = POSE_STUDIO.crop_image, POSE_STUDIO.draw_crop_preview
        POSE_STUDIO.crop_image = lambda *args: calls.append("crop") or original_crop(*args)
        POSE_STUDIO.draw_crop_preview = lambda *args: calls.append("preview") or original_preview(*args)
        try:
            guides = [_guide(0, 0, 1, 1)] * 4
            # Enabled, not connected: this is the full-frame crop a run must not pay for.
            _node, result, _arrays = _run(guides, linked=())
            self.assertEqual(calls, [])
            self.assertEqual(list(result[2:5]), [[], [], []])
            # Only crop_json connected: still no image work.
            _node, result, _arrays = _run(guides, linked=("crop_json",))
            self.assertEqual(calls, [])
            self.assertEqual(len(result[2]), 4)
            self.assertEqual(list(result[3:5]), [[], []])
            # Disabled: no slot is filled, and guides are not even read.
            _node, result, _arrays = _run(guides, outputs=(), mutate=lambda data: data.pop("captured_crop_guides"))
            self.assertEqual(calls, [])
            # Connected: exactly one crop per image.
            _run(guides, outputs=("crop_image",))
            self.assertEqual(calls, ["crop"] * 4)
        finally:
            POSE_STUDIO.crop_image, POSE_STUDIO.draw_crop_preview = original_crop, original_preview

    def test_slots_follow_the_enabled_order(self):
        _node, result, _arrays = _run([_guide(0.25, 0.25, 0.5, 0.5)], outputs=("crop_image", "crop_json"))
        record = json.loads(result[3][0])
        self.assertTrue(record["enabled"])
        rect = record["pixel_rect"]
        self.assertEqual(tuple(result[2][0].shape), (1, rect["height"], rect["width"], 3))

    def test_debug_guides_without_tab_index(self):
        _node, result, _arrays = _run([_guide(0.25, 0.25, 0.5, 0.5)],
                                      mutate=lambda data: data["captured_crop_guides"][0].update(pose_index=None))
        self.assertIsNone(json.loads(result[2][0])["pose_index"])

    def test_unsupported_modes_never_apply_a_rectangle(self):
        guides = [_guide(0.25, 0.25, 0.5, 0.5)] * 3
        for kwargs, reason in (({"output_mode": "GRID"}, "GRID output"),
                               ({"interface_mode": "manager"}, "Pose Manager"),
                               ({"editor_mode": "animation",
                                 "mutate": lambda data: data["export"].update(animation_image_batch=True)},
                                "Image mode")):
            with self.assertRaisesRegex(RuntimeError, reason):
                _run(guides, **kwargs)
            # Enabled without a link: the run goes on and the slots stay empty.
            node, result, _arrays = _run(guides, linked=(), **kwargs)
            self.assertEqual(len(result), len(node.RETURN_TYPES))
            self.assertEqual(list(result[2:5]), [[], [], []])


if __name__ == "__main__":
    unittest.main()
