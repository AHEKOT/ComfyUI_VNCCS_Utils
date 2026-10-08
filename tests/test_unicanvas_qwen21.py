import math
import pytest
torch = pytest.importorskip("torch")

from nodes.unicanvas.models.qwen_image21 import (
    QWEN_IMAGE21_DEFAULTS,
    QWEN_IMAGE21_SUBJECT_EXTRACTION_PROMPT,
    QwenImage21UniCanvasModule,
)
from nodes.unicanvas.models.registry import _get_unicanvas_model_module


def test_module_registered_with_aliases():
    module = _get_unicanvas_model_module("qwen_image21")
    assert isinstance(module, QwenImage21UniCanvasModule)
    assert module.key == "qwen_image21"
    assert _get_unicanvas_model_module("qi21") is module
    assert _get_unicanvas_model_module("qwen-image-2.1") is module
    assert _get_unicanvas_model_module("QwenImage21") is module
    assert module.is_edit_model is True


def test_defaults_follow_qi21_recipe():
    module = _get_unicanvas_model_module("qwen_image21")
    defaults = module.defaults
    # Flow matching sampling: euler/simple; the Viggle v0.2.1 turbo LoRA is on by default,
    # so 6 steps at CFG 1 (verified subject extraction in ~9 s on a 4090).
    from nodes.unicanvas.models.qwen_image21 import QWEN21_TURBO_LORA_NAME, QWEN21_TURBO_STEPS

    assert defaults["steps"] == QWEN21_TURBO_STEPS == 6
    assert defaults["qwen21_turbo_enabled"] is True
    assert defaults["qwen_lora_name"] == QWEN21_TURBO_LORA_NAME
    assert "v0.2.1-6step" in QWEN21_TURBO_LORA_NAME
    assert defaults["sampler"] == "euler"
    assert defaults["sampler_name"] == "euler"
    assert defaults["scheduler"] == "simple"
    assert defaults["cfg"] == 1.0
    assert defaults["denoise"] == 1.0
    # ComfyUI core >= 0.37 loader semantics for the QI2.1 stack.
    assert defaults["model_loader"] == "diffusion_model"
    assert defaults["clip_type"] == "qwen_image"
    assert "qwen21_opaque_output" not in defaults


def test_generation_size_follows_the_canvas():
    module = _get_unicanvas_model_module("qwen_image21")
    assert module.resolve_generation_size(1024, 768, {"qwen21_aspect_preset": "2400x1792"}) == (1024, 768)


def test_create_empty_latent_uses_64_channel_16x_compression():
    module = _get_unicanvas_model_module("qwen_image21")
    latent = module.create_empty_latent(1024, 768, {"batch_size": 1}, draw_id="t")
    assert tuple(latent["samples"].shape) == (1, 64, 48, 64)


def test_reference_prompt_has_no_automatic_transparency_instructions():
    module = _get_unicanvas_model_module("qwen_image21")
    text = module.assemble_instruction("Keep the face from <image2>.", {1: object(), 2: object()})
    assert "RGBA" not in text
    assert "transparent" not in text
    assert "alpha channel" not in text
    assert "Working area: <image1>." in text
    assert "Reference images: <image2>." in text
    assert "Keep the face from <image2>." in text


def test_plain_prompt_has_no_automatic_transparency_instructions():
    module = _get_unicanvas_model_module("qwen_image21")
    text = module.assemble_instruction("a cat", {1: object()})
    assert "RGBA" not in text
    assert "transparent" not in text
    assert text == "Working area: <image1>. a cat"


