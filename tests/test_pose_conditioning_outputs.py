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
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def _load_pose_studio_module():
    package = types.ModuleType("vnccs_pose_conditioning_testpkg")
    package.__path__ = [str(ROOT)]
    nodes_package = types.ModuleType("vnccs_pose_conditioning_testpkg.nodes")
    nodes_package.__path__ = [str(ROOT / "nodes")]
    sys.modules[package.__name__] = package
    sys.modules[nodes_package.__name__] = nodes_package
    name = "vnccs_pose_conditioning_testpkg.nodes.pose_studio"
    spec = importlib.util.spec_from_file_location(name, ROOT / "nodes" / "pose_studio.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


POSE_STUDIO = _load_pose_studio_module()
CONDITIONING = sys.modules["vnccs_pose_conditioning_testpkg.nodes.posestudio.conditioning"]
ALL_OUTPUTS = list(CONDITIONING.POSE_CONDITIONING_OUTPUTS)
WIDTH, HEIGHT = 6, 4


def _png(array):
    encoded = io.BytesIO()
    Image.fromarray(np.asarray(array, dtype=np.uint8)).save(encoded, format="PNG")
    return "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")


def _pose(index):
    """One RGB capture and its passes: Character 1 on the left, Character 2 on the right."""
    rgb = np.full((HEIGHT, WIDTH, 3), 40, dtype=np.uint8)
    ids = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    ids[1:3, 1:3] = (255, 0, 0)
    ids[1:3, 3:5] = (0, 255, 0)
    rgb[ids.any(axis=-1)] = 200 + index
    depth = np.where(ids.any(axis=-1, keepdims=True), 100 + index, 0).repeat(3, axis=2)
    normal = np.where(ids.any(axis=-1, keepdims=True), (128, 128, 255), 0).astype(np.uint8)
    outline = np.zeros_like(ids)
    outline[1, 1:5] = 255
    return _png(rgb), {
        "depth": _png(depth), "normal": _png(normal),
        "outline": _png(outline), "character_id": _png(ids),
    }, ids


def _run(count=2, outputs=ALL_OUTPUTS, output_mode="LIST", editor_mode="image", conditioning=True, mutate=None):
    poses = [_pose(index) for index in range(count)]
    data = {
        "export": {
            "view_width": WIDTH, "view_height": HEIGHT, "output_mode": output_mode,
            "grid_columns": 2, "editor_mode": editor_mode,
        },
        "captured_images": [rgb for rgb, _passes, _ids in poses],
        "lighting_prompts": ["" for _ in poses],
    }
    if outputs:
        data["export"]["conditioning_outputs"] = list(outputs)
    if conditioning:
        data["captured_conditioning"] = [passes for _rgb, passes, _ids in poses]
    if mutate:
        mutate(data)
    node = POSE_STUDIO.VNCCS_PoseStudio()
    return node, node.generate(json.dumps(data)), [ids for _rgb, _passes, ids in poses]


