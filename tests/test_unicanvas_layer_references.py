"""Canvas reference selection uses shared slots without changing generation geometry."""
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
import numpy as np

from helpers.unicanvas_package import load_unicanvas_package

UC = load_unicanvas_package("vnccs_layer_references_test")


def test_qwen_preserves_decoded_rgb_and_alpha_and_never_adds_transparency_prompts():
    module = UC.models.registry._get_unicanvas_model_module("qwen_image21")
    for channels in (3, 4):
        pixels = np.full((1, 8, 8, channels), 0.25, dtype=np.float32)
        vae = SimpleNamespace(decode_tiled=lambda *args, **kwargs: pixels)
        for legacy_opaque in (False, True):
            decoded = module.decode_samples(vae, {"samples": object()}, {"qwen21_opaque_output": legacy_opaque})
            assert decoded is pixels
            assert np.all(decoded == 0.25)
    assert module.assemble_instruction("A cat in a garden", {}) == "A cat in a garden"
    assert module.assemble_instruction("A cat on a transparent background", {}) == "A cat on a transparent background"


def test_default_canvas_reference_and_disabled_canvas_slot_order():
    refs = {"reference_image_1": "upload1", "reference_image_2": "upload2"}
    settings = {"_external": {"references": refs}}
    slots = UC.models.base._reference_image_slots
    assert slots("canvas", settings) == {1: "canvas", 2: "upload1", 3: "upload2"}
    settings["edit_use_layers_as_reference"] = False
    assert slots("canvas", settings) == {1: "upload1", 2: "upload2"}
    module = UC.models.qwen_image21.QwenImage21UniCanvasModule()
    instruction = module.assemble_instruction("Edit the photo", slots("canvas", settings), use_layers=False)
    assert "Working area" not in instruction
    assert "Reference images: <image1>, <image2>." in instruction
    assert UC.models.minimax_h3.MiniMaxH3UniCanvasModule()._h3_reference_images(
        {**settings, "_h3_reference_image": "canvas"}) == {"ref_image_1": "upload1", "ref_image_2": "upload2"}


def test_full_bbox_reference_is_kept_when_sampling_a_mask_crop():
    full = Image.new("RGBA", (128, 96), (255, 0, 0, 255))
    crop = Image.new("RGB", (64, 64))
    ctx = SimpleNamespace(mode="inpaint", source_empty=False, source=crop, reference_source=crop,
                          full_source_rgba=full, settings={"edit_use_layers_as_reference": True},
                          pose_images=None, draw_id="test")
    pipeline = SimpleNamespace(ctx=ctx, module=SimpleNamespace(is_edit_model=True, prepare_masked_inputs=lambda ctx: None))
    with patch.object(UC.draw_pipeline, "_pil_to_image_tensor", lambda image: image), \
         patch.object(UC.draw_pipeline, "_tensor_debug", lambda image: {}):
        UC.draw_pipeline.ImageDrawPipeline.prepare_inputs(pipeline)
    assert ctx.image_tensor.size == (64, 64)
    assert UC.models.base._reference_image_slots(ctx.reference_image_tensor, ctx.settings)[1].size == (128, 96)
    assert "_edit_layers_reference" in UC.draw_pipeline.COMMON_SCRATCH_KEYS


def test_flux_reference_pipeline_reads_uploads_and_honors_canvas_toggle():
    module = UC.models.registry._get_unicanvas_model_module("flux_klein")
    seen = []
    def run(_steps, context, _draw_id):
        seen.append(context["image_tensor"])
    with patch.object(UC.models.flux_klein, "_run_pipeline_steps", run), \
         patch.object(UC.models.flux_klein, "_conditioning_debug", lambda value: {}), \
         patch.object(UC.models.flux_klein, "_latent_debug", lambda value: {}):
        settings = {"edit_use_layers_as_reference": False, "_external": {"references": {"reference_image_1": "upload"}}}
        module.prepare_reference_conditioning([], [], None, "canvas", settings)
        assert seen == ["upload"]
        seen.clear()
        module.prepare_reference_conditioning([], [], None, "canvas", {})
        assert seen == ["canvas"]