def test_reference_wiring_slots_and_prompt():
    module = _get_unicanvas_model_module("qwen_image21")
    working = torch.zeros(1, 8, 8, 3)
    refs = {
        "reference_image_1": torch.ones(1, 8, 8, 3),
        "reference_image_3": torch.full((1, 8, 8, 3), 3.0),
        "reference_image_4": torch.full((1, 8, 8, 3), 4.0),
    }
    slots = module.reference_image_slots(working, {"_external": {"references": refs}})
    # Working area is <image1>, Edit model references are <image2..5> in socket order.
    assert slots[1] is working
    assert slots[2] is refs["reference_image_1"]
    assert 3 not in slots
    assert slots[4] is refs["reference_image_3"]
    assert slots[5] is refs["reference_image_4"]
    text = module.assemble_instruction("edit", slots)
    assert "Working area: <image1>." in text
    assert "Reference images: <image2>, <image4>, <image5>." in text


def test_prepare_reference_conditioning_wires_slots(monkeypatch):
    module = _get_unicanvas_model_module("qwen_image21")
    captured = {}

    def fake_encode(self, clip, vae, prompt, negative_prompt, images, resolution, draw_id="unknown"):
        captured.update(
            {
                "clip": clip,
                "prompt": prompt,
                "negative_prompt": negative_prompt,
                "images": images,
                "resolution": resolution,
            }
        )
        return "POS", "NEG"

    class FakeVae:
        def encode(self, pixels):
            captured["vae_pixels"] = pixels
            return {"samples": torch.zeros(1, 64, 1, 1)}

    monkeypatch.setattr(QwenImage21UniCanvasModule, "_encode_qi21", fake_encode)
    working = torch.rand(1, 8, 8, 3)
    ref = torch.rand(1, 8, 8, 3)
    gen_settings = {
        "draw_mode": "img2img",
        "_qwen21_clip": "CLIP",
        "_qwen21_prompt": "Keep the face from <image2>.",
        "_qwen21_negative_prompt": "blurry",
        "_external": {"references": {"reference_image_1": ref}},
    }
    positive, negative = module.prepare_reference_conditioning(None, None, FakeVae(), working, gen_settings, "t")
    assert (positive, negative) == ("POS", "NEG")
    assert captured["clip"] == "CLIP"
    assert captured["negative_prompt"] == "blurry"
    assert torch.equal(captured["images"][1], working)
    assert torch.equal(captured["images"][2], ref)
    assert "Working area: <image1>." in captured["prompt"]
    assert "Keep the face from <image2>." in captured["prompt"]
    # The working area is encoded as RGBA for the 64-channel image VAE.
    assert captured["vae_pixels"].shape == (1, 8, 8, 4)
    assert isinstance(gen_settings["_qwen21_latent"], dict)


def test_prepare_reference_conditioning_txt2img_drops_working_area(monkeypatch):
    module = _get_unicanvas_model_module("qwen_image21")
    captured = {}

    def fake_encode(self, clip, vae, prompt, negative_prompt, images, resolution, draw_id="unknown"):
        captured["images"] = images
        return "POS", "NEG"

    class FakeVae:
        def encode(self, pixels):
            raise AssertionError("txt2img must not encode a working area")

    monkeypatch.setattr(QwenImage21UniCanvasModule, "_encode_qi21", fake_encode)
    ref = torch.rand(1, 8, 8, 3)
    gen_settings = {
        "draw_mode": "txt2img",
        "_qwen21_clip": "CLIP",
        "_qwen21_prompt": "a cat",
        "_external": {"references": {"reference_image_1": ref}},
    }
    module.prepare_reference_conditioning(None, None, FakeVae(), torch.zeros(1, 8, 8, 3), gen_settings, "t")
    assert 1 not in captured["images"]
    assert torch.equal(captured["images"][2], ref)
    assert gen_settings["_qwen21_latent"] is None


def test_encode_prompt_collects_positive_then_negative():
    module = _get_unicanvas_model_module("qwen_image21")
    gen_settings = {}
    module.encode_prompt("CLIP", "positive text", gen_settings)
    module.encode_prompt("CLIP", "negative text", gen_settings)
    assert gen_settings["_qwen21_prompt"] == "positive text"
    assert gen_settings["_qwen21_negative_prompt"] == "negative text"
    assert gen_settings["_qwen21_clip"] == "CLIP"


