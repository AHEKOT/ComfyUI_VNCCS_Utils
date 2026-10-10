"""Inpaint crop-and-stitch: the crop plan and the stitch back into the working area."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from helpers.unicanvas_package import load_unicanvas_package

load_unicanvas_package("nodes")

from nodes.unicanvas import crop_stitch
from nodes.unicanvas.draw_pipeline import ImageDrawPipeline
from nodes.unicanvas import draw_pipeline
from nodes.unicanvas.models.registry import _get_unicanvas_model_module


def _mask(size, box):
    mask = Image.new("RGBA", size, (0, 0, 0, 0))
    mask.paste((255, 255, 255, 255), box)
    return mask


def test_small_mask_is_cropped_with_context_and_upscaled():
    plan = crop_stitch.plan_crop(_mask((1024, 1024), (300, 300, 500, 600)), (1024, 1024))
    left, top, right, bottom = plan.box
    assert left < 300 and top < 300 and right > 500 and bottom > 600, "context around the mask"
    assert plan.work_size[0] % 64 == 0 and plan.work_size[1] % 64 == 0
    assert plan.work_size[0] > right - left, "the crop is generated at a higher resolution"
    assert abs(plan.work_size[0] * plan.work_size[1] - 1024 * 1024) < 0.35 * 1024 * 1024


def test_large_or_empty_masks_keep_the_full_area():
    assert crop_stitch.plan_crop(_mask((512, 512), (10, 10, 500, 500)), (512, 512)) is None
    assert crop_stitch.plan_crop(Image.new("RGBA", (512, 512)), (512, 512)) is None


def test_stitch_puts_the_crop_back_and_keeps_the_rest():
    base = Image.new("RGBA", (1024, 1024), (0, 0, 255, 255))
    plan = crop_stitch.plan_crop(_mask((1024, 1024), (400, 400, 600, 600)), (1024, 1024))
    generated = Image.new("RGBA", plan.work_size, (255, 0, 0, 255))
    out = crop_stitch.stitch_image(generated, base, plan)
    assert out.size == (1024, 1024)
    assert out.getpixel((500, 500)) == (255, 0, 0, 255)
    assert out.getpixel((5, 5)) == (0, 0, 255, 255)
    mask = crop_stitch.stitch_mask(Image.new("L", plan.work_size, 255), plan)
    assert mask.getpixel((500, 500)) == 255 and mask.getpixel((5, 5)) == 0


def _inpaint_pipeline(family, settings=None):
    settings = {"draw_mode": "inpaint", **(settings or {})}
    mask = _mask((512, 384), (220, 70, 284, 102))
    request = SimpleNamespace(settings=settings, mode="inpaint", denoise=1.0,
                              payload={"mask": mask, "return_tensor": True}, draw_id="bbox",
                              steps=6, task=SimpleNamespace(key="inpaint"))
    pipeline = ImageDrawPipeline(_get_unicanvas_model_module(family), request)
    ctx = pipeline.ctx
    ctx.source_rgba = Image.new("RGBA", mask.size, (0, 0, 255, 255))
    ctx.source = ctx.reference_source = ctx.source_rgba.convert("RGB")
    ctx.width, ctx.height = ctx.output_size = mask.size
    return pipeline, mask


@pytest.mark.parametrize("family", ["illustrious", "qwen_image21", "flux_klein", "minimax_h3"])
def test_inpaint_defaults_to_the_full_bbox(family, monkeypatch):
    pipeline, mask = _inpaint_pipeline(family)
    monkeypatch.setattr(draw_pipeline, "_decode_data_url", lambda image, mode: mask)
    pipeline.crop_to_mask()
    assert pipeline.ctx.crop_plan is None
    assert pipeline.ctx.source.size == (512, 384)


def test_diffusion_crop_and_stitch_remains_an_explicit_option(monkeypatch):
    pipeline, mask = _inpaint_pipeline("illustrious", {crop_stitch.CROP_SETTING: True})
    monkeypatch.setattr(draw_pipeline, "_decode_data_url", lambda image, mode: mask)
    pipeline.crop_to_mask()
    assert pipeline.ctx.crop_plan == crop_stitch.plan_crop(mask, (512, 384))


@pytest.mark.parametrize("use_layers", [True, False])
def test_qwen_inpaint_keeps_bbox_geometry_and_applies_only_the_mask(use_layers, monkeypatch):
    # Old canvases saved crop=True by default; edit models must still use the full bbox.
    pipeline, mask = _inpaint_pipeline("qwen_image21", {
        crop_stitch.CROP_SETTING: True, "edit_use_layers_as_reference": use_layers,
        "_qwen21_clip": "clip", "_qwen21_prompt": "girl in forest",
    })
    ctx, module = pipeline.ctx, pipeline.module
    monkeypatch.setattr(draw_pipeline, "_decode_data_url", lambda image, mode: mask)
    pipeline.crop_to_mask()
    assert ctx.crop_plan is None
    monkeypatch.setattr(draw_pipeline, "_pil_to_image_tensor", lambda image: np.asarray(image)[None])
    pipeline.prepare_inputs()
    seen = {}
    def encode(self, **kwargs):
        seen.update(kwargs)
        return [], []
    monkeypatch.setattr(type(module), "_encode_qi21", encode)
    monkeypatch.setattr(type(module), "_prepare_qi21_condition_image", lambda self, image: image)
    monkeypatch.setattr(type(module), "_qwen21_working_latent", lambda self, vae, image, settings, draw_id: {"samples": image})
    module.prepare_reference_conditioning([], [], object(), ctx.reference_image_tensor, ctx.settings)
    assert module.prepare_generation_latent(ctx)["samples"].shape == (1, 384, 512, 3)
    assert (1 in seen["images"]) is use_layers
    if use_layers:
        assert seen["images"][1].shape == (1, 384, 512, 3)
    ctx.mask_image, ctx.paste_mask_image = mask, mask.getchannel("A")
    generated = Image.new("RGBA", mask.size, (0, 255, 0, 255))
    generated.paste((255, 0, 0, 255), (220, 70, 240, 102))
    ctx.result_images = [generated]
    pipeline.fit_to_output()
    saved = []
    def save(image, prefix):
        saved.append(image)
        return {"filename": prefix}
    monkeypatch.setattr(draw_pipeline, "_save_temp_image", save)
    monkeypatch.setattr(draw_pipeline, "_set_draw_progress", lambda *args: None)
    monkeypatch.setattr(draw_pipeline, "_pil_rgba_to_image_tensor", lambda image: np.asarray(image)[None])
    monkeypatch.setattr(draw_pipeline.torch, "cat", np.concatenate, raising=False)
    result = pipeline.save_result()
    assert (result["inference_width"], result["inference_height"]) == mask.size
    assert saved[0] is generated and saved[1].size == mask.size
    pixels = result["tensor"][0]
    assert tuple(pixels[80, 225]) == (255, 0, 0, 255), "generated pixels keep bbox coordinates"
    assert tuple(pixels[80, 260]) == (0, 255, 0, 255)
    outside = np.asarray(mask.getchannel("A")) == 0
    assert np.array_equal(pixels[outside], np.asarray(ctx.source_rgba)[outside])
