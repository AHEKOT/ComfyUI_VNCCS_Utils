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
    package = types.ModuleType("vnccs_pose_charexp_testpkg")
    package.__path__ = [str(ROOT)]
    nodes_package = types.ModuleType("vnccs_pose_charexp_testpkg.nodes")
    nodes_package.__path__ = [str(ROOT / "nodes")]
    sys.modules.setdefault(package.__name__, package)
    sys.modules.setdefault(nodes_package.__name__, nodes_package)
    name = f"vnccs_pose_charexp_testpkg.nodes.{module}"
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


POSE_STUDIO = _load("pose_studio", ROOT / "nodes" / "pose_studio.py")
NODE = _load("character_export", ROOT / "nodes" / "character_export.py")
PASSES = sys.modules["vnccs_pose_charexp_testpkg.nodes.posestudio.character_passes"]
EXPORT = sys.modules["vnccs_pose_charexp_testpkg.nodes.posestudio.character_export"]
COLORS = {0: (255, 0, 0), 1: (0, 255, 0), 2: (0, 0, 255), 3: (255, 255, 0)}
WIDTH, HEIGHT = 40, 30
CLIP_FAR = 1000.0

# Slot -> (rows, cols, packed depth of each covered pixel). Slot 2 stands in front of
# slot 0 and covers part of it; slot 3 is entirely behind slot 2 (fully occluded).
SHAPES = {
    0: ((5, 25), (8, 20), lambda ys, xs: 1000 + xs * 3),
    1: ((2, 6), (30, 36), lambda ys, xs: 3000 + 0 * xs),
    2: ((8, 28), (15, 31), lambda ys, xs: 500 + ys),
    3: ((10, 13), (16, 19), lambda ys, xs: 2000 + 0 * xs),
}


def _png(array):
    encoded = io.BytesIO()
    Image.fromarray(np.asarray(array, dtype=np.uint8)).save(encoded, format="PNG")
    return "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode("ascii")


def _solo_depth(slot, shift=0):
    depth = np.zeros((HEIGHT, WIDTH), dtype=np.int64)
    (y0, y1), (x0, x1), value = SHAPES[slot]
    ys, xs = np.mgrid[y0:y1, x0:x1]
    depth[y0:y1, x0 + shift:x1 + shift] = value(ys, xs)
    return depth


def _capture(index, slots=(0, 2, 3), outside=()):
    """RGB capture, Character ID pass and uploaded character passes of one pose."""
    depths = {slot: (np.zeros((HEIGHT, WIDTH), dtype=np.int64) if slot in outside else _solo_depth(slot))
              for slot in slots}
    nearest = np.full((HEIGHT, WIDTH), np.inf)
    owner = np.full((HEIGHT, WIDTH), -1)
    for slot, depth in depths.items():
        closer = (depth > 0) & (depth < nearest)
        nearest[closer] = depth[closer]
        owner[closer] = slot
    ids = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    rgb = np.full((HEIGHT, WIDTH, 3), 40, dtype=np.uint8)
    for slot in slots:
        ids[owner == slot] = COLORS[slot]
        rgb[owner == slot] = (60 + 50 * slot, 90 + index, 120)
    characters = []
    for slot, depth in depths.items():
        coverage = depth > 0
        packed = np.stack([(depth >> 16) & 255, (depth >> 8) & 255, depth & 255], axis=-1)
        normal = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
        normal[coverage] = (100 + 20 * slot, 128, 230)
        characters.append({"slot": slot, "normal": _png(normal), "depth": _png(packed)})
    entry = {"pose_index": index, "pose_name": f"Pose {index + 1}", "clip_far": CLIP_FAR,
             "character_id": _png(ids), "characters": characters}
    return rgb, ids, entry, depths


def _run(count=1, outputs=("character_json", "character_passes"), characters=True, slots=(0, 2, 3),
         outside=(), output_mode="LIST", editor_mode="image", interface_mode="studio", mutate=None):
    captures = [_capture(index, slots, outside) for index in range(count)]
    data = {
        "export": {
            "view_width": WIDTH, "view_height": HEIGHT, "output_mode": output_mode, "grid_columns": 2,
            "editor_mode": editor_mode, "interface_mode": interface_mode,
            "conditioning_outputs": ["character_id"],
        },
        "captured_images": [_png(rgb) for rgb, _ids, _entry, _depths in captures],
        "lighting_prompts": ["" for _ in captures],
        "captured_conditioning": [{"character_id": _png(ids)} for _rgb, ids, _entry, _depths in captures],
    }
    if outputs:
        data["export"]["character_outputs"] = list(outputs)
    if characters:
        data["captured_characters"] = [entry for _rgb, _ids, entry, _depths in captures]
    if mutate:
        mutate(data)
    node = POSE_STUDIO.VNCCS_PoseStudio()
    return node, node.generate(json.dumps(data)), captures