def test_decode_samples_keeps_alpha_by_default():
    module = _get_unicanvas_model_module("qwen_image21")

    class FakeVae:
        def decode_tiled(self, samples, tile_x=512, tile_y=512, overlap=64):
            decoded = torch.zeros(1, 8, 8, 4)
            decoded[..., :3] = 0.25
            decoded[..., 3] = 0.5
            return decoded

    decoded = module.decode_samples(FakeVae(), {"samples": torch.zeros(1, 64, 1, 1)}, {"qwen21_opaque_output": False})
    # Staging keeps alpha: RGBA stays RGBA.
    assert tuple(decoded.shape) == (1, 8, 8, 4)
    assert torch.all(decoded[..., 3] == 0.5)


def test_decode_samples_preserves_alpha_with_legacy_opaque_setting():
    module = _get_unicanvas_model_module("qwen_image21")

    class FakeVae:
        def decode_tiled(self, samples, tile_x=512, tile_y=512, overlap=64):
            decoded = torch.zeros(1, 8, 8, 4)
            decoded[..., :3] = 0.25
            decoded[..., 3] = 0.5
            return decoded

    decoded = module.decode_samples(FakeVae(), {"samples": torch.zeros(1, 64, 1, 1)}, {"qwen21_opaque_output": True})
    assert tuple(decoded.shape) == (1, 8, 8, 4)
    assert torch.all(decoded[..., :3] == 0.25)
    assert torch.all(decoded[..., 3] == 0.5)


def test_remove_background_contract(monkeypatch):
    module = _get_unicanvas_model_module("qwen_image21")
    captured = {}

    def fake_extraction(self, pixels, settings=None):
        captured["pixels"] = pixels
        alpha = torch.full(pixels.shape[:-1] + (1,), 0.25)
        return torch.cat([pixels, alpha], dim=-1)

    monkeypatch.setattr(QwenImage21UniCanvasModule, "_subject_extraction", fake_extraction)
    image = torch.rand(6, 5, 3)
    rgba = module.remove_background(image)
    assert tuple(rgba.shape) == (6, 5, 4)
    assert rgba.dtype == torch.float32
    assert torch.equal(captured["pixels"], image)
    assert torch.all(rgba[..., 3] == 0.25)
    assert torch.all((rgba >= 0.0) & (rgba <= 1.0))


