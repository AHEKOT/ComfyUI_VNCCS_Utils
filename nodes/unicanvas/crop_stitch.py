"""Inpaint crop-and-stitch (the ComfyUI-Inpaint-CropAndStitch idea, own implementation).

An inpaint draw no longer regenerates the whole generation bbox and cuts the mask out of it:
the area around the mask (plus context) is cropped, scaled up to the draw's working resolution,
generated, scaled back and pasted into the mask only. The bbox gives the context budget; the
model spends all of its pixels on the masked region, so a subject fills the mask at full detail.

Pure PIL/numpy helpers; the draw pipeline calls them (setting ``inpaint_crop_to_mask``, on by
default).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

CROP_SETTING = "inpaint_crop_to_mask"
# Context around the mask, as a fraction of the mask's larger side (CropAndStitch "context_expand").
CONTEXT_FACTOR = 0.35
MIN_CONTEXT_PX = 48
# Not worth cropping when the mask already covers most of the working area.
MAX_COVERAGE = 0.7
MAX_UPSCALE = 4.0
SIZE_MULTIPLE = 64


@dataclass(frozen=True)
class CropPlan:
    box: tuple[int, int, int, int]  # left, top, right, bottom in the working-area pixels
    work_size: tuple[int, int]  # size the crop is generated at
    full_size: tuple[int, int]


def _round_to(value: float, multiple: int) -> int:
    return max(multiple, int(round(value / multiple)) * multiple)


def plan_crop(mask: Image.Image, full_size: tuple[int, int], threshold: int = 8) -> CropPlan | None:
    """The crop around the mask and the size to generate it at, or None to keep the full area."""
    alpha = np.asarray(mask.convert("RGBA").getchannel("A"), dtype=np.uint8)
    ys, xs = np.nonzero(alpha > threshold)
    if not len(xs):
        return None
    width, height = full_size
    left, right = int(xs.min()), int(xs.max()) + 1
    top, bottom = int(ys.min()), int(ys.max()) + 1
    context = max(MIN_CONTEXT_PX, int(CONTEXT_FACTOR * max(right - left, bottom - top)))
    left, top = max(0, left - context), max(0, top - context)
    right, bottom = min(width, right + context), min(height, bottom + context)
    crop_w, crop_h = right - left, bottom - top
    if crop_w * crop_h >= MAX_COVERAGE * width * height:
        return None
    # Same pixel budget as the full working area, never more than MAX_UPSCALE per side.
    scale = min(MAX_UPSCALE, ((width * height) / float(crop_w * crop_h)) ** 0.5)
    work = (_round_to(crop_w * scale, SIZE_MULTIPLE), _round_to(crop_h * scale, SIZE_MULTIPLE))
    return CropPlan(box=(left, top, right, bottom), work_size=work, full_size=(width, height))


def crop_image(image: Image.Image, plan: CropPlan, resample=Image.Resampling.LANCZOS) -> Image.Image:
    return image.crop(plan.box).resize(plan.work_size, resample)


def stitch_image(result: Image.Image, base: Image.Image, plan: CropPlan) -> Image.Image:
    """``result`` (the generated crop) scaled back into a copy of ``base`` at the crop box."""
    left, top, right, bottom = plan.box
    piece = result.resize((right - left, bottom - top), Image.Resampling.LANCZOS)
    out = base.convert(piece.mode).copy() if base.size == plan.full_size else Image.new(piece.mode, plan.full_size)
    out.paste(piece, (left, top))
    return out


def stitch_mask(mask: Image.Image, plan: CropPlan) -> Image.Image:
    """A crop-sized paste mask placed on an empty full-size mask (nothing outside the crop)."""
    left, top, right, bottom = plan.box
    out = Image.new("L", plan.full_size, 0)
    out.paste(mask.convert("L").resize((right - left, bottom - top), Image.Resampling.BILINEAR), (left, top))
    return out
