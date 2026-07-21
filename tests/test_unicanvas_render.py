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


if __name__ == "__main__":
    unittest.main()
