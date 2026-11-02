import base64
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path

import numpy as np
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


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


POSE_STUDIO = _load("pose_studio", ROOT / "nodes" / "pose_studio.py")
APPLY = _load("apply_crop_guide", ROOT / "nodes" / "apply_crop_guide.py")
CROP = sys.modules["vnccs_pose_crop_testpkg.nodes.posestudio.crop_guide"]
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
         editor_mode="image", interface_mode="studio", key="captured_crop_guides", mutate=None):
    arrays = [_capture(index) for index in range(len(guides))]
    data = {
        "export": {
            "view_width": WIDTH, "view_height": HEIGHT, "output_mode": output_mode, "grid_columns": 2,
            "editor_mode": editor_mode, "interface_mode": interface_mode, "crop_outputs": list(outputs),
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
        import re
        names = tuple(re.findall(r'name: "(\w+)"', block))
        self.assertEqual(names, CROP.POSE_CROP_GUIDE_OUTPUTS)
        self.assertEqual(POSE_STUDIO.VNCCS_PoseStudio.RETURN_NAMES[8:11], names)
        self.assertEqual(POSE_STUDIO.VNCCS_PoseStudio.RETURN_TYPES[8:11], ("STRING", "IMAGE", "IMAGE"))


class PoseStudioCropOutputTests(unittest.TestCase):
    def test_images_stay_full_and_crops_match_crop_json(self):
        guides = [_guide(0.25, 0.1, 0.5, 0.6), _guide(0.0, 0.5, 0.35, 0.5)]
        node, result, arrays = _run(guides)
        self.assertEqual(len(result), 13)
        self.assertEqual(node.OUTPUT_IS_LIST, (True,) * 13)
        images, _prompts = result[0], result[1]
        crop_json, crop_images, previews = result[8:11]
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
        crop_json, crops, previews = result[8:11]
        for index in range(2):
            self.assertFalse(json.loads(crop_json[index])["enabled"])
            self.assertIs(crops[index], result[0][index])
            self.assertIs(previews[index], result[0][index])
        # A payload without captured_crop_guides uses the per-tab crop_guides.
        _node, result, arrays = _run([_guide(0.5, 0.5, 0.5, 0.5), _guide(0, 0, 0.5, 0.5)], key="crop_guides")
        self.assertEqual(json.loads(result[8][1])["pixel_rect"], {"x": 0, "y": 0, "width": 20, "height": 15})
        self.assertEqual(tuple(result[9][0].shape), (1, 15, 20, 3))
        # ...except in Debug Mode, whose single image is a library pose, not a tab.
        _node, result, _arrays = _run([_guide(0.5, 0.5, 0.5, 0.5)], key="crop_guides",
                                      mutate=lambda data: data["export"].update(debugMode=True))
        self.assertFalse(json.loads(result[8][0])["enabled"])

    def test_unlinked_preview_is_a_placeholder_and_crop_image_never_copies_the_source(self):
        _node, result, arrays = _run([_guide(0.25, 0.25, 0.5, 0.5)], outputs=())
        self.assertEqual(float(result[10][0].max()), 0.0)
        self.assertEqual(tuple(result[10][0].shape), (1, HEIGHT, WIDTH, 3))
        before = result[0][0].clone()
        result[9][0].fill_(1.0)
        torch.testing.assert_close(result[0][0], before, msg="crop_image is a copy; images stay intact")

    def test_debug_guides_without_tab_index(self):
        _node, result, _arrays = _run([_guide(0.25, 0.25, 0.5, 0.5)],
                                      mutate=lambda data: data["captured_crop_guides"][0].update(pose_index=None))
        self.assertIsNone(json.loads(result[8][0])["pose_index"])

    def test_unsupported_modes_never_apply_a_rectangle(self):
        guides = [_guide(0.25, 0.25, 0.5, 0.5)] * 3
        for kwargs, reason in (({"output_mode": "GRID"}, "GRID output"),
                               ({"interface_mode": "manager"}, "Pose Manager"),
                               ({"editor_mode": "animation",
                                 "mutate": lambda data: data["export"].update(animation_image_batch=True)},
                                "Animation mode")):
            with self.assertRaisesRegex(RuntimeError, reason):
                _run(guides, **kwargs)
            node, result, _arrays = _run(guides, outputs=(), **kwargs)
            self.assertEqual(len(result), 13)
            for text in result[8]:
                record = json.loads(text)
                self.assertFalse(record["enabled"])
                self.assertEqual(record["unsupported"], reason)
            for tensor in result[9] + result[10]:
                self.assertEqual(float(tensor.max()), 0.0)
        _node, result, _arrays = _run(guides, outputs=(), output_mode="GRID")
        self.assertEqual(tuple(result[9][0].shape), tuple(result[0][0].shape), "GRID placeholders match the grid")


class ApplyCropGuideTests(unittest.TestCase):
    def setUp(self):
        self.node = APPLY.VNCCS_ApplyCropGuide()
        self.source = torch.from_numpy(_capture(0, 80, 60).astype(np.float32) / 255).unsqueeze(0)
        self.record = CROP.build_crop_json(_guide(0.25, 0.2, 0.5, 0.5), 80, 60, 0)
        self.text = json.dumps(self.record)

    def apply(self, images, texts, mode=None):
        return self.node.apply(images, texts, None if mode is None else [mode])[0]

    def test_same_resolution_equals_pose_studio_crop(self):
        before = self.source.clone()
        (crop,) = self.apply([self.source], [self.text])
        rect = self.record["pixel_rect"]
        torch.testing.assert_close(crop, CROP.crop_image(self.source, rect))
        self.assertEqual(tuple(crop.shape), (1, 30, 40, 3))
        torch.testing.assert_close(self.source, before, msg="source pixels are never modified")

    def test_resized_generation_crops_the_same_region_without_interpolation(self):
        # A 2x nearest-neighbour "generation" of the source: the crop is the 2x crop exactly.
        generated = self.source.repeat_interleave(2, dim=1).repeat_interleave(2, dim=2)
        (crop,) = self.apply([generated], [self.text])
        (small,) = self.apply([self.source], [self.text])
        self.assertEqual(tuple(crop.shape), (1, 60, 80, 3))
        torch.testing.assert_close(crop, small.repeat_interleave(2, dim=1).repeat_interleave(2, dim=2))
        # Arbitrary different resolution: the same normalized rectangle with floor/ceil rounding.
        odd = torch.rand(1, 45, 60, 3)
        (crop,) = self.apply([odd], [self.text])
        rect = CROP.crop_pixel_rect(self.record["rect"], 60, 45)
        self.assertEqual(rect, {"x": 15, "y": 9, "width": 30, "height": 23})
        torch.testing.assert_close(crop, odd[:, 9:32, 15:45, :])

    def test_letterboxed_results_are_refused_unless_stretch_is_chosen(self):
        letterboxed = torch.zeros(1, 80, 80, 3)
        with self.assertRaisesRegex(ValueError, "aspect ratios differ"):
            self.apply([letterboxed], [self.text])
        (crop,) = self.apply([letterboxed], [self.text], "stretch")
        self.assertEqual(tuple(crop.shape), (1, 40, 40, 3))

    def test_disabled_guide_returns_the_image_unchanged(self):
        text = json.dumps(CROP.build_crop_json(_guide(0.25, 0.2, 0.5, 0.5, enabled=False), 80, 60))
        (image,) = self.apply([self.source], [text])
        self.assertIs(image, self.source)

    def test_invalid_crop_json_errors_are_clear(self):
        cases = {
            "": "empty",
            "{": "not valid JSON",
            "[]": "JSON object",
            json.dumps({**self.record, "schema_version": 2}): "newer than this node supports",
            json.dumps({**self.record, "schema_version": "1"}): "schema_version",
            json.dumps({**self.record, "enabled": "yes"}): "enabled must be true or false",
            json.dumps({**self.record, "rect": {"x": 0.8, "y": 0, "width": 0.5, "height": 0.5}}): "inside the image",
            json.dumps({**self.record, "rect": {"x": -0.1, "y": 0, "width": 0.5, "height": 0.5}}): "inside the image",
            json.dumps({**self.record, "rect": {"x": 0, "y": 0, "width": 0, "height": 0.5}}): "inside the image",
            json.dumps({**self.record, "rect": {"x": "0", "y": 0, "width": 0.5, "height": 0.5}}): "finite number",
            json.dumps({**self.record, "source": {"width": 0, "height": 5}}): "source",
            json.dumps({**self.record, "coordinate_system": "bottom_left"}): "coordinate_system",
        }
        for text, message in cases.items():
            with self.assertRaisesRegex(ValueError, message, msg=text):
                self.apply([self.source], [text])
        nan = self.text.replace('"x": 0.25', '"x": NaN')
        with self.assertRaisesRegex(ValueError, "finite number"):
            self.apply([self.source], [nan])

    def test_lists_keep_pose_correspondence_and_never_stack_different_sizes(self):
        guides = [_guide(0, 0, 0.5, 0.5), _guide(0.5, 0.5, 0.25, 0.25), _guide(0, 0, 1, 1)]
        texts = [json.dumps(CROP.build_crop_json(guide, 80, 60, index)) for index, guide in enumerate(guides)]
        images = [self.source * (index + 1) / 3 for index in range(3)]
        crops = self.apply(images, texts)
        self.assertEqual([tuple(crop.shape) for crop in crops], [(1, 30, 40, 3), (1, 15, 20, 3), (1, 60, 80, 3)])
        torch.testing.assert_close(crops[1], images[1][:, 30:45, 40:60, :])
        # One batch with one image per pose is split in pose order.
        batch = torch.cat(images, dim=0)
        split = self.apply([batch], texts)
        for crop, expected in zip(split, crops):
            torch.testing.assert_close(crop, expected)
        # One crop_json applies to every image and keeps each batch together.
        same = self.apply([batch, self.source], [texts[1]])
        self.assertEqual([tuple(crop.shape) for crop in same], [(3, 15, 20, 3), (1, 15, 20, 3)])
        with self.assertRaisesRegex(ValueError, "2 image item"):
            self.apply([self.source, self.source], texts)
        with self.assertRaisesRegex(ValueError, "aspect_mismatch"):
            self.apply([self.source], [self.text], "squash")

    def test_pose_studio_output_feeds_apply_crop_guide(self):
        guides = [_guide(0.1, 0.2, 0.4, 0.5), _guide(0.5, 0.0, 0.5, 1.0)]
        _node, result, arrays = _run(guides)
        images, crop_json, crop_images = result[0], result[8], result[9]
        direct = self.node.apply(images, crop_json)[0]
        for crop, expected in zip(direct, crop_images):
            torch.testing.assert_close(crop, expected)
        # The same crop_json crops a resized "generated" copy of each image at its own resolution.
        generated = [image.repeat_interleave(3, dim=1).repeat_interleave(3, dim=2) for image in images]
        cropped = self.node.apply(generated, crop_json)[0]
        for crop, expected in zip(cropped, crop_images):
            torch.testing.assert_close(crop, expected.repeat_interleave(3, dim=1).repeat_interleave(3, dim=2))


if __name__ == "__main__":
    unittest.main()
