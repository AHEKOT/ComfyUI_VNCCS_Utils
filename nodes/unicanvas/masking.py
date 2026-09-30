"""Mask shaping (gradient denoise/paste masks) and outpaint reference preparation."""

from __future__ import annotations

import math

import numpy as np
import torch
from PIL import Image, ImageFilter

from .debug import _tensor_debug, _uc_log
from .imaging import _pil_to_mask_image


def _combine_mask_with_source_alpha(mask_image: Image.Image, source_rgba: Image.Image) -> Image.Image:
    mask = np.asarray(_pil_to_mask_image(mask_image), dtype=np.uint8)
    alpha = np.asarray(source_rgba.convert("RGBA").getchannel("A"), dtype=np.uint8)
    alpha_mask = np.where(alpha > 8, 0, 255).astype(np.uint8)
    combined = np.maximum(mask, alpha_mask)
    return Image.fromarray(combined.astype(np.uint8), mode="L")


def _gaussian_kernel(radius: int) -> torch.Tensor:
    radius = max(0, int(radius))
    if radius <= 0:
        return torch.ones((1, 1), dtype=torch.float32)
    size = radius * 2 + 1
    sigma = max(radius / 2.5, 0.001)
    coords = torch.arange(size, dtype=torch.float32) - radius
    yy, xx = torch.meshgrid(coords, coords, indexing="ij")
    dist = torch.sqrt(xx.square() + yy.square())
    kernel = torch.exp(-0.5 * (dist / sigma).square())
    kernel = torch.where(dist <= radius, kernel, torch.zeros_like(kernel))
    kernel = kernel / torch.clamp(kernel.max(), min=1e-6)
    return kernel


def _max_filter2d_weighted(image: torch.Tensor, kernel: torch.Tensor) -> torch.Tensor:
    height, width = kernel.shape
    pad_y = height // 2
    pad_x = width // 2
    padded = torch.nn.functional.pad(image, (pad_x, pad_x, pad_y, pad_y), mode="constant", value=0)
    result = torch.zeros_like(image)
    for y in range(height):
        for x in range(width):
            weight = kernel[y, x]
            if float(weight.item()) <= 0:
                continue
            region = padded[y : y + image.shape[0], x : x + image.shape[1]]
            result = torch.maximum(result, region * weight)
    return result