class PoseConditioningOutputTests(unittest.TestCase):
    def test_outputs_are_appended_without_moving_existing_slots(self):
        node = POSE_STUDIO.VNCCS_PoseStudio
        self.assertEqual(node.RETURN_NAMES, (
            "images", "lighting_prompt", "depth", "normal", "outline", "silhouette", "mask", "character_id",
        ))
        self.assertEqual(node.RETURN_TYPES, (
            "IMAGE,VIDEO", "STRING", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "MASK", "IMAGE",
        ))
        self.assertEqual(node.OUTPUT_IS_LIST, (True,) * 8)

    def test_list_outputs_align_with_images_and_derive_silhouette_and_mask(self):
        _node, result, ids = _run()
        self.assertEqual(len(result), 8)
        images, prompts, depth, normal, outline, silhouette, mask, character_id = result
        self.assertEqual(len(images), 2)
        self.assertEqual(len(prompts), 2)
        for output in (depth, normal, outline, silhouette, character_id):
            self.assertEqual(len(output), 2)
            for index, tensor in enumerate(output):
                self.assertEqual(tuple(tensor.shape), tuple(images[index].shape))
        for index in range(2):
            coverage = ids[index].any(axis=-1)
            self.assertEqual(tuple(mask[index].shape), (1, HEIGHT, WIDTH))
            np.testing.assert_array_equal(mask[index][0].numpy(), coverage.astype(np.float32))
            np.testing.assert_array_equal(silhouette[index][0].numpy(), np.repeat(coverage[:, :, None], 3, 2).astype(np.float32))
            np.testing.assert_array_equal((character_id[index][0].numpy() * 255).round().astype(np.uint8), ids[index])
            self.assertAlmostEqual(float(depth[index][0, 1, 1, 0]), (100 + index) / 255, places=6)
            self.assertEqual(float(depth[index][0, 0, 0, 0]), 0.0)
            # The RGB image itself is unchanged by the auxiliary outputs.
            self.assertAlmostEqual(float(images[index][0, 1, 1, 0]), (200 + index) / 255, places=6)
            self.assertAlmostEqual(float(images[index][0, 0, 0, 0]), 40 / 255, places=6)

    def test_grid_outputs_share_the_rgb_grid_layout_on_black(self):
        _node, result, ids = _run(count=3, output_mode="GRID")
        images, prompts, depth, normal, outline, silhouette, mask, character_id = result
        self.assertEqual(len(images), 1)
        self.assertEqual(tuple(images[0].shape), (1, HEIGHT * 2, WIDTH * 2, 3))
        for output in (depth, normal, outline, silhouette, character_id):
            self.assertEqual(len(output), 1)
            self.assertEqual(tuple(output[0].shape), tuple(images[0].shape))
        self.assertEqual(tuple(mask[0].shape), (1, HEIGHT * 2, WIDTH * 2))
        grid_ids = (character_id[0][0].numpy() * 255).round().astype(np.uint8)
        np.testing.assert_array_equal(grid_ids[HEIGHT:, :WIDTH], ids[2])
        # The empty fourth cell is background (ID 0) in every auxiliary output.
        self.assertEqual(float(grid_ids[HEIGHT:, WIDTH:].max()), 0)
        self.assertEqual(float(mask[0][0, HEIGHT:, WIDTH:].max()), 0)
        # RGB keeps its own background colour for the empty cell.
        self.assertAlmostEqual(float(images[0][0, -1, -1, 0]), 40 / 255, places=6)
        rgb_coverage = images[0][0].numpy()[:, :, 0] > 0.5
        np.testing.assert_array_equal(mask[0][0].numpy() > 0, rgb_coverage)

    def test_unrequested_outputs_are_black_placeholders_matching_the_images(self):
        _node, result, _ids = _run(outputs=[], conditioning=False)
        images = result[0]
        for index, output in enumerate(result[2:]):
            self.assertEqual(len(output), len(images))
            for tensor, image in zip(output, images):
                expected = tuple(image.shape) if index != 4 else tuple(image.shape[:3])
                self.assertEqual(tuple(tensor.shape), expected)
                self.assertEqual(float(tensor.max()), 0.0)
        # Only requested outputs need passes; the others stay placeholders.
        _node, result, ids = _run(outputs=["mask"], mutate=lambda data: [
            item.pop(name) for item in data["captured_conditioning"] for name in ("depth", "normal", "outline")
        ])
        np.testing.assert_array_equal(result[6][0][0].numpy(), ids[0].any(axis=-1).astype(np.float32))
        self.assertEqual(float(result[2][0].max()), 0.0)

    def test_requested_outputs_without_passes_fail_instead_of_returning_black(self):
        with self.assertRaisesRegex(RuntimeError, "did not receive the auxiliary passes for depth"):
            _run(outputs=["depth"], conditioning=False)
        with self.assertRaisesRegex(RuntimeError, "auxiliary passes"):
            _run(outputs=["depth"], mutate=lambda data: data["captured_conditioning"].pop())

    def test_passes_must_match_the_rgb_resolution_and_the_id_palette(self):
        def resize(data):
            data["captured_conditioning"][1]["depth"] = _png(np.zeros((HEIGHT, WIDTH + 1, 3)))
        with self.assertRaisesRegex(ValueError, "matching its RGB capture"):
            _run(mutate=resize)

        def blend(data):
            ids = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
            ids[1, 1] = (128, 128, 0)  # an anti-aliased mix of two IDs
            data["captured_conditioning"][0]["character_id"] = _png(ids)
        with self.assertRaisesRegex(ValueError, "Character ID palette"):
            _run(mutate=blend)

    def test_animation_mode_refuses_linked_auxiliary_outputs(self):
        with self.assertRaisesRegex(RuntimeError, "Image mode"):
            _run(editor_mode="animation")

    def test_animation_outputs_keep_their_shape_with_placeholders(self):
        node, result, _ids = _run(count=2, outputs=[], conditioning=False, editor_mode="animation",
                                  mutate=lambda data: data["export"].update(animation_image_batch=True))
        self.assertEqual(tuple(result[0].shape), (2, HEIGHT, WIDTH, 3))
        self.assertEqual(node.OUTPUT_IS_LIST, (False,) + (True,) * 7)
        self.assertEqual(len(result), 8)

    def test_character_id_palette_matches_the_widget(self):
        source = (ROOT / "web" / "pose_studio" / "conditioning.mjs").read_text(encoding="utf-8")
        block = source[source.index("POSE_CHARACTER_ID_COLORS = Object.freeze(["):]
        block = block[:block.index("]);")]
        colors = tuple(tuple(int(value) for value in match.split(","))
                       for match in re.findall(r"\[(\d+, \d+, \d+)\]", block))
        self.assertEqual(colors, CONDITIONING.POSE_CHARACTER_ID_COLORS)
        names = re.findall(r'name: "(\w+)", type: "(\w+)"', source)
        self.assertEqual(tuple(name for name, _type in names), CONDITIONING.POSE_CONDITIONING_OUTPUTS)
        self.assertEqual(tuple(kind for _name, kind in names), POSE_STUDIO.VNCCS_PoseStudio.RETURN_TYPES[2:])


if __name__ == "__main__":
    unittest.main()
