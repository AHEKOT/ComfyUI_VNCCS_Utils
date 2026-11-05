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


def _load_logic_module(stem):
    """The list and pass logic in nodes/posestudio/ needs only NumPy and Pillow."""
    package_name = "vnccs_pose_conditioning_logic"
    if package_name not in sys.modules:
        package = types.ModuleType(package_name)
        package.__path__ = [str(ROOT / "nodes" / "posestudio")]
        sys.modules[package_name] = package
    name = f"{package_name}.{stem}"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, ROOT / "nodes" / "posestudio" / f"{stem}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_pose_studio_module():
    """Tensor-dependent node tests are skipped where CI does not install PyTorch."""
    pytest.importorskip("torch")
    name = "vnccs_pose_conditioning_testpkg.nodes.pose_studio"
    if name in sys.modules:
        return sys.modules[name]
    package = types.ModuleType("vnccs_pose_conditioning_testpkg")
    package.__path__ = [str(ROOT)]
    nodes_package = types.ModuleType("vnccs_pose_conditioning_testpkg.nodes")
    nodes_package.__path__ = [str(ROOT / "nodes")]
    sys.modules[package.__name__] = package
    sys.modules[nodes_package.__name__] = nodes_package
    spec = importlib.util.spec_from_file_location(name, ROOT / "nodes" / "pose_studio.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


CONDITIONING = _load_logic_module("conditioning")
ADDITIONAL = _load_logic_module("additional_outputs")
SLOT_COUNT = 2 + len(ADDITIONAL.POSE_ADDITIONAL_OUTPUTS)
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


def _run(count=2, outputs=ALL_OUTPUTS, output_mode="LIST", editor_mode="image", conditioning=True, mutate=None, linked=None):
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
        data["export"]["additional_outputs"] = list(outputs)
        data["export"]["linked_additional_outputs"] = list(outputs if linked is None else linked)
    if conditioning:
        data["captured_conditioning"] = [passes for _rgb, passes, _ids in poses]
    if mutate:
        mutate(data)
    node = _load_pose_studio_module().VNCCS_PoseStudio()
    return node, node.generate(json.dumps(data)), [ids for _rgb, _passes, ids in poses]


class AdditionalOutputListTests(unittest.TestCase):
    """Runs without PyTorch."""

    def test_enabled_outputs_keep_socket_order(self):
        read = ADDITIONAL.enabled_additional_outputs
        self.assertEqual(read({"additional_outputs": ["mask", "depth"]}), ("mask", "depth"))
        self.assertEqual(read({}), ())
        self.assertEqual(read(None), ())
        self.assertEqual(read({"additional_outputs": []}), ())

    def test_invalid_lists_never_shift_a_slot(self):
        for names in ("depth", ["depth", "depth"], ["depth", "future"], [1], [["depth"]]):
            with self.assertRaisesRegex(ValueError, "additional_outputs"):
                ADDITIONAL.enabled_additional_outputs({"additional_outputs": names})

    def test_linked_outputs_are_a_subset_of_the_enabled_ones(self):
        read = ADDITIONAL.linked_additional_outputs
        enabled = ("mask", "depth")
        self.assertEqual(read({"linked_additional_outputs": ["depth", "mask"]}, enabled), ("mask", "depth"))
        self.assertEqual(read({"linked_additional_outputs": []}, enabled), ())
        self.assertEqual(read({}, enabled), enabled, "a prompt without link data produces what it enables")
        for names in ("depth", ["normal"]):
            with self.assertRaisesRegex(ValueError, "linked_additional_outputs"):
                read({"linked_additional_outputs": names}, enabled)

    def test_passes_cover_only_what_the_enabled_outputs_need(self):
        self.assertEqual(CONDITIONING.conditioning_passes(("mask", "silhouette")), ("character_id",))
        self.assertEqual(CONDITIONING.conditioning_passes(()), ())

    def test_palette_and_output_names_match_the_widget(self):
        source = (ROOT / "web" / "pose_studio" / "conditioning.mjs").read_text(encoding="utf-8")
        block = source[source.index("POSE_CHARACTER_ID_COLORS = Object.freeze(["):]
        block = block[:block.index("]);")]
        colors = tuple(tuple(int(value) for value in match.split(","))
                       for match in re.findall(r"\[(\d+, \d+, \d+)\]", block))
        self.assertEqual(colors, CONDITIONING.POSE_CHARACTER_ID_COLORS)
        names = re.findall(r'name: "(\w+)", type: "(\w+)"', source)
        self.assertEqual(tuple(name for name, _type in names), CONDITIONING.POSE_CONDITIONING_OUTPUTS)
        self.assertEqual({kind for _name, kind in names}, {"IMAGE", "MASK"})

    def test_decode_rejects_a_pass_with_another_size(self):
        with self.assertRaisesRegex(ValueError, "matching its RGB capture"):
            CONDITIONING.decode_pose_conditioning(
                [{"depth": _png(np.zeros((HEIGHT, WIDTH + 1, 3)))}], ("depth",), [(WIDTH, HEIGHT)]
            )


class PoseConditioningOutputTests(unittest.TestCase):
    def test_slots_after_lighting_prompt_accept_every_additional_output_type(self):
        node = _load_pose_studio_module().VNCCS_PoseStudio
        self.assertEqual(node.RETURN_NAMES, (
            "images", "lighting_prompt", "depth", "normal", "outline", "silhouette", "mask", "character_id",
            "crop_json", "crop_image", "crop_preview", "character_json", "character_passes",
        ))
        self.assertEqual(node.RETURN_TYPES[2:], (ADDITIONAL.POSE_ADDITIONAL_OUTPUT_TYPE,) * len(ADDITIONAL.POSE_ADDITIONAL_OUTPUTS))
        self.assertEqual(node.OUTPUT_IS_LIST, (True,) * SLOT_COUNT)

    def test_slots_follow_the_enabled_order_and_disabled_slots_stay_empty(self):
        _node, result, ids = _run(outputs=["mask", "depth"], mutate=lambda data: [
            item.pop(name) for item in data["captured_conditioning"] for name in ("normal", "outline")
        ])
        self.assertEqual(len(result), SLOT_COUNT)
        mask, depth = result[2], result[3]
        np.testing.assert_array_equal(mask[0][0].numpy(), ids[0].any(axis=-1).astype(np.float32))
        self.assertEqual(tuple(mask[0].shape), (1, HEIGHT, WIDTH))
        self.assertAlmostEqual(float(depth[0][0, 1, 1, 0]), 100 / 255, places=6)
        self.assertEqual(list(result[4:]), [[]] * (SLOT_COUNT - 4))

    def test_list_outputs_align_with_images_and_derive_silhouette_and_mask(self):
        _node, result, ids = _run()
        self.assertEqual(len(result), 13)
        images, prompts, depth, normal, outline, silhouette, mask, character_id = result[:8]
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
        images, prompts, depth, normal, outline, silhouette, mask, character_id = result[:8]
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

    def test_disabled_outputs_allocate_nothing(self):
        _node, result, _ids = _run(outputs=[], conditioning=False)
        self.assertEqual(len(result), SLOT_COUNT)
        self.assertEqual(len(result[0]), 2)
        for output in result[2:]:
            self.assertEqual(output, [])
        # An enabled output without a link is not produced and needs no pass.
        _node, result, _ids = _run(outputs=["depth"], linked=[], conditioning=False)
        self.assertEqual(result[2], [])
        # Passes the browser skipped for disabled outputs are never decoded.
        _node, result, ids = _run(outputs=["mask"], mutate=lambda data: [
            item.pop(name) for item in data["captured_conditioning"] for name in ("depth", "normal", "outline")
        ])
        np.testing.assert_array_equal(result[2][0][0].numpy(), ids[0].any(axis=-1).astype(np.float32))
        for output in result[3:]:
            self.assertEqual(output, [])

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

    def test_animation_mode_refuses_linked_conditioning_outputs(self):
        with self.assertRaisesRegex(RuntimeError, "Additional Outputs"):
            _run(editor_mode="animation")
        _node, result, _ids = _run(editor_mode="animation", linked=[], conditioning=False,
                                   mutate=lambda data: data["export"].update(animation_image_batch=True))
        self.assertEqual(list(result[2:]), [[]] * (SLOT_COUNT - 2))

    def test_animation_outputs_keep_their_slots_when_nothing_is_enabled(self):
        node, result, _ids = _run(count=2, outputs=[], conditioning=False, editor_mode="animation",
                                  mutate=lambda data: data["export"].update(animation_image_batch=True))
        self.assertEqual(tuple(result[0].shape), (2, HEIGHT, WIDTH, 3))
        self.assertEqual(node.OUTPUT_IS_LIST, (False,) + (True,) * (SLOT_COUNT - 1))
        self.assertEqual(len(result), SLOT_COUNT)
        for output in result[2:]:
            self.assertEqual(output, [])


if __name__ == "__main__":
    unittest.main()