def _export(result, margin=64, align="8", depth_normalization="scene"):
    return NODE.VNCCS_CharacterExport().export(
        result[0], result[7], result[11], result[12], [margin], [align], [depth_normalization],
    )


def _u8(array):
    return np.round(np.asarray(array) * 255).astype(np.uint8)


class CharacterPassOutputTests(unittest.TestCase):
    def test_outputs_are_appended_after_the_crop_outputs(self):
        node = POSE_STUDIO.VNCCS_PoseStudio
        self.assertEqual(node.RETURN_NAMES[11:], ("character_json", "character_passes"))
        self.assertEqual(node.RETURN_TYPES[11:], ("STRING", "IMAGE"))
        self.assertEqual(node.RETURN_NAMES[:11], (
            "images", "lighting_prompt", "depth", "normal", "outline", "silhouette", "mask", "character_id",
            "crop_json", "crop_image", "crop_preview",
        ))
        self.assertEqual(node.OUTPUT_IS_LIST, (True,) * 13)
        source = (ROOT / "web" / "pose_studio" / "character_passes.mjs").read_text(encoding="utf-8")
        self.assertIn('name: "character_json", type: "STRING"', source)
        self.assertIn('name: "character_passes", type: "IMAGE"', source)
        self.assertIn('["normal_solo", "depth_solo", "silhouette"]', source)

    def test_character_passes_pack_one_batch_per_character_in_pose_then_slot_order(self):
        _node, result, captures = _run(count=2)
        records = [json.loads(value) for value in result[11]]
        passes = result[12]
        self.assertEqual(len(records), 2)
        self.assertEqual(len(passes), 6, "three exported characters per pose")
        for pose, record in enumerate(records):
            self.assertEqual(record["type"], "vnccs_character_set")
            self.assertEqual(record["pose_index"], pose)
            self.assertEqual(record["pose_name"], f"Pose {pose + 1}")
            self.assertEqual(record["passes"], ["normal_solo", "depth_solo", "silhouette"])
            self.assertEqual(record["source"], {"width": WIDTH, "height": HEIGHT})
            self.assertEqual([c["slot"] for c in record["characters"]], [0, 2, 3])
            self.assertEqual([c["list_index"] for c in record["characters"]], [pose * 3 + i for i in range(3)])
            self.assertEqual([c["id_value"] for c in record["characters"]], [1, 3, 4])
            self.assertEqual([c["id_color"] for c in record["characters"]], ["#ff0000", "#0000ff", "#ffff00"])
            depths = captures[pose][3]
            for character in record["characters"]:
                frames = passes[character["list_index"]]
                self.assertEqual(tuple(frames.shape), (3, HEIGHT, WIDTH, 3))
                coverage = depths[character["slot"]] > 0
                np.testing.assert_array_equal(frames[2].numpy()[:, :, 0], coverage.astype(np.float32))
                normal = _u8(frames[0].numpy())
                self.assertEqual(int(normal[~coverage].max()), 0, "normal background is black")
                self.assertTrue((normal[coverage] == (100 + 20 * character["slot"], 128, 230)).all())
                self.assertEqual(character["pixels_full"], int(coverage.sum()))
        # Scene depth: nearest surface of any character 255, farthest 32, exact floats.
        first = records[0]
        self.assertAlmostEqual(first["depth"]["near"], 508 * CLIP_FAR / 16777215, places=6)
        self.assertAlmostEqual(first["depth"]["far"], 2000 * CLIP_FAR / 16777215, places=6)
        depth = passes[0][1].numpy()[:, :, 0] * 255
        levels = [passes[i][1].numpy()[:, :, 0] * 255 for i in range(3)]
        self.assertAlmostEqual(float(max(level.max() for level in levels)), 255.0, places=3)
        self.assertAlmostEqual(float(min(level[level > 0].min() for level in levels)), 32.0, places=3)
        self.assertEqual(float(depth[0, 0]), 0.0)
        self.assertFalse(np.allclose(depth, np.round(depth)), "solo depth keeps float precision")

    def test_z_order_visible_bounds_and_fully_occluded_characters(self):
        _node, result, captures = _run()
        record = json.loads(result[11][0])
        by_slot = {c["slot"]: c for c in record["characters"]}
        # Slot 2 is nearest, slot 0 behind it, slot 3 entirely hidden: ranked last.
        self.assertEqual({slot: c["z_order"] for slot, c in by_slot.items()}, {2: 0, 0: 1, 3: 2})
        self.assertIsNone(by_slot[3]["bbox_visible"])
        self.assertEqual(by_slot[3]["pixels_visible"], 0)
        self.assertIsNone(by_slot[3]["depth"]["visible_median"])
        self.assertEqual(by_slot[0]["bbox_full"], {"x": 8, "y": 5, "width": 12, "height": 20})
        self.assertEqual(by_slot[0]["bbox_visible"], {"x": 8, "y": 5, "width": 12, "height": 20})
        self.assertLess(by_slot[0]["pixels_visible"], by_slot[0]["pixels_full"])
        self.assertEqual(by_slot[2]["pixels_visible"], by_slot[2]["pixels_full"])
        self.assertAlmostEqual(by_slot[2]["depth"]["near"], 508 * CLIP_FAR / 16777215, places=6)

    def test_z_order_uses_the_median_of_visible_pixels(self):
        def far_spike(data):
            # Slot 0 gets one far-away visible column: its mean moves behind slot 2 but its median does not.
            entry = data["captured_characters"][0]
            depth = _solo_depth(0)
            depth[5:25, 8] = 900000
            depth[5:25, 9:20] = 100
            packed = np.stack([(depth >> 16) & 255, (depth >> 8) & 255, depth & 255], axis=-1)
            entry["characters"][0]["depth"] = _png(packed)
        _node, result, _captures = _run(mutate=far_spike)
        by_slot = {c["slot"]: c for c in json.loads(result[11][0])["characters"]}
        self.assertEqual(by_slot[0]["z_order"], 0)
        self.assertEqual(by_slot[2]["z_order"], 1)

    def test_slot_gaps_and_characters_outside_the_frame(self):
        _node, result, _captures = _run(slots=(0, 1, 2), outside=(1,))
        record = json.loads(result[11][0])
        self.assertEqual([c["slot"] for c in record["characters"]], [0, 2], "slot 1 covers no pixel")
        self.assertEqual([c["list_index"] for c in record["characters"]], [0, 1])
        self.assertEqual([c["id_value"] for c in record["characters"]], [1, 3])
        self.assertEqual(len(result[12]), 2)
        outputs = _export(result)
        meta = json.loads(outputs[6][0])
        self.assertEqual([(c["slot"], c["id_color"], c["list_index"]) for c in meta["characters"]],
                         [(0, "#ff0000", 0), (2, "#0000ff", 1)])

    def test_unlinked_outputs_are_placeholders_and_existing_outputs_are_unchanged(self):
        _node, plain, _captures = _run(outputs=(), characters=False)
        _node, linked, _captures = _run()
        self.assertEqual(len(plain), 13)
        record = json.loads(plain[11][0])
        self.assertEqual(record["characters"], [])
        self.assertEqual(record["unavailable"], "character outputs are not linked")
        self.assertEqual(tuple(plain[12][0].shape), (1, HEIGHT, WIDTH, 3))
        self.assertEqual(float(plain[12][0].max()), 0.0)
        for index in range(11):
            for left, right in zip(plain[index], linked[index]):
                if isinstance(left, str):
                    self.assertEqual(left, right)
                else:
                    self.assertTrue(torch.equal(left, right), f"output {index} is unchanged")
        with self.assertRaisesRegex(ValueError, "not linked"):
            _export(plain)

    def test_linked_outputs_without_passes_fail(self):
        with self.assertRaisesRegex(RuntimeError, "did not receive the character passes"):
            _run(characters=False)
        with self.assertRaisesRegex(RuntimeError, "character passes"):
            _run(count=2, mutate=lambda data: data["captured_characters"].pop())

    def test_uploaded_passes_are_validated(self):
        def unknown_color(data):
            ids = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
            ids[1, 1] = (128, 0, 128)
            data["captured_characters"][0]["character_id"] = _png(ids)
        with self.assertRaisesRegex(ValueError, "Character ID palette"):
            _run(mutate=unknown_color)
        with self.assertRaisesRegex(ValueError, "matching its RGB capture"):
            _run(mutate=lambda data: data["captured_characters"][0]["characters"][0].update(
                depth=_png(np.zeros((HEIGHT + 1, WIDTH, 3)))))
        with self.assertRaisesRegex(ValueError, "slot"):
            _run(mutate=lambda data: data["captured_characters"][0]["characters"][0].update(slot=4))
        with self.assertRaisesRegex(ValueError, "twice"):
            _run(mutate=lambda data: data["captured_characters"][0]["characters"][1].update(slot=0))

    def test_unsupported_run_modes_stop_when_character_outputs_are_linked(self):
        for kwargs, reason in (
            ({"output_mode": "GRID"}, "GRID output"),
            ({"interface_mode": "manager"}, "Pose Manager"),
            ({"editor_mode": "animation", "mutate": lambda d: d["export"].update(
                conditioning_outputs=[], animation_image_batch=True)}, "Animation mode"),
        ):
            with self.assertRaisesRegex(RuntimeError, f"character outputs .*{reason} is not supported"):
                _run(characters=False, **kwargs)
            _node, result, _captures = _run(outputs=(), characters=False, **kwargs)
            self.assertEqual(json.loads(result[11][0])["unavailable"], reason)
            self.assertEqual(float(result[12][0].max()), 0.0)


