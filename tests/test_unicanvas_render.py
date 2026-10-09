import base64
import io
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

from helpers.unicanvas_package import load_unicanvas_package


def _stub_torch():
    fake_torch = types.ModuleType("torch")
    fake_torch.Tensor = object
    return fake_torch


# The whole package under a private name with a stub torch: the suite runs without torch.
UNICANVAS = load_unicanvas_package("vnccs_unicanvas_render_test", torch_module=_stub_torch())


def _data_url(image):
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class UniCanvasRenderTests(unittest.TestCase):
    def test_large_flat_layer_exports_its_small_bbox_without_decoding_the_whole_layer(self):
        pixels = _data_url(Image.new("RGBA", (6000, 4000), "red"))
        state = {"version": 2, "state_id": "large-layer", "output_id": "large-layer_out",
                 "bbox": {"x": 0, "y": 0, "width": 1024, "height": 1024},
                 "layers": [{"id": "image", "type": "raster", "dataURL": pixels,
                             "crop": {"x": 0, "y": 0, "width": 6000, "height": 4000}}]}
        output = {"bbox": state["bbox"], "layers": [{"id": "output", "type": "raster",
                  "crop": state["bbox"], "dataURL": _data_url(Image.new("RGBA", (1024, 1024), "red"))}]}
        with mock.patch.object(UNICANVAS.render, "_read_unicanvas_state_cache", return_value=output) as read:
            result = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))
        read.assert_called_once_with("large-layer_out")
        self.assertEqual(result.size, (1024, 1024))
        self.assertEqual(result.getpixel((0, 0)), (255, 0, 0, 255))

    def test_uploaded_reference_gaps_keep_their_socket_numbers(self):
        uploads = [None, "", "third", *([None] * 6), "tenth", "outside_limit"]
        with (
            mock.patch.object(UNICANVAS.draw_request, "_decode_data_url", side_effect=lambda value, mode: value),
            mock.patch.object(UNICANVAS.draw_request, "_pil_to_image_tensor", side_effect=lambda value: value),
        ):
            settings = UNICANVAS.draw_request._request_settings({"settings": {"edit_reference_images": uploads}}, None)
        self.assertEqual(settings["_external"]["references"], {"reference_image_3": "third", "reference_image_10": "tenth"})
        self.assertEqual(UNICANVAS.models.base._reference_image_slots("canvas", settings), {1: "canvas", 4: "third", 11: "tenth"})

    def test_cache_merge_preserves_workflow_geometry_and_hires_clear(self):
        cached = {"layers": [{"id": "image", "crop": {"x": 0}, "dataURL": "pixels",
                              "hiresRect": {"x": 0}, "hiresDataURL": "hires"}]}
        live = {"layers": [{"id": "image", "cached": True, "crop": {"x": 5},
                            "dataURL": None, "hiresRect": None, "hiresDataURL": None}]}
        merged = UNICANVAS.state._merge_unicanvas_state_with_cache(live, cached)["layers"][0]
        self.assertEqual(merged["crop"], {"x": 5})
        self.assertEqual(merged["dataURL"], "pixels")
        self.assertIsNone(merged["hiresRect"])
        self.assertIsNone(merged["hiresDataURL"])
        live["layers"][0].pop("hiresRect")
        live["layers"][0].pop("crop")
        fallback = UNICANVAS.state._merge_unicanvas_state_with_cache(live, cached)["layers"][0]
        self.assertEqual(fallback["crop"], {"x": 0})
        self.assertEqual(fallback["hiresRect"], {"x": 0})
        self.assertEqual(fallback["hiresDataURL"], "hires")
        cached["layers"][0].update(crop={"x": 0, "y": 0, "width": 1, "height": 1},
            dataURL=_data_url(Image.new("RGBA", (1, 1), "red")), hiresRect=None, hiresDataURL=None)
        live["layers"][0]["crop"] = {"x": 5, "y": 0, "width": 1, "height": 1}
        live["layers"][0]["type"] = "raster"
        live["bbox"] = {"x": 0, "y": 0, "width": 8, "height": 1}
        image = UNICANVAS.render._render_unicanvas_state_to_rgba(
            json.dumps(UNICANVAS.state._merge_unicanvas_state_with_cache(live, cached)))
        self.assertEqual(image.getpixel((5, 0)), (255, 0, 0, 255))
        self.assertEqual(image.getpixel((0, 0)), (0, 0, 0, 0))

    def test_pixel_cache_changes_invalidate_comfy_output_without_metadata_changes(self):
        with (
            tempfile.TemporaryDirectory() as root,
            mock.patch.object(UNICANVAS.state.cache, "_UNICANVAS_STATE_CACHE_DIR", root),
            mock.patch.object(UNICANVAS.state.cache, "_UNICANVAS_LEGACY_STATE_CACHE_DIR", root),
        ):
            state = json.dumps({"storage": "server_cache", "state_id": "layers", "output_id": "output"})
            node = UNICANVAS.VNCCS_UniCanvas
            missing = node.IS_CHANGED(state)
            fingerprints = []
            for cache_id in ("layers", "output"):
                path = Path(root) / f"{cache_id}.json"
                path.write_text(json.dumps({"state": {"layers": [{"dataURL": "red"}]}}))
                red = node.IS_CHANGED(state)
                self.assertEqual(red, node.IS_CHANGED(state))
                stamp = path.stat().st_mtime_ns
                path.write_text(json.dumps({"state": {"layers": [{"dataURL": "tan"}]}}))
                os.utime(path, ns=(stamp + 1_000_000, stamp + 1_000_000))
                changed = node.IS_CHANGED(state)
                self.assertNotEqual(red, changed)
                fingerprints.extend((red, changed))
            self.assertNotEqual(missing, fingerprints[0])
            legacy = json.dumps({"state_id": "layers", "panorama": {"projection": "equirectangular"}})
            legacy_missing = node.IS_CHANGED(legacy)
            (Path(root) / "layers_out.json").write_text('{"state": {"layers": []}}')
            self.assertNotEqual(legacy_missing, node.IS_CHANGED(legacy))
            for path in Path(root).glob("*.json"):
                path.unlink()
            self.assertEqual(node.IS_CHANGED(state), missing)

    def test_rendering_cached_pixels_preserves_comfy_output_fingerprint(self):
        with (
            tempfile.TemporaryDirectory() as root,
            mock.patch.object(UNICANVAS.state.cache, "_UNICANVAS_STATE_CACHE_DIR", root),
            mock.patch.object(UNICANVAS.state.cache, "_UNICANVAS_LEGACY_STATE_CACHE_DIR", root),
        ):
            cached = {"layers": [], "bbox": {"x": 0, "y": 0, "width": 64, "height": 64}}
            for cache_id in ("layers", "output"):
                path = Path(root) / f"{cache_id}.json"
                path.write_text(json.dumps({"state": cached}))
                os.utime(path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
            for output_id in (None, "output"):
                with self.subTest(output_id=output_id):
                    state = json.dumps({"storage": "server_cache", "state_id": "layers", "output_id": output_id})
                    before = UNICANVAS.VNCCS_UniCanvas.IS_CHANGED(state)
                    result = UNICANVAS.render._render_unicanvas_state_to_rgba(state)
                    self.assertEqual(result.size, (64, 64))
                    self.assertEqual(UNICANVAS.VNCCS_UniCanvas.IS_CHANGED(state), before)

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
        expected = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertEqual(expected.size, (8, 4))
        self.assertEqual(expected.getpixel((0, 2)), (255, 0, 0, 255))
        self.assertEqual(expected.getpixel((7, 2)), (255, 0, 0, 255))
        for yaw, pitch in [(180, 0), (90, 90), (-90, -90), (360, 0)]:
            state["panorama"].update(yaw=yaw, pitch=pitch, fov=120)
            state["bbox"] = {"x": -9999, "y": 9999, "width": 1024, "height": 1024}
            actual = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))
            self.assertEqual(actual.tobytes(), expected.tobytes())

    def test_panorama_output_uses_the_flattened_bbox_crop_when_uploaded(self):
        # The widget uploads one small flattened layer under output_id; the huge spherical layers are not needed.
        flat = {"version": 2, "bbox": {"x": 0, "y": 0, "width": 2, "height": 2}, "origin": {"x": 0, "y": 0},
                "layers": [{"id": "output", "type": "raster", "visible": True, "opacity": 1, "crop": {"x": 0, "y": 0, "width": 2, "height": 2},
                            "dataURL": _data_url(Image.new("RGBA", (2, 2), (9, 8, 7, 255)))}]}
        state = self.panorama_state()
        state["output_id"] = "out"
        for layer in state["layers"]:
            layer["dataURL"] = None
            layer["cached"] = True
        original = UNICANVAS.render._read_unicanvas_state_cache
        UNICANVAS.render._read_unicanvas_state_cache = lambda state_id: flat if state_id == "out" else None
        try:
            result = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))
        finally:
            UNICANVAS.render._read_unicanvas_state_cache = original
        self.assertEqual(result.size, (2, 2))
        self.assertEqual(result.getpixel((0, 0)), (9, 8, 7, 255))

    def test_panorama_base_stays_below_edits_even_if_serialized_out_of_order(self):
        state = self.panorama_state()
        state["layers"].reverse()
        result = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertEqual(result.getpixel((0, 2)), (255, 0, 0, 255))

    def test_panorama_layer_visibility_opacity_and_masks(self):
        state = self.panorama_state()
        state["layers"][0]["opacity"] = .5
        result = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertAlmostEqual(result.getpixel((0, 2))[0], 137, delta=1)
        state["layers"][0]["type"] = "mask"
        result = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertEqual(result.getpixel((0, 2)), (20, 40, 60, 255))
        state["layers"][1]["visible"] = False
        result = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertEqual(result.getbbox(), None)

    def test_panorama_invalid_dimensions_and_projection_are_rejected(self):
        for changes in [{"width": 0}, {"height": -1}, {"width": 16384}, {"width": 8192, "height": 8192}, {"width": float("nan")}, {"projection": "cubemap"}]:
            state = self.panorama_state()
            state["panorama"].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))

    def test_panorama_rejects_layer_images_from_a_different_document_size(self):
        state = self.panorama_state()
        state["layers"][0]["dataURL"] = _data_url(Image.new("RGBA", (2, 2)))
        with self.assertRaisesRegex(ValueError, "dimensions do not match"):
            UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))

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
                UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))

    def test_panorama_compact_state_preserves_cached_spherical_pixels(self):
        cached = self.panorama_state()
        live = json.loads(json.dumps(cached))
        live["panorama"]["yaw"] = 123
        live["layers"][0]["opacity"] = .75
        for layer in live["layers"]:
            layer.update(dataURL=None, cached=True)
        merged = UNICANVAS.state._merge_unicanvas_state_with_cache(live, cached)
        self.assertEqual(merged["panorama"]["yaw"], 123)
        self.assertEqual(merged["layers"][0]["opacity"], .75)
        self.assertEqual(merged["layers"][0]["dataURL"], cached["layers"][0]["dataURL"])
        self.assertEqual(UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(merged)).size, (8, 4))

    def test_multiply_blend_matches_canvas_formula(self):
        backdrop = Image.new("RGBA", (1, 1), (100, 200, 50, 255))
        source = Image.new("RGBA", (1, 1), (200, 100, 255, 255))

        result = UNICANVAS.render._alpha_composite_with_blend(backdrop, source, "multiply")

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

        result = UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))

        self.assertEqual(result.getpixel((0, 0)), (64, 64, 64, 255))

    def test_all_widget_blend_modes_produce_finite_rgba(self):
        backdrop = Image.new("RGBA", (2, 2), (70, 130, 220, 190))
        source = Image.new("RGBA", (2, 2), (210, 80, 40, 140))
        for mode in UNICANVAS.render._UNICANVAS_BLEND_MODES:
            with self.subTest(mode=mode):
                values = np.asarray(UNICANVAS.render._alpha_composite_with_blend(backdrop, source, mode))
                self.assertEqual(values.shape, (2, 2, 4))
                self.assertTrue(np.isfinite(values).all())

    def test_output_dimensions_are_limited_before_allocation(self):
        state = {
            "bbox": {"x": 0, "y": 0, "width": UNICANVAS.render._MAX_PIXELS + 1, "height": 1},
            "layers": [],
        }

        with self.assertRaisesRegex(ValueError, "dimensions are too large"):
            UNICANVAS.render._render_unicanvas_state_to_rgba(json.dumps(state))

    def test_debug_tensor_inspection_is_disabled_by_default(self):
        previous = UNICANVAS.debug.UNICANVAS_DEBUG
        try:
            UNICANVAS.debug.UNICANVAS_DEBUG = 0
            self.assertEqual(UNICANVAS.debug._tensor_debug(object()), {})
            self.assertEqual(UNICANVAS.debug._latent_debug({"samples": object()}), {})
        finally:
            UNICANVAS.debug.UNICANVAS_DEBUG = previous

    def test_draw_progress_is_bounded(self):
        UNICANVAS.progress._DRAW_PROGRESS.clear()
        now = 10_000.0
        for index in range(UNICANVAS.progress._DRAW_PROGRESS_MAX + 20):
            UNICANVAS.progress._DRAW_PROGRESS[str(index)] = {
                "stage": "sampling",
                "updated_at": now + index,
            }

        UNICANVAS.progress._prune_draw_progress(now + UNICANVAS.progress._DRAW_PROGRESS_MAX + 20)

        self.assertEqual(len(UNICANVAS.progress._DRAW_PROGRESS), UNICANVAS.progress._DRAW_PROGRESS_MAX)

    def test_selected_sdxl_preset_forces_its_checkpoint(self):
        settings = UNICANVAS.generation._normalize_gen_settings({
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
        settings = UNICANVAS.generation._normalize_gen_settings({
            "model_selection_mode": "custom",
            "selected_preset_id": "sdxl",
            "generation_mode": "sdxl",
            "model_loader": "checkpoint",
            "ckpt_name": "custom/model.safetensors",
        })

        self.assertEqual(settings["ckpt_name"], "custom/model.safetensors")


if __name__ == "__main__":
    unittest.main()
