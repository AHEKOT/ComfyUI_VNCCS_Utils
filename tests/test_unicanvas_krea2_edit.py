"""Krea2 Edit contract tests; optional tensor checks also run on a CPU-only host."""
import base64
import importlib.util
import io
import json
import math
import sys
import tempfile
import types
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "vnccs_krea2_test"
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT / "nodes")]
sys.modules[PACKAGE] = package


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


try:
    import torch
    import einops
    HAS_TORCH = True
except ImportError:
    torch = types.ModuleType("torch")
    torch.Tensor = object
    HAS_TORCH = False

with patch.dict(sys.modules, {"torch": torch}):
    UC = load(PACKAGE + ".unicanvas", ROOT / "nodes/unicanvas.py")
MODULE = UC._get_unicanvas_model_module("krea2_edit")


def source_url(alpha=255):
    output = io.BytesIO()
    Image.new("RGBA", (64, 64), (24, 48, 96, alpha)).save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


class EditContractTests(unittest.TestCase):
    def settings(self, **kw):
        return UC._normalize_gen_settings({**UC.KREA2_EDIT_DEFAULTS, **kw})

    def test_registry_aliases_and_likeness_preserve_zero(self):
        self.assertIs(UC._get_unicanvas_model_module("krea2-edit"), MODULE)
        self.assertTrue(MODULE.is_edit_model)
        self.assertEqual(self.settings()["krea2_likeness"], 4)
        self.assertEqual(self.settings(krea2_likeness=0, denoise=.2)["krea2_likeness"], 0)
        self.assertEqual(self.settings(denoise=.2)["denoise"], 1)
        for value in [-1, 11, float("inf"), float("nan")]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.settings(krea2_likeness=value)

    def test_card_pins_four_required_assets_and_protects_edit_lora(self):
        preset = next(p for p in UC._unicanvas_load_preset_registry()["presets"] if p["id"] == "krea2_edit")
        self.assertEqual(len(preset["assets"]), 4)
        self.assertNotIn("turbo", preset)
        for asset in preset["assets"]:
            self.assertRegex(asset["hf_revision"], r"^[0-9a-f]{40}$")
            self.assertTrue(asset["local_path"].endswith(".safetensors"))
        normalized = self.settings(model_selection_mode="presets", selected_preset_id="krea2_edit",
                                   krea2_edit_lora_name="wrong.safetensors", krea2_likeness=6.2,
                                   mode_settings={"krea2_edit": {"clip_type": "wrong"}})
        self.assertEqual(normalized["clip_type"], "krea2")
        self.assertEqual(normalized["krea2_edit_lora_name"], preset["settings"]["krea2_edit_lora_name"])
        self.assertEqual(normalized["krea2_likeness"], 6.2)

    def test_missing_edit_lora_keeps_card_uninstalled(self):
        preset = next(p for p in UC._unicanvas_load_preset_registry()["presets"] if p["id"] == "krea2_edit")
        with patch.object(UC, "_unicanvas_load_preset_registry", return_value={"presets": [preset]}), \
             patch.object(UC.os.path, "exists", side_effect=lambda p: "identity_edit" not in p):
            card = UC._get_unicanvas_presets()["presets"][0]
        self.assertFalse(card["installed"])
        self.assertEqual([a["installed"] for a in card["assets"]], [True, True, True, False])

    def test_raw_card_reuses_edit_dependencies_and_enables_guidance(self):
        registry = {p["id"]: p for p in UC._unicanvas_load_preset_registry()["presets"]}
        raw, turbo = registry["krea2_edit_raw"], registry["krea2_edit"]
        self.assertEqual(raw["assets"][1:], turbo["assets"][1:])
        normalized = self.settings(model_selection_mode="presets", selected_preset_id="krea2_edit_raw",
                                   **raw["settings"])
        self.assertEqual(normalized["diffusion_model_name"], "krea2_raw_fp8_scaled.safetensors")
        self.assertEqual(normalized["cfg"], 3)
        self.assertEqual(normalized["steps"], 20)

    def test_card_download_passes_pinned_revision_without_credentials(self):
        asset = next(p for p in UC._unicanvas_load_preset_registry()["presets"] if p["id"] == "krea2_edit")["assets"][3]
        queue = Mock()
        queue.get.side_effect = [("test:edit", asset), StopIteration]
        hub = types.ModuleType("huggingface_hub")
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            cached = root / "cached.safetensors"
            cached.write_bytes(bytes(2048))
            target = root / "models" / "loras" / "edit.safetensors"
            hub.hf_hub_download = Mock(return_value=str(cached))
            stack.enter_context(patch.dict(sys.modules, {"huggingface_hub": hub}))
            stack.enter_context(patch.object(UC, "_PRESET_DOWNLOAD_QUEUE", queue))
            stack.enter_context(patch.object(UC, "_PRESET_DOWNLOAD_STATUS", {}))
            stack.enter_context(patch.object(UC, "_unicanvas_resolve_local_model_path", return_value=str(target)))
            stack.enter_context(patch.object(UC, "_unicanvas_temp_dir", return_value=str(root / "temp")))
            with self.assertRaises(StopIteration):
                UC._unicanvas_download_worker_loop()
            hub.hf_hub_download.assert_called_once_with(repo_id=asset["hf_repo"], filename=asset["hf_path"],
                                                       repo_type="model", revision=asset["hf_revision"], token=False)
            self.assertEqual(target.read_bytes(), cached.read_bytes())
            self.assertEqual(UC._PRESET_DOWNLOAD_STATUS["test:edit"]["status"], "success")
            queue.task_done.assert_called_once()

    def test_edit_lora_is_mandatory_fixed_strength_and_not_duplicated(self):
        name = UC.KREA2_EDIT_DEFAULTS["krea2_edit_lora_name"]
        with patch.object(UC, "_apply_lora_cached", return_value=("model", "clip")) as apply:
            MODULE.apply_loras("model", "clip", self.settings(turbo_enabled=False, lora_stack=[
                {"name": name, "strength": .2}, {"name": "style.safetensors", "strength": .7}]))
        self.assertEqual(apply.call_count, 2)
        self.assertEqual(apply.call_args_list[0].args[2:], (name, 1.0))
        self.assertEqual(apply.call_args_list[0].kwargs, {"clip_strength": 0.0})
        self.assertEqual(apply.call_args_list[1].args[2:4], ("style.safetensors", .7))
        with patch.object(UC, "_apply_lora_cached", side_effect=ValueError("LoRA not found")), self.assertRaisesRegex(ValueError, "LoRA not found"):
            MODULE.apply_loras(None, None, self.settings())

    def test_prompt_is_image_grounded_on_both_branches_and_releases_clip(self):
        helper = types.ModuleType(PACKAGE + ".unicanvas_krea2_edit")
        encoder = Mock()
        encoder.encode.side_effect = [("positive",), ("negative",)]
        helper.Krea2EditGroundedEncode = Mock(return_value=encoder)
        clip, image, vae = object(), object(), object()
        settings = self.settings()
        instruction = MODULE.encode_prompt(clip, "Change the sky", settings)
        with patch.dict(sys.modules, {helper.__name__: helper}):
            result = MODULE.prepare_reference_conditioning(instruction, "ignored", vae, image, settings)
        self.assertEqual(result, ("positive", "negative"))
        self.assertEqual(encoder.encode.call_args_list[0].args, (clip, "Change the sky"))
        self.assertEqual(encoder.encode.call_args_list[1].args, (clip, ""))
        for call in encoder.encode.call_args_list:
            self.assertIs(call.kwargs["image"], image)
            self.assertEqual(call.kwargs["grounding_px"], 768)
        self.assertNotIn("_krea2_edit_clip", settings)

    def test_sampling_patches_same_target_latent_and_forces_full_denoise(self):
        helper = types.ModuleType(PACKAGE + ".unicanvas_krea2_edit")
        helper.patch_krea2_edit = Mock(return_value="patched")
        settings = self.settings(krea2_likeness=7.1)
        settings.update(_krea2_edit_image="image", _krea2_edit_vae="vae")
        latent = {"samples": object()}
        with patch.dict(sys.modules, {helper.__name__: helper}), \
             patch.object(UC, "_sample_generation_latent_default", return_value="result") as sample:
            result = MODULE.sample_latent("original", "pos", "neg", latent, 17, 10, 1, "euler", "simple", .2, settings)
        self.assertEqual(result, "result")
        helper.patch_krea2_edit.assert_called_once_with("original", "vae", "image", latent, 7.1)
        self.assertEqual(sample.call_args.kwargs["denoise"], 1)
        self.assertEqual(sample.call_args.kwargs["model"], "patched")
        self.assertIs(sample.call_args.kwargs["latent"], latent)
        self.assertNotIn("_krea2_edit_image", settings)

    def test_empty_latent_uses_sd3_channels_and_batch_contract(self):
        expected = {"samples": object()}
        with patch.object(UC, "_call_node_method", return_value=expected) as node:
            self.assertIs(MODULE.create_empty_latent(1024, 768, {"batch_size": 3}), expected)
        self.assertEqual(node.call_args.args[0], ["EmptySD3LatentImage"])
        self.assertEqual(node.call_args.kwargs, {"width": 1024, "height": 768, "batch_size": 3})

    def test_text_only_or_empty_source_rejected_before_loading_weights(self):
        for mode, empty, alpha in [("txt2img", False, 255), ("img2img", True, 255), ("inpaint", False, 0)]:
            with self.subTest(mode=mode, empty=empty, alpha=alpha), \
                 patch.object(UC, "_load_generation_assets") as loader, self.assertRaisesRegex(ValueError, "requires an image"):
                UC._run_unicanvas_draw({"settings": self.settings(), "mode": mode, "source_empty": empty, "image": source_url(alpha)})
            loader.assert_not_called()

    @unittest.skipUnless(HAS_TORCH, "CPU torch is optional in the lightweight CI job")
    def test_all_edit_modes_use_noise_target_and_keep_final_mask_compositing(self):
        for mode in ["img2img", "inpaint", "outpaint"]:
            with self.subTest(mode=mode), ExitStack() as stack:
                prepared = Mock(return_value=([ [torch.zeros(1, 1, 1), {}] ], [ [torch.zeros(1, 1, 1), {}] ]))
                target = {"samples": torch.zeros(1, 16, 8, 8)}
                replacements = {
                    "_load_generation_assets": (object(), object(), object()),
                    "_apply_generation_loras": (object(), object()),
                    "_create_empty_generation_latent": target,
                    "_decode_generation_samples": torch.ones(1, 64, 64, 3),
                    "_save_temp_image": {"filename": "result.png"},
                }
                for name, result in replacements.items():
                    stack.enter_context(patch.object(UC, name, return_value=result))
                stack.enter_context(patch.object(UC.Krea2EditUniCanvasModule, "prepare_reference_conditioning", prepared))
                masked = stack.enter_context(patch.object(UC, "_prepare_masked_generation_latent", side_effect=AssertionError("must not use SD inpaint latent")))
                encode = stack.enter_context(patch.object(UC, "_encode_source_latent", side_effect=AssertionError("must not initialize with source")))
                sampler = stack.enter_context(patch.object(UC, "_sample_generation_latent", return_value=target))
                result = UC._run_unicanvas_draw({"settings": self.settings(), "mode": mode, "image": source_url(), "mask": source_url()})
                self.assertEqual(result["generation_mode"], "krea2_edit")
                self.assertEqual(result["width"], 64)
                self.assertEqual(bool(result["mask"]), mode != "img2img")
                self.assertIs(sampler.call_args.kwargs["latent"], target)
                self.assertEqual(sampler.call_args.kwargs["denoise"], 1)
                masked.assert_not_called()
                encode.assert_not_called()


