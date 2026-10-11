import pytest
torch = pytest.importorskip("torch")

from nodes.unicanvas.models.qwen_image21 import (
    QWEN_IMAGE21_DEFAULTS,
    QWEN_IMAGE21_SUBJECT_EXTRACTION_PROMPT,
    QwenImage21UniCanvasModule,
)
from nodes.unicanvas.models.registry import _get_unicanvas_model_module


@pytest.fixture(autouse=True)
def native_latent_and_decode_nodes(monkeypatch):
    import nodes

    class EmptyLatentImage:
        FUNCTION = "generate"
        def generate(self, width, height, batch_size):
            return ({"samples": torch.zeros(batch_size, 4, height // 8, width // 8), "downscale_ratio_spacial": 8},)

    class VAEDecode:
        FUNCTION = "decode"

        def decode(self, samples, vae):
            return (vae.decode(samples["samples"]),)

    monkeypatch.setattr(nodes, "EmptyLatentImage", EmptyLatentImage, raising=False)
    monkeypatch.setattr(nodes, "NODE_CLASS_MAPPINGS", {"VAEDecode": VAEDecode, "EmptyLatentImage": EmptyLatentImage}, raising=False)


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


@pytest.mark.parametrize("width,height", [(2048, 2048), (1984, 1536)])
@pytest.mark.parametrize("mode", ["img2img", "inpaint", "outpaint"])
def test_canvas_reference_and_sampling_share_native_encoder_geometry(monkeypatch, width, height, mode):
    from types import SimpleNamespace
    from nodes.unicanvas.models import qwen_image21

    native = {"samples": torch.zeros(1, 64, height // 16, width // 16)}
    calls = []
    monkeypatch.setattr(qwen_image21, "_call_comfy_node", lambda name, **kwargs: calls.append((name, kwargs)) or ("POS", "NEG", native))
    module = _get_unicanvas_model_module("qwen_image21")
    image = torch.zeros(1, height, width, 3)
    settings = {"draw_mode": mode, "_qwen21_clip": "CLIP", "_qwen21_prompt": "Continue the scene."}
    module.prepare_reference_conditioning(None, None, object(), image, settings)
    assert calls[0][1]["resolution"] == 0, "Resizing the reference separately shifts the generated pixels"
    ctx = SimpleNamespace(settings=settings, width=width, height=height, mode=mode, denoise=0.3, draw_id="geometry")
    assert module.prepare_generation_latent(ctx) is native
    assert ctx.denoise == 1.0 and "_qwen21_latent" not in settings
    assert "noise_mask" not in native


@pytest.mark.parametrize("mode", ["inpaint", "outpaint"])
def test_masked_qwen_edit_removes_source_pixels_and_keeps_canvas_coordinates(mode):
    from types import SimpleNamespace
    from PIL import Image

    module = _get_unicanvas_model_module("qwen_image21")
    source = Image.new("RGBA", (96, 64), (10, 30, 50, 255))
    mask = Image.new("RGBA", source.size)
    mask.paste((255, 255, 255, 255), (47, 19, 63, 36))
    mask.putpixel((46, 20), (255, 255, 255, 128))
    if mode == "outpaint":
        from nodes.unicanvas.masking import _combine_mask_with_source_alpha

        source.putpixel((70, 20), (0, 0, 0, 0))
        mask = _combine_mask_with_source_alpha(mask, source)
    ctx = SimpleNamespace(mode=mode, source_rgba=source, source=source.convert("RGB"),
                          reference_source=source.convert("RGB"), mask_image=mask, draw_id="hole")
    if mode == "outpaint":
        ctx.source = ctx.reference_source = module.prepare_outpaint_reference_image(source, mask, ctx.draw_id)
    module.on_mask_prepared(ctx)
    assert ctx.reference_source.size == source.size
    assert ctx.reference_source.getpixel((48, 20)) == (128, 128, 128), "The mask is a hole, not a retained source pixel"
    assert ctx.reference_source.getpixel((46, 20)) == (128, 128, 128), "Feather the paste, not the gray reference"
    assert ctx.reference_source.getpixel((45, 20)) == (10, 30, 50)
    if mode == "outpaint":
        assert ctx.reference_source.getpixel((70, 20)) == (128, 128, 128)
    assert source.getpixel((48, 20)) == (10, 30, 50, 255)


@pytest.mark.parametrize("width,height", [(1024, 768), (2048, 2048)])
def test_create_empty_latent_uses_native_empty_latent_with_scale_metadata(width, height):
    module = _get_unicanvas_model_module("qwen_image21")
    latent = module.create_empty_latent(width, height, {"batch_size": 1}, draw_id="t")
    assert tuple(latent["samples"].shape) == (1, 4, height // 8, width // 8)
    assert latent["downscale_ratio_spacial"] == 8


def test_reference_prompt_is_only_the_user_text():
    module = _get_unicanvas_model_module("qwen_image21")
    text = module.assemble_instruction("Keep the face from <image2>.", {1: object(), 2: object()})
    assert text == "Keep the face from <image2>."


def test_plain_prompt_is_preserved_verbatim():
    module = _get_unicanvas_model_module("qwen_image21")
    text = module.assemble_instruction("  1girl \n", {1: object()})
    assert text == "  1girl \n"


def test_reference_wiring_slots_and_prompt():
    module = _get_unicanvas_model_module("qwen_image21")
    working = torch.zeros(1, 8, 8, 3)
    refs = {
        "reference_image_1": torch.ones(1, 8, 8, 3),
        "reference_image_3": torch.full((1, 8, 8, 3), 3.0),
        "reference_image_4": torch.full((1, 8, 8, 3), 4.0),
    }
    slots = module.reference_image_slots(working, {"_external": {"references": refs}})
    # Native QI2 numbers only connected images, without gaps.
    assert slots[1] is working
    assert slots[2] is refs["reference_image_1"]
    assert slots[3] is refs["reference_image_3"]
    assert slots[4] is refs["reference_image_4"]
    text = module.assemble_instruction("edit", slots)
    assert text == "edit"


@pytest.mark.parametrize("mode", ["img2img", "inpaint", "outpaint"])
def test_prepare_reference_conditioning_wires_slots_and_preserves_user_prompt(monkeypatch, mode):
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
        return "POS", "NEG", {"samples": torch.zeros(1, 64, 2, 2)}

    class FakeVae:
        def encode(self, pixels):
            pytest.fail("A reference must not also become the sampling latent")

    monkeypatch.setattr(QwenImage21UniCanvasModule, "_encode_qi21", fake_encode)
    working = torch.rand(1, 8, 8, 3)
    ref = torch.rand(1, 8, 8, 3)
    gen_settings = {
        "draw_mode": mode,
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
    expected_prompt = "Keep the face from <image2>."
    if mode in {"inpaint", "outpaint"}:
        from nodes.unicanvas.models.qwen_image21 import QWEN21_OUTPAINT_INSTRUCTION
        expected_prompt = f"{QWEN21_OUTPAINT_INSTRUCTION} {expected_prompt}"
    assert captured["prompt"] == expected_prompt
    assert captured["resolution"] == 0
    assert gen_settings["_qwen21_latent"]["samples"].shape == (1, 64, 2, 2)


def test_prepare_reference_conditioning_txt2img_drops_working_area(monkeypatch):
    module = _get_unicanvas_model_module("qwen_image21")
    captured = {}

    def fake_encode(self, clip, vae, prompt, negative_prompt, images, resolution, draw_id="unknown"):
        captured["images"] = images
        return "POS", "NEG", None

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
    assert list(captured["images"]) == [1]
    assert torch.equal(captured["images"][1], ref)
    assert "_qwen21_latent" not in gen_settings


def test_encode_prompt_collects_positive_then_negative():
    module = _get_unicanvas_model_module("qwen_image21")
    gen_settings = {}
    module.encode_prompt("CLIP", "positive text", gen_settings)
    module.encode_prompt("CLIP", "negative text", gen_settings)
    assert gen_settings["_qwen21_prompt"] == "positive text"
    assert gen_settings["_qwen21_negative_prompt"] == "negative text"
    assert gen_settings["_qwen21_clip"] == "CLIP"


@pytest.mark.parametrize("mode", ["txt2img", "img2img", "inpaint", "outpaint"])
@pytest.mark.parametrize("use_layers", [True, False])
def test_every_mode_samples_empty_latent_at_full_denoise(mode, use_layers):
    from types import SimpleNamespace
    from nodes.unicanvas.draw_request import DrawRequest

    request = DrawRequest.from_payload({"mode": mode, "settings": {
        "generation_mode": "qwen_image21", "denoise": 0.3, "edit_use_layers_as_reference": use_layers,
    }})
    assert request.denoise == 1.0
    ctx = SimpleNamespace(settings=request.settings, width=1024, height=768, mode=mode, denoise=request.denoise, draw_id="empty")
    latent = request.module.prepare_generation_latent(ctx)
    assert latent["samples"].shape == (1, 4, 96, 128)
    assert torch.count_nonzero(latent["samples"]) == 0


@pytest.mark.parametrize("pixels", [0.0, 0.5])
def test_rgba_reference_geometry_is_independent_of_pixel_content(monkeypatch, pixels):
    from nodes.unicanvas.models import qwen_image21

    image = torch.full((1, 128, 256, 4), pixels)
    image[..., 3] = 0.25
    seen = []
    native = {"samples": torch.zeros(1, 64, 8, 16)}
    monkeypatch.setattr(qwen_image21, "_call_comfy_node", lambda name, **kw: seen.append((name, kw)) or ("POS", "NEG", native))
    settings = {"draw_mode": "img2img", "_qwen21_clip": "CLIP", "_qwen21_prompt": "edit"}
    _get_unicanvas_model_module("qwen_image21").prepare_reference_conditioning(None, None, object(), image, settings)
    assert seen[0][1]["resolution"] == 0
    assert torch.equal(seen[0][1]["images"]["image_1"], image)
    assert settings["_qwen21_latent"] is native


@pytest.mark.parametrize("dynamic", [False, True])
def test_qi2_uses_comfys_native_non_dynamic_delegate(dynamic):
    from types import SimpleNamespace
    from unittest.mock import Mock

    model_clone, clip_clone = object(), object()
    native = SimpleNamespace(clone=Mock(return_value=model_clone))
    model = SimpleNamespace(is_dynamic=lambda: dynamic, get_non_dynamic_delegate=Mock(return_value=native), clone=Mock(return_value=model_clone))
    clip = SimpleNamespace(clone=Mock(return_value=clip_clone))
    assert _get_unicanvas_model_module("qwen_image21").clone_assets(model, clip) == (model_clone, clip_clone)
    assert model.get_non_dynamic_delegate.call_count == int(dynamic)
    assert native.clone.call_count == int(dynamic)
    assert model.clone.call_count == int(not dynamic)
    clip.clone.assert_called_once()


def test_model_uses_native_qi2_cache_and_never_easycache(monkeypatch):
    from types import SimpleNamespace
    from nodes.unicanvas.models import qwen_image21

    calls = []
    monkeypatch.setattr(qwen_image21, "_call_comfy_node", lambda name, **kw: calls.append((name, kw)) or ("cached",))
    module = _get_unicanvas_model_module("qwen_image21")
    ctx = SimpleNamespace(model="base", settings={})
    assert module.prepare_model_for_sampling(ctx) == "cached"
    assert ctx.settings["_attention_backend"] == "attention_pytorch"
    assert calls == [("QwenImage21Cache", {"model": "base", "device": "auto", "dtype": "default"}),
                     ("ModelAttentionBackend", {"model": "cached", "attention": "pytorch attention"})]
    assert module.supports_step_cache({"step_cache": True}) is False


def test_decode_samples_keeps_alpha_by_default():
    module = _get_unicanvas_model_module("qwen_image21")

    class FakeVae:
        def decode(self, samples):
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
        def decode(self, samples):
            decoded = torch.zeros(1, 8, 8, 4)
            decoded[..., :3] = 0.25
            decoded[..., 3] = 0.5
            return decoded

    decoded = module.decode_samples(FakeVae(), {"samples": torch.zeros(1, 64, 1, 1)}, {"qwen21_opaque_output": True})
    assert tuple(decoded.shape) == (1, 8, 8, 4)
    assert torch.all(decoded[..., :3] == 0.25)
    assert torch.all(decoded[..., 3] == 0.5)


def test_vae_chunking_is_an_explicit_option():
    from nodes.unicanvas.performance import apply_vae_chunking

    calls = []
    class Vae:
        def decode(self, samples):
            calls.append("full")
            return samples
        def decode_tiled(self, samples):
            calls.append("tiled")
            return samples
    module = _get_unicanvas_model_module("qwen_image21")
    for chunking in (False, True):
        settings = {"vae_chunking": chunking}
        module.decode_samples(apply_vae_chunking(Vae(), settings), {"samples": torch.zeros(1, 64, 1, 1)}, settings)
    assert calls == ["full", "tiled"]


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

    Exercise the reference encoder, its empty latent, KV cache and
    standard decoder without loading model weights.
    """
    module = _get_unicanvas_model_module("qwen_image21")
    captured = {}
    # The default turbo LoRA resolves (no download) and applies to the fake model as a no-op.
    monkeypatch.setattr("nodes.unicanvas.models.qwen_image21.resolve_qwen21_turbo_lora", lambda: "viggle/turbo.safetensors")
    monkeypatch.setattr("nodes.unicanvas.loras._apply_lora_cached", lambda model, clip, *args, **kwargs: (model, clip))
    monkeypatch.setattr("nodes.unicanvas.models.qwen_image21.apply_viggle_turbo_lora", lambda model, clip, *args: (model, clip))

    class FakeVae:
        def encode(self, pixels):
            pytest.fail("Must sample an empty latent")

        def decode(self, samples):
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
            return ("POS", "NEG", {"samples": torch.zeros(1, 64, 4, 4)})
        if class_name in {"QwenImage21Cache", "ModelAttentionBackend"}:
            return (kwargs["model"],)
        if class_name == "KSampler":
            captured["sample_latent"] = kwargs["latent_image"]
            return (kwargs["latent_image"],)
        if class_name == "VAEDecode":
            return (kwargs["vae"].decode(kwargs["samples"]["samples"]),)
        raise AssertionError(f"unexpected node call: {class_name}")

    monkeypatch.setattr("nodes.unicanvas.models.qwen_image21._call_comfy_node", fake_call_comfy_node)
    monkeypatch.setattr("nodes.unicanvas.models.base._call_comfy_node", fake_call_comfy_node)
    monkeypatch.setattr("nodes.unicanvas.sampling._call_comfy_node", fake_call_comfy_node)

    image = torch.rand(48, 80, 3)  # (H,W,3) contract input
    rgba = module.remove_background(image)

    encode = next(kwargs for name, kwargs in captured["calls"] if name == "TextEncodeQwenImage21")
    assert encode["resolution"] == 0
    assert captured["sample_latent"]["samples"].shape == (1, 64, 4, 4)
    assert [name for name, _ in captured["calls"]] == ["QwenImage21Cache", "ModelAttentionBackend", "TextEncodeQwenImage21", "KSampler", "VAEDecode"]
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
    assert module.supports_step_cache({"spectrum": {"enabled": True}}) is False


# --- Viggle turbo: student schedule + native LoRA loader -------------------------------


def test_viggle_schedule_is_delegated_to_the_registered_node(monkeypatch):
    from nodes.unicanvas.models import qwen_image21_viggle as viggle

    latent = {"samples": torch.zeros(1, 64, 128, 128)}
    native_sigmas = torch.tensor([1, .98, .95, .9, .8, .6, 0])
    calls = []
    monkeypatch.setattr(viggle, "_call_comfy_node", lambda name, **kwargs: calls.append((name, kwargs)) or (native_sigmas,))
    assert viggle.viggle_turbo_sigmas(latent) is native_sigmas
    assert calls == [("ViggleTurboSigmas", {"latent": latent, "nodes": "1.0, 0.9375, 0.875, 0.75, 0.5, 0.25"})]


def test_viggle_adapter_is_owned_by_the_registered_node(monkeypatch):
    from nodes.unicanvas.models import qwen_image21_viggle as viggle
    from types import SimpleNamespace

    base = SimpleNamespace(model_options={})
    patched = SimpleNamespace(model_options={})
    clip = object()
    calls = []
    monkeypatch.setattr(viggle, "_call_comfy_node", lambda name, **kwargs: calls.append((name, kwargs)) or (patched,))
    assert viggle.apply_viggle_turbo_lora(base, clip, "turbo.safetensors", .7) == (patched, clip)
    assert calls == [("LoraLoaderModelOnly", {"model": base, "lora_name": "turbo.safetensors", "strength_model": .7})]
    assert viggle.has_viggle_turbo(patched)
    assert not viggle.has_viggle_turbo(base)


def test_turbo_lora_selects_student_schedule_and_other_loras_use_native_loader(monkeypatch):
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
    from nodes.unicanvas.models import qwen_image21
    from nodes.unicanvas.models.qwen_image21_viggle import VIGGLE_TURBO_MARKER

    calls = []
    def node(name, **kwargs):
        calls.append((name, kwargs))
        return ({"samples": kwargs["latent_image"]["samples"] + 1},) if name == "SamplerCustomAdvanced" else (name,)

    native_sigmas = torch.tensor([1, .9, .8, .7, .6, .5, 0])
    monkeypatch.setattr(qwen_image21, "viggle_turbo_sigmas", lambda latent: native_sigmas)
    monkeypatch.setattr(qwen_image21, "_call_comfy_node", node)
    monkeypatch.setattr("nodes.unicanvas.models.base._sample_generation_latent_default", lambda **kw: pytest.fail("KSampler path used for turbo"))

    class TurboModel:
        model_options = {"transformer_options": {VIGGLE_TURBO_MARKER: True}}

    latent = {"samples": torch.zeros(1, 64, 48, 64)}
    module = _get_unicanvas_model_module("qwen_image21")
    out = module.sample_latent(TurboModel(), "POS", "NEG", latent, 7, 6, 1.0, "euler", "simple", 1.0, {}, "t")
    assert [name for name, _ in calls] == ["RandomNoise", "BasicGuider", "KSamplerSelect", "SamplerCustomAdvanced"]
    assert calls[0][1] == {"noise_seed": 7}
    assert calls[1][1]["conditioning"] == "POS" and "negative" not in calls[1][1]
    assert calls[2][1] == {"sampler_name": "euler"}
    assert torch.equal(calls[3][1]["sigmas"], native_sigmas)
    assert calls[3][1]["latent_image"] is latent
    assert torch.equal(out["samples"], torch.ones(1, 64, 48, 64))


@pytest.mark.parametrize("steps,cfg,denoise", [(25, 1, 1), (6, 3, 1), (6, 1, 0.5)])
def test_turbo_rejects_parameters_that_change_the_reference_schedule(monkeypatch, steps, cfg, denoise):
    from types import SimpleNamespace
    from nodes.unicanvas.models import qwen_image21
    from nodes.unicanvas.models.qwen_image21_viggle import VIGGLE_TURBO_MARKER

    model = SimpleNamespace(model_options={"transformer_options": {VIGGLE_TURBO_MARKER: True}})
    monkeypatch.setattr(qwen_image21, "_call_comfy_node", lambda *a, **k: pytest.fail("must reject before sampling"))
    with pytest.raises(ValueError, match="6 steps, CFG 1 and denoise 1"):
        _get_unicanvas_model_module("qwen_image21").sample_latent(model, "POS", "NEG", {}, 7, steps, cfg, "euler", "simple", denoise, {})


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
    for mode in ("txt2img", "img2img"):
        module.apply_loras("m", "c", {**base, "draw_mode": mode})
    assert calls == []
    for mode in ("inpaint", "outpaint"):
        module.apply_loras("m", "c", {**base, "draw_mode": mode, "lora_stack": [{"name": "qwen-image-2.1-outpaint-v2.safetensors", "strength": 1.0}]})
        assert calls == [qwen_image21.QWEN21_OUTPAINT_LORA_NAME]  # the user's copy is not applied twice
        calls.clear()
    # Wired by hand into the user's stack, it applies in any mode.
    module.apply_loras("m", "c", {**base, "draw_mode": "img2img", "lora_stack": [{"name": "ausboss/qwen-image-2.1-outpaint-v2.safetensors", "strength": 0.8}]})
    assert calls == ["ausboss/qwen-image-2.1-outpaint-v2.safetensors"]


def test_outpaint_uses_gray_canvas_and_trigger_before_the_user_prompt():
    from PIL import Image
    from nodes.unicanvas.models.qwen_image21 import QWEN21_OUTPAINT_INSTRUCTION

    module = _get_unicanvas_model_module("qwen_image21")
    assert module.outpaint_prompt_suffix() == ""
    source = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
    source.putpixel((0, 0), (255, 0, 0, 255))
    padded = module.prepare_outpaint_reference_image(source, None, "t")
    assert padded.mode == "RGB" and padded.getpixel((3, 3)) == (128, 128, 128) and padded.getpixel((0, 0)) == (255, 0, 0)
    text = module.assemble_instruction("a forest at dusk", {1: object()}, outpaint=True)
    assert text == f"{QWEN21_OUTPAINT_INSTRUCTION} a forest at dusk"
    assert module.assemble_instruction("", {1: object()}, outpaint=True) == QWEN21_OUTPAINT_INSTRUCTION
    assert module.assemble_instruction(text, {1: object()}, outpaint=True) == text


def test_pose_uses_the_same_two_images_and_unmodified_pose_studio_prompt(monkeypatch):
    from types import SimpleNamespace
    from nodes.unicanvas.models import qwen_image21

    module = _get_unicanvas_model_module("qwen_image21")
    assert module.capabilities.supports_pose_edit
    settings = {"draw_mode": "img2img", "_qwen21_clip": "CLIP", "_qwen21_prompt": "Draw character from image2\nsoft lighting",
                "_qwen21_negative_prompt": "blurry", "edit_use_layers_as_reference": False}
    ctx = SimpleNamespace(settings=settings, denoise=0.4, mode="img2img", width=64, height=64, draw_id="pose")
    module.prepare_pose_edit(ctx)
    assert ctx.denoise == settings["denoise"] == 1.0
    pose, character = torch.rand(1, 64, 64, 3), torch.rand(1, 64, 64, 3)
    settings["_pose_edit_images"] = [pose, character]
    settings["_external"] = {"references": {"reference_image_1": torch.zeros_like(pose)}}
    calls = []
    native = {"samples": torch.zeros(1, 64, 4, 4)}
    monkeypatch.setattr(qwen_image21, "_call_comfy_node", lambda name, **kwargs: calls.append((name, kwargs)) or ("POS", "NEG", native))
    positive, negative = module.prepare_reference_conditioning(None, None, object(), character, settings, "pose")
    assert (positive, negative) == ("POS", "NEG")
    name, encoded = calls[0]
    assert name == "TextEncodeQwenImage21"
    assert encoded["prompt"] == settings["_qwen21_prompt"]
    assert encoded["negative_prompt"] == "blurry"
    assert list(encoded["images"]) == ["image_1", "image_2"]
    assert torch.equal(encoded["images"]["image_1"], pose)
    assert torch.equal(encoded["images"]["image_2"], character)
    assert encoded["resolution"] == 0
    latent = module.prepare_generation_latent(ctx)
    assert latent is native and "_qwen21_latent" not in settings
    assert not torch.any(latent["samples"])
    assert "_qwen21_pose_edit" in module.sampling_scratch_keys


def test_pose_lora_is_model_only_automatic_and_deduplicated(monkeypatch, tmp_path):
    from types import SimpleNamespace
    import folder_paths
    from nodes.unicanvas.models import qwen_image21

    module = _get_unicanvas_model_module("qwen_image21")
    installed = tmp_path / "custom" / qwen_image21.QWEN21_POSE_LORA_FILENAME
    installed.parent.mkdir(); installed.touch()
    relative = str(installed.relative_to(tmp_path))
    monkeypatch.setattr(folder_paths, "get_full_path", lambda kind, name: str(tmp_path / name) if (tmp_path / name).is_file() else None)
    monkeypatch.setattr(folder_paths, "get_filename_list", lambda kind: [relative])
    resolver_calls, apply_calls = [], []
    monkeypatch.setattr(qwen_image21, "resolve_qwen21_pose_lora", lambda: resolver_calls.append(True) or relative)
    monkeypatch.setattr("nodes.unicanvas.loras._apply_lora_cached", lambda m, c, name, strength, clip_strength=None:
                        apply_calls.append((name, strength, clip_strength)) or (m, c))
    settings = {"qwen_lora_name": "", "draw_mode": "img2img"}
    module.apply_loras("MODEL", "CLIP", settings)
    assert resolver_calls == apply_calls == []
    module.prepare_pose_edit(SimpleNamespace(settings=settings, denoise=0.4))
    settings["lora_stack"] = [{"name": relative, "strength": 1.0}]
    module.apply_loras("MODEL", "CLIP", settings)
    assert resolver_calls == [True]
    assert apply_calls == [(relative, 1.0, 0.0)]


def test_restored_pose_scratch_cannot_enable_lora_in_an_ordinary_draw():
    from nodes.unicanvas.draw_request import DrawRequest

    request = DrawRequest.from_payload({"mode": "img2img", "settings": {
        "generation_mode": "qwen_image21", "_qwen21_pose_edit": True,
        "_pose_edit_images": ["stale pose", "stale character"],
    }})
    assert "_qwen21_pose_edit" not in request.settings
    assert "_pose_edit_images" not in request.settings