class CharacterCropRectTests(unittest.TestCase):
    def test_margin_and_alignment_match_the_documented_example(self):
        rect = EXPORT.character_crop_rect({"x": 240, "y": 352, "width": 568, "height": 608}, 1024, 1024, 64, 8)
        self.assertEqual(rect, {"x": 176, "y": 288, "width": 696, "height": 736})

    def test_alignment_grows_symmetrically(self):
        rect = EXPORT.character_crop_rect({"x": 100, "y": 100, "width": 50, "height": 10}, 1000, 1000, 3, 64)
        # 56 -> 64 (4 px each side), 16 -> 64 (24 px each side).
        self.assertEqual(rect, {"x": 93, "y": 73, "width": 64, "height": 64})
        rect = EXPORT.character_crop_rect({"x": 100, "y": 100, "width": 51, "height": 10}, 1000, 1000, 0, 8)
        self.assertEqual(rect, {"x": 98, "y": 97, "width": 56, "height": 16})

    def test_shift_inward_then_clamp(self):
        # Left/top edge: shifted to 0 and keeps its aligned size.
        rect = EXPORT.character_crop_rect({"x": 10, "y": 5, "width": 100, "height": 100}, 512, 512, 64, 8)
        self.assertEqual(rect, {"x": 0, "y": 0, "width": 232, "height": 232})
        # Right/bottom edge.
        rect = EXPORT.character_crop_rect({"x": 450, "y": 480, "width": 60, "height": 30}, 512, 512, 64, 64)
        self.assertEqual(rect, {"x": 320, "y": 320, "width": 192, "height": 192})
        # Larger than the frame after alignment: that axis is clamped to the frame.
        rect = EXPORT.character_crop_rect({"x": 20, "y": 100, "width": 280, "height": 50}, 300, 400, 16, 64)
        self.assertEqual(rect, {"x": 0, "y": 61, "width": 300, "height": 128})

    def test_rects_contain_the_margin_box_and_are_aligned_unless_clamped(self):
        rng = np.random.default_rng(7)
        for _ in range(500):
            width, height = int(rng.integers(64, 700)), int(rng.integers(64, 700))
            margin, align = int(rng.integers(0, 120)), int(rng.choice([8, 64]))
            x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
            bbox = {"x": x, "y": y, "width": int(rng.integers(1, width - x + 1)),
                    "height": int(rng.integers(1, height - y + 1))}
            rect = EXPORT.character_crop_rect(bbox, width, height, margin, align)
            for start, size, frame, key in (("x", "width", width, "x"), ("y", "height", height, "y")):
                low = max(0, bbox[start] - margin)
                high = min(frame, bbox[start] + bbox[size] + margin)
                self.assertLessEqual(rect[start], low)
                self.assertGreaterEqual(rect[start] + rect[size], high)
                self.assertGreaterEqual(rect[start], 0)
                self.assertLessEqual(rect[start] + rect[size], frame)
                if rect[size] != frame:
                    self.assertEqual(rect[size] % align, 0, (bbox, rect, margin, align))

    def test_invalid_parameters(self):
        with self.assertRaisesRegex(ValueError, "align"):
            EXPORT.character_crop_rect({"x": 0, "y": 0, "width": 1, "height": 1}, 10, 10, 0, 16)
        with self.assertRaisesRegex(ValueError, "margin"):
            EXPORT.character_crop_rect({"x": 0, "y": 0, "width": 1, "height": 1}, 10, 10, -1, 8)