def _make_gradient_denoise_mask(mask_image: Image.Image, edge_radius: int, draw_id: str) -> tuple[Image.Image, Image.Image]:
    """Comfy noise mask + expanded paste area: white/1 means denoise."""
    hard = np.where(np.asarray(_pil_to_mask_image(mask_image), dtype=np.uint8) > 8, 255, 0).astype(np.uint8)
    width, height = mask_image.size
    latent_width = max(1, width // 8)
    latent_height = max(1, height // 8)
    latent_radius = max(0, int(edge_radius) // 8)
    latent = Image.fromarray(hard, mode="L").resize((latent_width, latent_height), Image.Resampling.BILINEAR)
    latent_tensor = torch.from_numpy(np.asarray(latent, dtype=np.float32) / 255.0)
    if latent_radius > 0:
        latent_tensor = _max_filter2d_weighted(latent_tensor, _gaussian_kernel(latent_radius))
    denoise = Image.fromarray(np.clip(latent_tensor.numpy() * 255.0, 0, 255).astype(np.uint8), mode="L")
    denoise = denoise.resize((width, height), Image.Resampling.BILINEAR)
    expanded_area = Image.fromarray(np.where(np.asarray(denoise, dtype=np.uint8) > 1, 255, 0).astype(np.uint8), mode="L")
    _uc_log(
        draw_id,
        "gradient denoise mask prepared",
        {
            "edge_radius": edge_radius,
            "latent_edge_radius": latent_radius,
            "mask": _tensor_debug(torch.from_numpy(np.asarray(denoise, dtype=np.float32) / 255.0)[None,]),
            "expanded_area": _tensor_debug(torch.from_numpy(np.asarray(expanded_area, dtype=np.float32) / 255.0)[None,]),
        },
    )
    return denoise, expanded_area


def _make_gradient_paste_mask(mask_image: Image.Image, fade_size_px: int, draw_id: str) -> Image.Image:
    """Paste mask: white chooses generated pixels, black keeps the source."""
    hard = Image.fromarray(
        np.where(np.asarray(_pil_to_mask_image(mask_image), dtype=np.uint8) > 8, 255, 0).astype(np.uint8),
        mode="L",
    )
    fade = max(0, int(fade_size_px))
    if fade <= 0:
        return hard
    blurred = hard.filter(ImageFilter.GaussianBlur(radius=fade))
    hard_np = np.asarray(hard, dtype=np.uint8)
    blur_np = np.asarray(blurred, dtype=np.uint8)
    paste = np.maximum(hard_np, blur_np)
    paste_image = Image.fromarray(paste.astype(np.uint8), mode="L")
    _uc_log(
        draw_id,
        "gradient paste mask prepared",
        {
            "fade_size_px": fade,
            "mask": _tensor_debug(torch.from_numpy(paste.astype(np.float32) / 255.0)[None,]),
        },
    )
    return paste_image


def _sample_transparent_outpaint_rgb(source_rgba: Image.Image, draw_id: str) -> Image.Image:
    rgba = source_rgba.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A"), dtype=np.uint8)
    valid = alpha > 8
    if not bool(valid.any()):
        _uc_log(draw_id, "outpaint sampled-fill fallback", {"reason": "no valid source pixels"})
        return Image.new("RGB", rgba.size, (127, 127, 127))

    rgb = np.asarray(rgba.convert("RGB"), dtype=np.uint8)
    palette = rgb[valid]
    ys, xs = np.nonzero(valid)
    min_x = int(xs.min())
    max_x = int(xs.max())
    min_y = int(ys.min())
    max_y = int(ys.max())
    height, width = alpha.shape

    grid_y, grid_x = np.indices((height, width))
    sample_x = np.clip(grid_x, min_x, max_x)
    sample_y = np.clip(grid_y, min_y, max_y)
    edge_extended = rgb[sample_y, sample_x].astype(np.float32)

    rng = np.random.default_rng(0)
    sampled = np.zeros((height, width, 3), dtype=np.float32)
    noise_layers = ((96, 0.55), (32, 0.3), (8, 0.15))
    for cell, weight in noise_layers:
        noise_width = max(1, int(math.ceil(width / cell)))
        noise_height = max(1, int(math.ceil(height / cell)))
        indices = rng.integers(0, len(palette), size=(noise_height, noise_width))
        noise = Image.fromarray(palette[indices].astype(np.uint8), mode="RGB")
        noise = noise.resize((width, height), Image.Resampling.BILINEAR)
        sampled += np.asarray(noise, dtype=np.float32) * float(weight)

    total_weight = sum(weight for _cell, weight in noise_layers)
    sampled /= max(total_weight, 1e-6)
    fill = sampled * 0.7 + edge_extended * 0.3
    blur_radius = max(2, int(round(max(width, height) / 256)))
    fill_image = Image.fromarray(np.clip(fill, 0, 255).astype(np.uint8), mode="RGB")
    if blur_radius > 0:
        fill_image = fill_image.filter(ImageFilter.GaussianBlur(radius=blur_radius))

    result = fill_image.convert("RGB")
    result.paste(rgba, (0, 0), rgba.getchannel("A"))
    _uc_log(
        draw_id,
        "outpaint source filled with sampled source-color static",
        {
            "source_size": rgba.size,
            "valid_bbox": [min_x, min_y, max_x - min_x + 1, max_y - min_y + 1],
            "palette_pixels": int(len(palette)),
            "blur_radius": blur_radius,
            "noise_layers": [{"cell": cell, "weight": weight} for cell, weight in noise_layers],
            "alpha": _tensor_debug(torch.from_numpy(alpha.astype(np.float32) / 255.0)[None,]),
        },
    )
    return result


def _make_edit_outpaint_reference_rgb(source_rgba: Image.Image, draw_id: str) -> Image.Image:
    rgba = source_rgba.convert("RGBA")
    background = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
    background.alpha_composite(rgba)
    result = background.convert("RGB")
    _uc_log(
        draw_id,
        "edit-model outpaint reference flattened on black",
        {"source_size": rgba.size},
    )
    return result