def comfy_stubs():
    names = ["comfy", "comfy.patcher_extension", "comfy.utils", "comfy.ldm", "comfy.ldm.common_dit", "comfy.ldm.flux", "comfy.ldm.flux.layers"]
    modules = {name: types.ModuleType(name) for name in names}
    for name in names[1:]:
        parent, attr = name.rsplit(".", 1)
        setattr(modules[parent], attr, modules[name])
    pe = modules["comfy.patcher_extension"]
    pe.WrappersMP = types.SimpleNamespace(DIFFUSION_MODEL="diffusion_model")
    pe.add_wrapper_with_key = lambda kind, key, fn, options: options.update(wrapper=fn)
    modules["comfy.ldm.flux.layers"].timestep_embedding = lambda t, dim: torch.zeros(t.shape[0], dim)
    modules["comfy.ldm.common_dit"].pad_to_patch_size = lambda x, p, **kw: torch.nn.functional.pad(x, (0, -x.shape[-1] % p[1], 0, -x.shape[-2] % p[0]), mode="replicate")
    modules["comfy.utils"].common_upscale = lambda x, w, h, *_: torch.nn.functional.interpolate(x, (h, w), mode="area")
    return modules


@unittest.skipUnless(HAS_TORCH, "CPU torch is optional in the lightweight CI job")
class EditTensorTests(unittest.TestCase):
    def setUp(self):
        self.context = patch.dict(sys.modules, comfy_stubs())
        self.context.start()
        self.addCleanup(self.context.stop)
        self.core = load(PACKAGE + ".unicanvas_krea2_edit", ROOT / "nodes/unicanvas_krea2_edit.py")

    def test_likeness_is_log_bias_only_on_target_to_source(self):
        for boost in [0, .5, 1, 4, 10]:
            bias = self.core._ref_attn_bias([boost], None, 2, [3], 4, [(1, 3)], "cpu", torch.float32)
            expected = torch.zeros(1, 1, 9, 9)
            expected[:, :, 5:, 2:5] = math.log(max(boost, 1e-4))
            self.assertTrue(torch.allclose(bias, expected))
            weights = bias[0, 0, 5].softmax(-1)
            self.assertAlmostEqual((weights[2] / weights[0]).item(), max(boost, 1e-4), places=4)

    def test_grounding_caps_resolution_and_requires_image(self):
        encoder = self.core.Krea2EditGroundedEncode()
        clip = Mock()
        clip.encode_from_tokens_scheduled.return_value = "conditioning"
        self.assertEqual(encoder.encode(clip, "edit", image=torch.zeros(1, 800, 1600, 4))[0], "conditioning")
        call = clip.tokenize.call_args
        self.assertEqual(call.kwargs["images"][0].shape, (1, 384, 768, 3))
        self.assertIn("<|vision_start|><|image_pad|><|vision_end|>{}", call.kwargs["llama_template"])
        with self.assertRaisesRegex(ValueError, "source image"):
            encoder.encode(clip, "edit")

    def test_fit_uses_pixels_preserves_aspect_and_cache(self):
        vae = Mock()
        vae.encode.side_effect = lambda pixels: torch.zeros(1, 16, pixels.shape[1] // 8, pixels.shape[2] // 8)
        cache = {}
        image = torch.zeros(1, 64, 128, 3)
        result = self.core._fit_encode_image(image, vae, 16, 16, cache, ("image",), "fit")
        self.assertEqual(result.shape[-2:], (8, 16))
        self.assertIs(result, self.core._fit_encode_image(image, vae, 16, 16, cache, ("image",), "fit"))
        vae.encode.assert_called_once()
        positions = self.core._imgids_offset(1, 1, 3, 4, 4, 4, "cpu")
        self.assertEqual(positions[0, 0].tolist(), [1, .5, 0])

    def test_wrapper_encodes_once_before_sampling_and_handles_native_signatures(self):
        dm = types.SimpleNamespace(**dict.fromkeys(("patch", "channels", "_unpack_context", "first", "txtfusion", "txtmlp", "tmlp", "tproj", "tdim", "pe_embedder", "blocks", "last")))
        original = Mock()
        original.model.diffusion_model = dm
        original.model.process_latent_in.side_effect = lambda x: x * 2
        cloned = types.SimpleNamespace(model_options={})
        original.clone.return_value = cloned
        vae = Mock()
        vae.encode.return_value = torch.ones(1, 16, 8, 8)
        target = {"samples": torch.zeros(2, 16, 8, 8)}
        patched = self.core.patch_krea2_edit(original, vae, torch.zeros(1, 64, 64, 3), target, 4)
        vae.encode.assert_called_once()
        wrapper = patched.model_options["transformer_options"]["wrapper"]
        executor = types.SimpleNamespace(class_obj=dm)
        options = {"sentinel": 1}
        with patch.object(self.core, "krea2_edit_forward", return_value="result") as forward:
            for extra in [(None, options), (None, [], options)]:
                self.assertEqual(wrapper(executor, target["samples"], None, None, *extra), "result")
                self.assertIs(forward.call_args.args[5], options)
                self.assertEqual(forward.call_args.args[4].mean().item(), 2)
                self.assertEqual(forward.call_args.kwargs["ref_boost"], 4)
            wrapper(executor, target["samples"], None, None, transformer_options=options)
            self.assertIs(forward.call_args.args[5], options)
        vae.encode.assert_called_once()
        with self.assertRaisesRegex(ValueError, "resolution changed"):
            wrapper(executor, torch.zeros(1, 16, 16, 8), None, None)

    def test_forward_orders_clean_reference_and_keeps_only_target(self):
        seen = {}
        def block(combined, *args, **kwargs):
            seen["sequence"] = combined.clone()
            return combined
        dm = types.SimpleNamespace(patch=1, channels=1, tdim=1,
            _unpack_context=lambda x: x, first=lambda x: x, tmlp=lambda x: x,
            tproj=lambda x: x, txtfusion=lambda x, **_: x, txtmlp=lambda x: x,
            pe_embedder=lambda positions: seen.update(positions=positions), blocks=[block], last=lambda x, t: x)
        x = torch.full((2, 1, 1, 2, 2), 3.)
        result = self.core.krea2_edit_forward(dm, x, torch.zeros(2), torch.ones(2, 2, 1), torch.full((1, 1, 2, 2), 2.), {}, ref_boost=4, ref_native=True, pos_mode="stride1")
        self.assertTrue(torch.allclose(result, x))
        self.assertEqual(seen["sequence"][0, :, 0].tolist(), [1, 1, 2, 2, 2, 2, 3, 3, 3, 3])
        self.assertEqual(seen["positions"][0, :, 0].tolist(), [0, 0, 1, 1, 1, 1, 0, 0, 0, 0])


if __name__ == "__main__":
    unittest.main()
