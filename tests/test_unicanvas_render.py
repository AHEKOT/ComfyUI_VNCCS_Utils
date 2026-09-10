import base64
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


def _load_unicanvas_module():
    fake_torch = types.ModuleType("torch")
    fake_torch.Tensor = object
    previous_torch = sys.modules.get("torch")
    sys.modules["torch"] = fake_torch
    try:
        name = "vnccs_unicanvas_render_testmodule"
        spec = importlib.util.spec_from_file_location(name, ROOT / "nodes" / "unicanvas.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        if previous_torch is None:
            sys.modules.pop("torch", None)
        else:
            sys.modules["torch"] = previous_torch


UNICANVAS = _load_unicanvas_module()


def _data_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class UniCanvasRenderTests(unittest.TestCase):
    def panorama_state(self):
        base = Image.new("RGBA", (8, 4), (20, 40, 60, 255))
        edit = Image.new("RGBA", (8, 4), (0, 0, 0, 0))
        edit.putpixel((0, 2), (255, 0, 0, 255))
        edit.putpixel((7, 2), (255, 0, 0, 255))
        return {
            "version": 3,
            "panorama": {"projection": "equirectangular", "width": 8, "height": 4, "baseLayerId": "base", "yaw": 0, "pitch": 0, "fov": 90},
            "origin": {"x": -512, "y": -512},
            "bbox": {"x": 100, "y": 100, "width": 2, "height": 2},
            "layers": [
                {"id": name, "type": "raster", "visible": True, "opacity": 1, "crop": {"x": 0, "y": 0, "width": 8, "height": 4}, "dataURL": _data_url(image)}
                for name, image in [("edit", edit), ("base", base)]
            ],
        }

    def test_panorama_output_is_full_size_and_independent_of_camera_and_bbox(self):
        state = self.panorama_state()
        expected = UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertEqual(expected.size, (8, 4))
        self.assertEqual(expected.getpixel((0, 2)), (255, 0, 0, 255))
        self.assertEqual(expected.getpixel((7, 2)), (255, 0, 0, 255))
        for yaw, pitch in [(180, 0), (90, 90), (-90, -90), (360, 0)]:
            state["panorama"].update(yaw=yaw, pitch=pitch, fov=120)
            state["bbox"] = {"x": -9999, "y": 9999, "width": 1024, "height": 1024}
            actual = UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))
            self.assertEqual(actual.tobytes(), expected.tobytes())

    def test_panorama_base_stays_below_edits_even_if_serialized_out_of_order(self):
        state = self.panorama_state()
        state["layers"].reverse()
        result = UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertEqual(result.getpixel((0, 2)), (255, 0, 0, 255))

    def test_panorama_layer_visibility_opacity_and_masks(self):
        state = self.panorama_state()
        state["layers"][0]["opacity"] = .5
        result = UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertAlmostEqual(result.getpixel((0, 2))[0], 137, delta=1)
        state["layers"][0]["type"] = "mask"
        result = UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertEqual(result.getpixel((0, 2)), (20, 40, 60, 255))
        state["layers"][1]["visible"] = False
        result = UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertEqual(result.getbbox(), None)

    def test_panorama_invalid_dimensions_and_projection_are_rejected(self):
        for changes in [{"width": 0}, {"height": -1}, {"width": 16384}, {"width": 8192, "height": 8192}, {"width": float("nan")}, {"projection": "cubemap"}]:
            state = self.panorama_state()
            state["panorama"].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))

    def test_panorama_rejects_layer_images_from_a_different_document_size(self):
        state = self.panorama_state()
        state["layers"][0]["dataURL"] = _data_url(Image.new("RGBA", (2, 2)))
        with self.assertRaisesRegex(ValueError, "dimensions do not match"):
            UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))

    def test_panorama_does_not_silently_export_incomplete_or_offset_layers(self):
        for mutation, message in [("missing_base", "base layer is missing"), ("missing_pixels", "pixels are missing"), ("offset_crop", "dimensions do not match")]:
            state = self.panorama_state()
            if mutation == "missing_base":
                state["layers"].pop()
            elif mutation == "missing_pixels":
                state["layers"][0]["dataURL"] = None
            else:
                state["layers"][0]["crop"]["x"] = 10000
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, message):
                UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))

    def test_panorama_compact_state_preserves_cached_spherical_pixels(self):
        cached = self.panorama_state()
        live = json.loads(json.dumps(cached))
        live["panorama"]["yaw"] = 123
        live["layers"][0]["opacity"] = .75
        for layer in live["layers"]:
            layer.update(dataURL=None, cached=True)
        merged = UNICANVAS._merge_unicanvas_state_with_cache(live, cached)
        self.assertEqual(merged["panorama"]["yaw"], 123)
        self.assertEqual(merged["layers"][0]["opacity"], .75)
        self.assertEqual(merged["layers"][0]["dataURL"], cached["layers"][0]["dataURL"])
        self.assertEqual(UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(merged)).size, (8, 4))

    def test_multiply_blend_matches_canvas_formula(self):
        backdrop = Image.new("RGBA", (1, 1), (100, 200, 50, 255))
        source = Image.new("RGBA", (1, 1), (200, 100, 255, 255))

        result = UNICANVAS._alpha_composite_with_blend(backdrop, source, "multiply")

        expected = tuple(round(a * b / 255) for a, b in zip((100, 200, 50), (200, 100, 255))) + (255,)
        self.assertEqual(result.getpixel((0, 0)), expected)

    def test_renderer_applies_serialized_blend_mode(self):
        bottom = Image.new("RGBA", (1, 1), (128, 64, 255, 255))
        top = Image.new("RGBA", (1, 1), (128, 255, 64, 255))
        state = {
            "origin": {"x": 0, "y": 0, "width": 1, "height": 1},
            "bbox": {"x": 0, "y": 0, "width": 1, "height": 1},
            "layers": [
                {"type": "raster", "visible": True, "opacity": 1, "blendMode": "multiply", "crop": {"x": 0, "y": 0, "width": 1, "height": 1}, "dataURL": _data_url(top)},
                {"type": "raster", "visible": True, "opacity": 1, "blendMode": "source-over", "crop": {"x": 0, "y": 0, "width": 1, "height": 1}, "dataURL": _data_url(bottom)},
            ],
        }

        result = UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))

        self.assertEqual(result.getpixel((0, 0)), (64, 64, 64, 255))

    def test_all_widget_blend_modes_produce_finite_rgba(self):
        backdrop = Image.new("RGBA", (2, 2), (70, 130, 220, 190))
        source = Image.new("RGBA", (2, 2), (210, 80, 40, 140))
        for mode in UNICANVAS._UNICANVAS_BLEND_MODES:
            with self.subTest(mode=mode):
                values = np.asarray(UNICANVAS._alpha_composite_with_blend(backdrop, source, mode))
                self.assertEqual(values.shape, (2, 2, 4))
                self.assertTrue(np.isfinite(values).all())

    def test_output_dimensions_are_limited_before_allocation(self):
        state = {
            "bbox": {"x": 0, "y": 0, "width": UNICANVAS._MAX_PIXELS + 1, "height": 1},
            "layers": [],
        }

        with self.assertRaisesRegex(ValueError, "dimensions are too large"):
            UNICANVAS._render_unicanvas_state_to_rgba(json.dumps(state))

    def test_debug_tensor_inspection_is_disabled_by_default(self):
        previous = UNICANVAS.UNICANVAS_DEBUG
        try:
            UNICANVAS.UNICANVAS_DEBUG = 0
            self.assertEqual(UNICANVAS._tensor_debug(object()), {})
            self.assertEqual(UNICANVAS._latent_debug({"samples": object()}), {})
        finally:
            UNICANVAS.UNICANVAS_DEBUG = previous

    def test_draw_progress_is_bounded(self):
        UNICANVAS._DRAW_PROGRESS.clear()
        now = 10_000.0
        for index in range(UNICANVAS._DRAW_PROGRESS_MAX + 20):
            UNICANVAS._DRAW_PROGRESS[str(index)] = {
                "stage": "sampling",
                "updated_at": now + index,
            }

        UNICANVAS._prune_draw_progress(now + UNICANVAS._DRAW_PROGRESS_MAX + 20)

        self.assertEqual(len(UNICANVAS._DRAW_PROGRESS), UNICANVAS._DRAW_PROGRESS_MAX)

    def test_selected_sdxl_preset_forces_its_checkpoint(self):
        settings = UNICANVAS._normalize_gen_settings({
            "model_selection_mode": "presets",
            "selected_preset_id": "sdxl",
            "generation_mode": "sdxl",
            "model_loader": "checkpoint",
            "ckpt_name": r"3d\hunyuan3d-dit-v2-mv-turbo_fp16.safetensors",
            "steps": 31,
            "mode_settings": {
                "sdxl": {
                    "ckpt_name": "wrong/mode-profile.safetensors",
                },
            },
        })

        self.assertEqual(settings["ckpt_name"], "Illustrious/ILFlatMix.safetensors")
        self.assertEqual(settings["model_loader"], "checkpoint")
        self.assertEqual(settings["generation_mode"], "sdxl")
        self.assertEqual(settings["steps"], 31)

    def test_custom_checkpoint_is_not_overridden_by_preset_registry(self):
        settings = UNICANVAS._normalize_gen_settings({
            "model_selection_mode": "custom",
            "selected_preset_id": "sdxl",
            "generation_mode": "sdxl",
            "model_loader": "checkpoint",
            "ckpt_name": "custom/model.safetensors",
        })

        self.assertEqual(settings["ckpt_name"], "custom/model.safetensors")


if __name__ == "__main__":
    unittest.main()