class CharacterExportNodeTests(unittest.TestCase):
    def test_node_interface(self):
        node = NODE.VNCCS_CharacterExport
        self.assertEqual(node.RETURN_NAMES, (
            "normal_solo", "depth_solo", "character_id", "mask_visible", "mask_full", "rgb", "meta",
        ))
        self.assertEqual(node.RETURN_TYPES, ("IMAGE",) * 6 + ("STRING",))
        self.assertEqual(node.OUTPUT_IS_LIST, (True,) * 7)
        self.assertTrue(node.INPUT_IS_LIST)
        inputs = node.INPUT_TYPES()["required"]
        self.assertEqual(inputs["margin"][1]["default"], 64)
        self.assertEqual(inputs["align"][0], ["8", "64"])
        self.assertEqual(inputs["align"][1]["default"], "8")
        self.assertEqual(inputs["depth_normalization"][0], ["scene", "character"])
        self.assertEqual(inputs["depth_normalization"][1]["default"], "scene")
        registered = (ROOT / "__init__.py").read_text(encoding="utf-8")
        self.assertIn('"VNCCS_CharacterExport": VNCCS_CharacterExport', registered)

    def test_acceptance_criteria_on_overlapping_and_occluded_characters(self):
        _node, result, captures = _run(count=2)
        outputs = _export(result, margin=4, align="8")
        normal, depth, ids, visible, full, rgb, metas = outputs
        self.assertEqual(len(metas), 2)
        self.assertEqual(len(rgb), 6)
        for pose, meta_text in enumerate(metas):
            meta = json.loads(meta_text)
            self.assertEqual(meta["type"], "vnccs_character_export_set")
            self.assertEqual(meta["pose_index"], pose)
            self.assertEqual(meta["pose_name"], f"Pose {pose + 1}")
            self.assertEqual(meta["background"], {"normal": [0, 0, 0], "depth": 0})
            self.assertEqual(meta["depth_normalization"], "scene")
            source_rgb, source_ids, _entry, depths = captures[pose]
            union = np.zeros((HEIGHT, WIDTH), dtype=int)
            pasted = np.full_like(source_rgb, 40)
            for character in meta["characters"]:
                index, rect = character["list_index"], character["crop_rect"]
                ys = slice(rect["y"], rect["y"] + rect["height"])
                xs = slice(rect["x"], rect["x"] + rect["width"])
                # 2. Every output image is exactly crop_rect sized.
                for output in (normal, depth, ids, visible, full, rgb):
                    self.assertEqual(tuple(output[index].shape), (1, rect["height"], rect["width"], 3))
                color = np.array(COLORS[character["slot"]], dtype=np.uint8)
                mask_visible = visible[index][0].numpy()[:, :, 0] > 0.5
                mask_full = full[index][0].numpy()[:, :, 0] > 0.5
                # 1. The mask re-extracted from the cropped character_id matches mask_visible.
                extracted = np.all(_u8(ids[index][0].numpy()) == color, axis=-1)
                np.testing.assert_array_equal(extracted, mask_visible)
                np.testing.assert_array_equal(mask_full, (depths[character["slot"]] > 0)[ys, xs])
                # 3. Solo passes are background outside mask_full and filled in occluded parts.
                crop_normal, crop_depth = _u8(normal[index][0].numpy()), _u8(depth[index][0].numpy())
                self.assertEqual(int(crop_normal[~mask_full].max(initial=0)), 0)
                self.assertEqual(int(crop_depth[~mask_full].max(initial=0)), 0)
                occluded = mask_full & ~mask_visible
                self.assertTrue((crop_depth[occluded][:, 0] >= 32).all())
                self.assertTrue((crop_normal[occluded].sum(axis=-1) > 0).all())
                # 4. Pasting rgb back through mask_visible reproduces the character pixels.
                region = pasted[ys, xs]
                region[mask_visible] = _u8(rgb[index][0].numpy())[mask_visible]
                union[ys, xs] += mask_visible
                # 5. crop_rect contains bbox_full + margin and is aligned.
                bbox = character["bbox_full"]
                self.assertLessEqual(rect["x"], max(0, bbox["x"] - 4))
                self.assertGreaterEqual(rect["x"] + rect["width"], min(WIDTH, bbox["x"] + bbox["width"] + 4))
                for key, frame in (("width", WIDTH), ("height", HEIGHT)):
                    self.assertTrue(rect[key] % 8 == 0 or rect[key] == frame)
                self.assertAlmostEqual(character["visible_ratio"],
                                       round(int(mask_visible.sum()) / int(mask_full.sum()), 4))
            characters = source_ids.any(axis=-1)
            self.assertTrue((union <= 1).all(), "mask_visible masks are disjoint")
            np.testing.assert_array_equal(union.astype(bool), characters)
            np.testing.assert_array_equal(pasted[characters], source_rgb[characters])
            by_slot = {c["slot"]: c for c in meta["characters"]}
            self.assertIsNone(by_slot[3]["bbox_visible"])
            self.assertEqual(by_slot[3]["visible_ratio"], 0.0)
            self.assertEqual(by_slot[2]["visible_ratio"], 1.0)
            self.assertEqual([by_slot[s]["z_order"] for s in (2, 0, 3)], [0, 1, 2])

    def test_depth_normalization_modes(self):
        _node, result, captures = _run()
        scene = _export(result, margin=0)
        character = _export(result, margin=0, depth_normalization="character")
        self.assertEqual(json.loads(character[6][0])["depth_normalization"], "character")
        levels = []
        for index in range(3):
            scene_depth = _u8(scene[1][index][0].numpy())[:, :, 0]
            mask = _u8(scene[4][index][0].numpy())[:, :, 0] > 0
            levels.append(scene_depth[mask])
            own = _u8(character[1][index][0].numpy())[:, :, 0]
            # character: 255..32 over this character's own body.
            self.assertEqual(int(own[mask].max()), 255)
            self.assertEqual(int(own[mask].min()), 255 if index == 2 else 32)
            self.assertEqual(int(own[~mask].max(initial=0)), 0)
        # scene: one scale for every character; nearest 255 (slot 2), farthest 32 (slot 3).
        self.assertEqual(int(levels[1].max()), 255)
        self.assertEqual(int(levels[2].min()), 32)
        self.assertGreater(int(levels[0].min()), 32)
        self.assertLess(int(levels[0].max()), 255)
        # A flat character (slot 3, single depth) is 255 in character mode.
        flat = _u8(character[1][2][0].numpy())[:, :, 0]
        self.assertEqual(set(np.unique(flat[flat > 0]).tolist()), {255})

    def test_scene_depth_matches_the_full_depth_convention(self):
        depth = np.zeros((2, 3), dtype=np.int64)
        depth[0] = [10, 20, 30]
        coverage = depth > 0
        levels = PASSES.scene_depth_levels(depth, coverage, 10, 30) * 255
        np.testing.assert_allclose(levels[0], [255, (255 + 32) / 2, 32], rtol=1e-6)
        self.assertEqual(float(levels[1].max()), 0.0)
        flat = PASSES.scene_depth_levels(depth, coverage, 15, 15) * 255
        np.testing.assert_allclose(flat[0], [255, 255, 255])

    def test_batched_images_are_split_per_pose_and_mismatches_fail(self):
        _node, result, _captures = _run(count=2)
        batched = [torch.cat(result[0], dim=0)]
        outputs = NODE.VNCCS_CharacterExport().export(
            batched, result[7], result[11], result[12], [0], ["8"], ["scene"])
        reference = _export(result, margin=0)
        for left, right in zip(outputs[5], reference[5]):
            self.assertTrue(torch.equal(left, right))
        with self.assertRaisesRegex(ValueError, "character_passes item"):
            NODE.VNCCS_CharacterExport().export(result[0], result[7], result[11], result[12][:-1],
                                                [0], ["8"], ["scene"])
        with self.assertRaisesRegex(ValueError, "images item"):
            NODE.VNCCS_CharacterExport().export(result[0][:1], result[7], result[11], result[12],
                                                [0], ["8"], ["scene"])
        small = [image[:, :-1] for image in result[0]]
        with self.assertRaisesRegex(ValueError, "uncropped"):
            NODE.VNCCS_CharacterExport().export(small, result[7], result[11], result[12], [0], ["8"], ["scene"])

    def test_character_json_validation(self):
        for value, message in (
            ("", "empty"), ("{", "not valid JSON"), ('{"type": "x"}', "vnccs_character_set"),
            ('{"type": "vnccs_character_set", "schema_version": 2}', "newer"),
        ):
            with self.assertRaisesRegex(ValueError, message):
                EXPORT.parse_character_json(value)


if __name__ == "__main__":
    unittest.main()
