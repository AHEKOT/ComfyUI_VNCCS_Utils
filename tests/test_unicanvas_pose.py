"""Two-image pose conditioning and normal UniCanvas output contracts."""
import copy
import unittest
from unittest.mock import patch
from PIL import Image
from test_unicanvas_render import UNICANVAS as UC, _data_url


def payload():
    return {"mode": "img2img", "source_empty": False, "pose_edit": {
        "image1": _data_url(Image.new("RGBA", (64, 64), (200, 10, 20, 255))),
        "image2": _data_url(Image.new("RGBA", (64, 64), (10, 100, 200, 255))),
    }}


class PoseEditContracts(unittest.TestCase):
    def test_reference_order_is_pose_then_background_and_character(self):
        for model in ("qwen_image_edit", "flux_klein"):
            images = UC._prepare_pose_edit_images(payload(), model, (64, 64))
            self.assertEqual([i.getpixel((0, 0)) for i in images], [(200, 10, 20), (10, 100, 200)])
            self.assertTrue(all(i.mode == "RGB" for i in images))
        self.assertIsNone(UC._prepare_pose_edit_images({}, "illustrious", (64, 64)))

    def test_reject_invalid_contract_before_model_loading(self):
        invalid = [
            {**payload(), "mode": "inpaint"}, {**payload(), "source_empty": True},
            {**payload(), "pose_edit": []}, {**payload(), "pose_edit": {"image1": ""}},
            {**payload(), "pose_edit": {**payload()["pose_edit"], "image3": "extra"}},
        ]
        for item in invalid:
            with self.subTest(item=list(item)), self.assertRaises(ValueError):
                UC._prepare_pose_edit_images(item, "qwen_image_edit", (64, 64))
        with self.assertRaisesRegex(ValueError, "dimensions"):
            UC._prepare_pose_edit_images(payload(), "flux_klein", (128, 64))
        with self.assertRaisesRegex(ValueError, "QiE2511"):
            UC._prepare_pose_edit_images(payload(), "krea2_edit", (64, 64))

    def test_inference_always_has_solid_background_even_for_alpha_input(self):
        request = payload()
        request["pose_edit"]["image1"] = _data_url(Image.new("RGBA", (64, 64), (0, 0, 0, 0)))
        images = UC._prepare_pose_edit_images(request, "qwen_image_edit", (64, 64))
        self.assertEqual(images[0].getpixel((0, 0)), (255, 255, 255))

    def test_qwen_pose_path_bypasses_mask_reference_rewriting(self):
        module = UC._get_unicanvas_model_module("qwen_image_edit")
        settings = {"_pose_edit_images": ["pose", "character-on-background"],
                    "draw_mode": "inpaint", "_qwen_edit_mask": "unused", "positive": "studio prompt"}
        calls = []
        def encode(_self, **kwargs):
            calls.append(kwargs)
            return ([], [], {"samples": "latent"})
        with patch.object(type(module), "_encode_qwen_edit", encode), \
             patch.object(UC, "_conditioning_debug", return_value={}), \
             patch.object(UC, "_latent_debug", return_value={}):
            module.prepare_reference_conditioning([], [], "vae", "ordinary-input", settings)
        self.assertEqual(calls[0]["image_tensors"], ["pose", "character-on-background"])
        self.assertEqual(calls[0]["image_tensor"], "pose")
        self.assertEqual(calls[0]["prompt"], "studio prompt")

    def test_klein_reference_pipeline_appends_two_images_to_both_conditionings(self):
        module = UC._get_unicanvas_model_module("flux_klein")
        encoded = []
        def call(names, methods, **kwargs):
            name = names[0]
            if name == "VAEEncode":
                encoded.append(kwargs["pixels"])
                return ({"samples": kwargs["pixels"]},)
            if name == "ConditioningZeroOut":
                result = copy.deepcopy(kwargs["conditioning"])
                result[0][0] = 0
                return (result,)
            if name == "ReferenceLatent":
                result = copy.deepcopy(kwargs["conditioning"])
                result[0][1].setdefault("reference_latents", []).append(kwargs["latent"]["samples"])
                return (result,)
            self.fail(name)
        with patch.object(UC, "_call_node_method", call), \
             patch.object(UC, "_conditioning_debug", return_value={}), \
             patch.object(UC, "_latent_debug", return_value={}):
            positive, negative = module.prepare_reference_conditioning([[1, {}]], [], "vae", "default",
                {"_pose_edit_images": ["pose", "background-and-character"]})
            self.assertEqual(encoded, ["pose", "background-and-character"])
            for cond in (positive, negative):
                self.assertEqual(cond[0][1]["reference_latents"], encoded)
            self.assertEqual(negative[0][0], 0)
            encoded.clear()
            positive, _ = module.prepare_reference_conditioning([[1, {}]], [], "vae", "normal-image", {})
            self.assertEqual(positive[0][1]["reference_latents"], ["normal-image"])

    def test_normal_node_output_composites_pose_as_separate_alpha_layer(self):
        pose = Image.new("RGBA", (2, 2), (0, 0, 0, 0))
        pose.putpixel((1, 0), (255, 0, 0, 255))
        import json
        state = {"version": 2, "bbox": {"x": 0, "y": 0, "width": 2, "height": 2},
                 "origin": {"x": 0, "y": 0}, "layers": [
            {"id": "pose", "type": "pose", "crop": {"width": 2, "height": 2}, "dataURL": _data_url(pose)},
            {"id": "base", "type": "raster", "crop": {"width": 2, "height": 2},
             "dataURL": _data_url(Image.new("RGBA", (2, 2), (0, 40, 80, 255)))},
        ]}
        out = UC._render_unicanvas_state_to_rgba(json.dumps(state))
        self.assertEqual(out.getpixel((0, 0)), (0, 40, 80, 255))
        self.assertEqual(out.getpixel((1, 0)), (255, 0, 0, 255))
        state["layers"][0]["visible"] = False
        self.assertEqual(UC._render_unicanvas_state_to_rgba(json.dumps(state)).getpixel((1, 0)), (0, 40, 80, 255))


if __name__ == "__main__":
    unittest.main()
