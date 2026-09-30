"""Inpaint crop-and-stitch: the crop plan and the stitch back into the working area."""

from __future__ import annotations

from PIL import Image

from nodes.unicanvas import crop_stitch


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
