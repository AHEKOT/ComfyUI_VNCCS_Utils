"""Pure-logic and source-contract tests for the 3D Factory texture pass."""

import math
import unittest
from pathlib import Path

from helpers.backend_package import service_package

ROOT = Path(__file__).resolve().parents[1]

load = service_package("vnccs_factory_texturing_test")
factory3d_generation = load("nodes.factory3d.generation")
texturing = load("nodes.factory3d.texturing")


class TexturePassContractTest(unittest.TestCase):
    def test_texture_settings_default_off_and_clamped(self):
        default = texturing.normalize_texture_settings({})
        self.assertFalse(default["texture_pass"])
        self.assertEqual(default["texture_prompt"], "")
        self.assertAlmostEqual(default["texture_strength"], 0.6)
        enabled = texturing.normalize_texture_settings({
            "texture_pass": "1",
            "texture_prompt": "A knight in silver armor",
            "texture_strength": "2.5",
        })
        self.assertTrue(enabled["texture_pass"])
        self.assertEqual(enabled["texture_prompt"], "A knight in silver armor")
        self.assertAlmostEqual(enabled["texture_strength"], 1.0)
        with self.assertRaisesRegex(ValueError, "master prompt"):
            texturing.normalize_texture_settings({"texture_pass": "on"})

    def test_mesh_settings_carry_texture_defaults(self):
        settings = factory3d_generation.normalize_mesh_settings(
            {"provider": "trellis2", "quality": "preview"}
        )
        self.assertFalse(settings["texture_pass"])
        self.assertAlmostEqual(settings["texture_strength"], 0.6)
        enabled = factory3d_generation.normalize_mesh_settings(
            {
                "provider": "trellis2",
                "texture_pass": "1",
                "texture_prompt": "A knight in silver armor",
            }
        )
        self.assertTrue(enabled["texture_pass"])
        self.assertEqual(enabled["texture_prompt"], "A knight in silver armor")

    def test_view_plan_orbits_at_rendermesh_framing(self):
        plan = texturing.build_view_plan((0.0, 0.0, 0.0), 1.0)
        self.assertEqual([label for label, _eye, _distance in plan], list(texturing.VIEW_LABELS))
        expected = 1.0 / math.tan(texturing.VIEW_FOV_RADIANS / 2.0) * 1.04
        for _label, eye, distance in plan:
            self.assertAlmostEqual(distance, expected)
            self.assertAlmostEqual(math.sqrt(sum(value * value for value in eye)), expected)
        front = plan[0][1]
        self.assertGreater(front[2], 0.0)
        self.assertGreater(front[1], 0.0)

    def test_texture_prompt_anchors_canvas_and_reference(self):
        prompt = texturing.build_texture_prompt("A knight in silver armor")
        self.assertIn("Edit image 1 as the canvas", prompt)
        self.assertIn("A knight in silver armor", prompt)
        self.assertIn("from image 2", prompt)

    def test_qi2_weights_match_installed_convrot_family(self):
        self.assertEqual(
            texturing.QI2_WEIGHT_FILES,
            (
                "diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
                "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
                "vae/qwen_image_2.1_vae_bf16.safetensors",
            ),
        )

    def test_texture_pass_uses_controlcenter_qi2_sequence(self):
        source = (ROOT / "nodes/factory3d/texturing.py").read_text(encoding="utf-8")
        for marker in (
            '"UNETLoader"',
            '"CLIPLoader"',
            '"VAELoader"',
            '"TextEncodeQwenImage21"',
            "_sampler(",
            '"VAEDecode"',
        ):
            self.assertIn(marker, source)
        self.assertNotIn("gguf", source)
        self.assertNotIn("nunchaku", source)

    def test_generation_pipeline_inserts_texture_pass_before_serialize(self):
        source = (ROOT / "nodes/factory3d/generation.py").read_text(encoding="utf-8")
        pipeline_index = source.index("def run_mesh_generation")
        smooth_index = source.index('textured = _call_node("MeshSmoothNormals"', pipeline_index)
        pass_index = source.index("from .texturing import run_texture_pass", smooth_index)
        apply_index = source.index('"ApplyTextureToMesh"', pass_index)
        serialize_index = source.index('"serialize"', apply_index)
        self.assertLess(pass_index, apply_index)
        self.assertLess(apply_index, serialize_index)

    def test_runtime_exposes_texturing_views_and_capabilities(self):
        source = (ROOT / "nodes/factory3d/runtime.py").read_text(encoding="utf-8")
        self.assertIn("from . import texturing as factory3d_texturing", source)
        self.assertIn('"texturing": _texturing_weights_status()', source)
        self.assertIn('job["texturing"] = {"views": texturing_views}', source)
        self.assertIn("asset/texturing", source)

    def test_asset_route_serves_only_known_texturing_files(self):
        source = (ROOT / "api/factory3d_scene_editor.py").read_text(encoding="utf-8")
        self.assertIn('"texturing",', source)
        self.assertIn('re.fullmatch(', source)
        self.assertIn('view_[0-9]{1,2}_(base|refined)', source)


if __name__ == "__main__":
    unittest.main()