def test_remove_background_runs_over_the_real_image_geometry(monkeypatch):
    """The (H,W,3) contract input must reach the QI2.1 flow as real geometry.

    Runs the real remove_background -> _subject_extraction ->
    prepare_reference_conditioning -> _qwen21_working_latent path (only the
    asset loader, the ComfyUI node call and the sampler are stubbed) and
    asserts the working latent shape (1,64,H/16,W/16) plus the resolution
    value passed to the text encoder.
    """
    module = _get_unicanvas_model_module("qwen_image21")
    captured = {}
    # The default turbo LoRA resolves (no download) and applies to the fake model as a no-op.
    monkeypatch.setattr("nodes.unicanvas.models.qwen_image21.resolve_qwen21_turbo_lora", lambda: "viggle/turbo.safetensors")
    monkeypatch.setattr("nodes.unicanvas.loras._apply_lora_cached", lambda model, clip, *args, **kwargs: (model, clip))
    monkeypatch.setattr("nodes.unicanvas.models.qwen_image21.apply_viggle_turbo_lora", lambda model, clip, *args: (model, clip))

    class FakeVae:
        def encode(self, pixels):
            captured["encode_pixels"] = pixels
            return {"samples": torch.zeros(1, 64, pixels.shape[1] // 16, pixels.shape[2] // 16)}

        def decode_tiled(self, samples, tile_x=512, tile_y=512, overlap=64):
            decoded = torch.zeros(1, 48, 80, 4)
            decoded[..., :3] = 0.25
            decoded[..., 3] = 0.5
            return decoded

    monkeypatch.setattr(
        "nodes.unicanvas.models.qwen_image21._load_generation_assets",
        lambda settings: ("MODEL", "CLIP", FakeVae()),
    )

    def fake_call_comfy_node(class_name, **kwargs):
        captured.setdefault("calls", []).append((class_name, kwargs))
        if class_name == "TextEncodeQwenImage21":
            return ("POS", "NEG")
        raise AssertionError(f"unexpected node call: {class_name}")

    monkeypatch.setattr("nodes.unicanvas.models.qwen_image21._call_comfy_node", fake_call_comfy_node)

    def fake_sample(**kwargs):
        captured["sample_latent"] = kwargs["latent"]
        return kwargs["latent"]

    monkeypatch.setattr("nodes.unicanvas.models.base._sample_generation_latent_default", fake_sample)

    image = torch.rand(48, 80, 3)  # (H,W,3) contract input
    rgba = module.remove_background(image)

    encode = next(kwargs for name, kwargs in captured["calls"] if name == "TextEncodeQwenImage21")
    # The node's resolution is a square side (~sqrt(48 * 80) = 62 -> 64), not a pixel count.
    assert encode["resolution"] == 64
    assert captured["encode_pixels"].shape == (1, 48, 80, 4)
    assert captured["sample_latent"]["samples"].shape == (1, 64, 3, 5)
    assert tuple(rgba.shape) == (48, 80, 4)
    assert torch.all(rgba[..., 3] == 0.5)


def test_remove_background_accepts_batched_and_resized_results(monkeypatch):
    module = _get_unicanvas_model_module("qwen_image21")

    def fake_extraction_batched(self, pixels, settings=None):
        alpha = torch.full(pixels.shape[:-1] + (1,), 0.75)
        return torch.cat([pixels, alpha], dim=-1).unsqueeze(0)

    monkeypatch.setattr(QwenImage21UniCanvasModule, "_subject_extraction", fake_extraction_batched)
    rgba = module.remove_background(torch.rand(6, 5, 3))
    assert tuple(rgba.shape) == (6, 5, 4)

    def fake_extraction_resized(self, pixels, settings=None):
        alpha = torch.full((3, 4, 1), 0.5)
        return torch.cat([torch.zeros(3, 4, 3), alpha], dim=-1)

    monkeypatch.setattr(QwenImage21UniCanvasModule, "_subject_extraction", fake_extraction_resized)
    rgba = module.remove_background(torch.rand(6, 5, 3))
    assert tuple(rgba.shape) == (6, 5, 4)
    assert torch.all(rgba[..., 3] == 0.5)


def test_remove_background_rejects_bad_inputs():
    module = _get_unicanvas_model_module("qwen_image21")
    with pytest.raises(ValueError, match="\\[VNCCS UniCanvas\\] Remove bg \N{EN DASH} QI2.1"):
        module.remove_background(torch.rand(6, 5, 4))
    with pytest.raises(ValueError, match="\\[VNCCS UniCanvas\\] Remove bg \N{EN DASH} QI2.1"):
        module.remove_background(torch.zeros(6, 3))
    with pytest.raises(ValueError, match="\\[VNCCS UniCanvas\\] Remove bg \N{EN DASH} QI2.1"):
        module.remove_background(torch.zeros(6, 5, 3, dtype=torch.uint8))
    with pytest.raises(ValueError, match="\\[VNCCS UniCanvas\\] Remove bg \N{EN DASH} QI2.1"):
        module.remove_background("not a tensor")


def test_remove_background_extraction_prompt():
    assert QWEN_IMAGE21_SUBJECT_EXTRACTION_PROMPT == "Remove the background, and output a PNG image"


def test_spectrum_is_removed():
    assert "spectrum" not in QWEN_IMAGE21_DEFAULTS
    module = _get_unicanvas_model_module("qwen_image21")
    assert module.supports_step_cache({"spectrum": {"enabled": True}}) is True


# --- Viggle turbo: student schedule + unmerged adapter ---------------------------------


def test_viggle_turbo_sigmas_follow_the_student_nodes():
    from nodes.unicanvas.models.qwen_image21_viggle import viggle_turbo_sigmas

    latent = {"samples": torch.zeros(1, 64, 64, 64)}  # 1024x1024 -> 4096 tokens, shift ~0.69
    sigmas = viggle_turbo_sigmas(latent)
    assert len(sigmas) == 7 and float(sigmas[0]) == pytest.approx(1.0) and float(sigmas[-1]) == 0.0
    assert all(float(a) > float(b) for a, b in zip(sigmas, sigmas[1:]))
    shift = 0.5 + 0.4 * (4096 - 256) / (8192 - 256)
    assert float(sigmas[4]) == pytest.approx(math.exp(shift) / (math.exp(shift) + 1.0), abs=1e-5)  # raw node 0.5
    # img2img keeps only the student nodes at or below the denoise.
    assert torch.allclose(viggle_turbo_sigmas(latent, 0.6), sigmas[4:])


def test_viggle_lora_weights_fold_alpha_rank_and_strength():
    from nodes.unicanvas.models.qwen_image21_viggle import viggle_lora_weights

    sd = {
        "transformer.transformer_blocks.0.attn.to_q.lora_A.weight": torch.ones(2, 4),
        "transformer.transformer_blocks.0.attn.to_q.lora_B.weight": torch.ones(4, 2),
    }
    weights = viggle_lora_weights(sd, {"lora_adapter_metadata": '{"transformer.lora_alpha": 64, "transformer.r": 128}'}, 0.5)
    down, up = weights["transformer_blocks.0.attn.to_q"]
    assert torch.equal(down, torch.ones(2, 4)) and torch.allclose(up, torch.full((4, 2), 0.25))
    with pytest.raises(ValueError):
        viggle_lora_weights({}, None, 1.0)


def test_turbo_lora_runs_unmerged_and_other_loras_merge(monkeypatch):
    from nodes.unicanvas.models import qwen_image21

    calls = []
    monkeypatch.setattr(qwen_image21, "resolve_qwen21_turbo_lora", lambda: qwen_image21.QWEN21_TURBO_LORA_NAME)
    monkeypatch.setattr(qwen_image21, "apply_viggle_turbo_lora", lambda m, c, name, strength: calls.append(("viggle", name, strength)) or (m, c))
    monkeypatch.setattr("nodes.unicanvas.loras._apply_lora_cached", lambda m, c, name, strength, clip_strength=None: calls.append(("merged", name, strength)) or (m, c))
    module = _get_unicanvas_model_module("qwen_image21")
    module.apply_loras("m", "c", {"qwen_lora_name": qwen_image21.QWEN21_TURBO_LORA_NAME, "qwen_lora_strength": 1.0})
    module.apply_loras("m", "c", {"qwen_lora_name": "style.safetensors", "qwen_lora_strength": 0.7})
    assert calls == [("viggle", qwen_image21.QWEN21_TURBO_LORA_NAME, 1.0), ("merged", "style.safetensors", 0.7)]


def test_turbo_model_samples_on_the_viggle_schedule(monkeypatch):
    import comfy.sample as comfy_sample
    import comfy.samplers as comfy_samplers
    from nodes.unicanvas.models.qwen_image21_viggle import VIGGLE_TURBO_MARKER, viggle_turbo_sigmas

    captured = {}

    def fake_sample_custom(model, noise, cfg, sampler, sigmas, positive, negative, latent_image, **kwargs):
        captured.update(cfg=cfg, sampler=sampler, sigmas=sigmas)
        return latent_image + 1

    monkeypatch.setattr(comfy_sample, "fix_empty_latent_channels", lambda model, samples, *a: samples, raising=False)
    monkeypatch.setattr(comfy_sample, "prepare_noise", lambda samples, seed, inds=None: torch.zeros_like(samples), raising=False)
    monkeypatch.setattr(comfy_sample, "sample_custom", fake_sample_custom, raising=False)
    monkeypatch.setattr(comfy_samplers, "sampler_object", lambda name: f"sampler:{name}", raising=False)
    monkeypatch.setattr("nodes.unicanvas.models.base._sample_generation_latent_default", lambda **kw: pytest.fail("KSampler path used for turbo"))

    class TurboModel:
        model_options = {"transformer_options": {VIGGLE_TURBO_MARKER: True}}

    latent = {"samples": torch.zeros(1, 64, 48, 64)}
    module = _get_unicanvas_model_module("qwen_image21")
    out = module.sample_latent(TurboModel(), "POS", "NEG", latent, 7, 6, 1.0, "euler", "simple", 1.0, {}, "t")
    assert captured["sampler"] == "sampler:euler" and captured["cfg"] == 1.0
    assert torch.equal(captured["sigmas"], viggle_turbo_sigmas(latent))
    assert torch.equal(out["samples"], torch.ones(1, 64, 48, 64))


# --- AusBoss outpaint LoRA -----------------------------------------------------------


def test_outpaint_lora_applies_only_in_outpaint(monkeypatch, tmp_path):
    import folder_paths
    from nodes.unicanvas.models import qwen_image21

    calls = []
    installed = tmp_path / qwen_image21.QWEN21_OUTPAINT_LORA_NAME
    installed.parent.mkdir(parents=True)
    installed.touch()
    monkeypatch.setattr(folder_paths, "get_full_path", lambda kind, name: str(tmp_path / name)
                        if (tmp_path / name).is_file() else None)
    monkeypatch.setattr(folder_paths, "get_filename_list", lambda kind: [qwen_image21.QWEN21_OUTPAINT_LORA_NAME])
    monkeypatch.setattr(qwen_image21, "resolve_qwen21_outpaint_lora", lambda: qwen_image21.QWEN21_OUTPAINT_LORA_NAME)
    monkeypatch.setattr("nodes.unicanvas.loras._apply_lora_cached", lambda m, c, name, strength, clip_strength=None: calls.append(name) or (m, c))
    module = _get_unicanvas_model_module("qwen_image21")
    base = {"qwen_lora_name": "", **{k: v for k, v in module.defaults.items() if k.startswith("qwen21_outpaint")}}
    for mode in ("txt2img", "img2img", "inpaint"):
        module.apply_loras("m", "c", {**base, "draw_mode": mode})
    assert calls == []
    module.apply_loras("m", "c", {**base, "draw_mode": "outpaint", "lora_stack": [{"name": "qwen-image-2.1-outpaint-v2.safetensors", "strength": 1.0}]})
    assert calls == [qwen_image21.QWEN21_OUTPAINT_LORA_NAME]  # the user's copy is not applied twice
    calls.clear()
    # Wired by hand into the user's stack, it applies in any mode.
    module.apply_loras("m", "c", {**base, "draw_mode": "img2img", "lora_stack": [{"name": "ausboss/qwen-image-2.1-outpaint-v2.safetensors", "strength": 0.8}]})
    assert calls == ["ausboss/qwen-image-2.1-outpaint-v2.safetensors"]


def test_outpaint_uses_gray_canvas_and_trained_instruction():
    from PIL import Image

    from nodes.unicanvas.models.qwen_image21 import QWEN21_OUTPAINT_INSTRUCTION

    module = _get_unicanvas_model_module("qwen_image21")
    assert module.outpaint_prompt_suffix() == ""
    source = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
    source.putpixel((0, 0), (255, 0, 0, 255))
    padded = module.prepare_outpaint_reference_image(source, None, "t")
    assert padded.mode == "RGB" and padded.getpixel((3, 3)) == (128, 128, 128) and padded.getpixel((0, 0)) == (255, 0, 0)
    text = module.assemble_instruction("a forest at dusk", {1: object()}, outpaint=True)
    assert text == f"{QWEN21_OUTPAINT_INSTRUCTION} Scene: a forest at dusk"
    assert module.assemble_instruction("", {1: object()}, outpaint=True) == QWEN21_OUTPAINT_INSTRUCTION
