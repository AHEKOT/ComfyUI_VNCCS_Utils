"""Latent and conditioning preparation for txt2img, img2img, inpaint and outpaint draws."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

import torch

from .comfy_bridge import _call_node_method
from .debug import _conditioning_debug, _latent_debug, _uc_log


if TYPE_CHECKING:
    from .models.base import UniCanvasModelModule


def _repeat_latent_batch(latent: Any, batch_size: int, draw_id: str = "unknown") -> Any:
    batch_size = max(1, int(batch_size))
    if batch_size <= 1 or not isinstance(latent, dict):
        return latent
    samples = latent.get("samples")
    if not torch.is_tensor(samples) or samples.ndim < 1:
        return latent
    current = int(samples.shape[0])
    if current == batch_size:
        return latent
    if current != 1:
        _uc_log(draw_id, "latent batch resize skipped", {"current": current, "requested": batch_size})
        return latent
    repeated = dict(latent)
    repeated["samples"] = samples.repeat((batch_size, *([1] * (samples.ndim - 1))))
    noise_mask = repeated.get("noise_mask")
    if torch.is_tensor(noise_mask) and noise_mask.ndim >= 1 and int(noise_mask.shape[0]) == 1:
        repeated["noise_mask"] = noise_mask.repeat((batch_size, *([1] * (noise_mask.ndim - 1))))
    _uc_log(draw_id, "latent batch prepared", {"batch_size": batch_size, "latent": _latent_debug(repeated)})
    return repeated


_CONDITIONING_BATCH_METADATA_KEYS = {
    "concat_latent_image",
    "concat_mask",
    "reference_latents",
}


def _repeat_conditioning_batch_value(value: Any, batch_size: int) -> Any:
    if torch.is_tensor(value) and value.ndim >= 1 and int(value.shape[0]) == 1:
        return value.repeat((batch_size, *([1] * (value.ndim - 1))))
    if isinstance(value, list):
        return [_repeat_conditioning_batch_value(item, batch_size) for item in value]
    if isinstance(value, tuple):
        return tuple(_repeat_conditioning_batch_value(item, batch_size) for item in value)
    return value


def _repeat_conditioning_batch(conditioning: Any, batch_size: int, draw_id: str = "unknown", label: str = "conditioning") -> Any:
    batch_size = max(1, int(batch_size))
    if batch_size <= 1 or not isinstance(conditioning, list):
        return conditioning
    changed = False
    repeated = []
    for item in conditioning:
        if not (isinstance(item, (list, tuple)) and len(item) > 1 and isinstance(item[1], dict)):
            repeated.append(item)
            continue
        metadata = dict(item[1])
        for key in _CONDITIONING_BATCH_METADATA_KEYS:
            if key in metadata:
                metadata[key] = _repeat_conditioning_batch_value(metadata[key], batch_size)
                changed = True
        if isinstance(item, tuple):
            repeated.append((item[0], metadata, *item[2:]))
        else:
            repeated.append([item[0], metadata, *item[2:]])
    if changed:
        _uc_log(draw_id, "conditioning batch metadata prepared", {"label": label, "batch_size": batch_size})
    return repeated


def _prepare_noise_mask_for_latent(
    vae: Any,
    pixels: torch.Tensor,
    mask: torch.Tensor,
    grow_mask_by: int,
) -> tuple[torch.Tensor, torch.Tensor]:
    downscale_ratio = vae.spacial_compression_encode()
    height = (pixels.shape[1] // downscale_ratio) * downscale_ratio
    width = (pixels.shape[2] // downscale_ratio) * downscale_ratio
    mask = torch.nn.functional.interpolate(
        mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])),
        size=(pixels.shape[1], pixels.shape[2]),
        mode="bilinear",
    )
    has_soft_edges = bool(((mask > 0.001) & (mask < 0.999)).any().item())
    if pixels.shape[1] != height or pixels.shape[2] != width:
        y_offset = (pixels.shape[1] % downscale_ratio) // 2
        x_offset = (pixels.shape[2] % downscale_ratio) // 2
        pixels = pixels[:, y_offset:height + y_offset, x_offset:width + x_offset, :]
        mask = mask[:, :, y_offset:height + y_offset, x_offset:width + x_offset]

    if grow_mask_by > 0 and not has_soft_edges:
        kernel = torch.ones((1, 1, grow_mask_by, grow_mask_by))
        padding = math.ceil((grow_mask_by - 1) / 2)
        mask = torch.clamp(torch.nn.functional.conv2d(mask.round(), kernel, padding=padding), 0, 1)
    elif not has_soft_edges:
        mask = mask.round()
    else:
        mask = torch.clamp(mask, 0, 1)
    return pixels, torch.clamp(mask[:, :, :height, :width], 0, 1)


def _encode_source_latent(vae: Any, image_tensor: torch.Tensor, mask: torch.Tensor | None, grow_mask_by: int, draw_id: str = "unknown"):
    import nodes

    if mask is not None:
        encode_pixels, noise_mask = _prepare_noise_mask_for_latent(vae, image_tensor, mask, grow_mask_by)
        encoded = nodes.VAEEncode().encode(vae, encode_pixels)[0]
        encoded["noise_mask"] = noise_mask
        _uc_log(
            draw_id,
            "VAEEncode source + attached noise_mask",
            {
                "reason": "keep original pixels in masked area; Comfy VAEEncodeForInpaint blanks them to 0.5 before encode",
                "latent": _latent_debug(encoded),
            },
        )
        return encoded

    encoded = _call_node_method(["VAEEncode"], ["encode"], vae=vae, pixels=image_tensor, image=image_tensor)
    if isinstance(encoded, tuple) and encoded:
        encoded = encoded[0]
    if encoded is not None:
        _uc_log(draw_id, "VAEEncode returned latent", _latent_debug(encoded))
        return encoded
    encoded = nodes.VAEEncode().encode(vae, image_tensor)[0]
    _uc_log(draw_id, "fallback VAEEncode returned latent", _latent_debug(encoded))
    return encoded


def _prepare_inpaint_model_conditioning(
    positive: Any,
    negative: Any,
    vae: Any,
    image_tensor: torch.Tensor,
    mask: torch.Tensor,
    grow_mask_by: int,
    draw_id: str = "unknown",
) -> tuple[Any, Any, dict[str, Any]]:
    import node_helpers
    import nodes

    try:
        encoded = nodes.InpaintModelConditioning().encode(
            positive=positive,
            negative=negative,
            pixels=image_tensor,
            vae=vae,
            mask=mask,
            noise_mask=True,
        )
        if isinstance(encoded, tuple) and len(encoded) >= 3 and isinstance(encoded[2], dict):
            native_positive, native_negative, native_latent = encoded[:3]
            _uc_log(
                draw_id,
                "InpaintModelConditioning returned",
                {
                    "positive": _conditioning_debug(native_positive),
                    "negative": _conditioning_debug(native_negative),
                    "latent": _latent_debug(native_latent),
                },
            )
            return native_positive, native_negative, native_latent
        _uc_log(draw_id, "InpaintModelConditioning returned unexpected output", {"type": type(encoded).__name__})
    except Exception as exc:
        _uc_log(draw_id, "InpaintModelConditioning failed; using manual fallback", {"error": str(exc)})

    encode_pixels, noise_mask = _prepare_noise_mask_for_latent(vae, image_tensor, mask, grow_mask_by)
    masked_pixels = encode_pixels.clone()
    pixel_mask = noise_mask.round().squeeze(1)
    for channel in range(3):
        masked_pixels[:, :, :, channel] -= 0.5
        masked_pixels[:, :, :, channel] *= 1.0 - pixel_mask
        masked_pixels[:, :, :, channel] += 0.5

    latent = nodes.VAEEncode().encode(vae, encode_pixels)[0]
    latent["noise_mask"] = noise_mask
    concat_latent = nodes.VAEEncode().encode(vae, masked_pixels)[0]["samples"]
    positive = node_helpers.conditioning_set_values(
        positive,
        {"concat_latent_image": concat_latent, "concat_mask": noise_mask},
    )
    negative = node_helpers.conditioning_set_values(
        negative,
        {"concat_latent_image": concat_latent, "concat_mask": noise_mask},
    )
    _uc_log(
        draw_id,
        "manual inpaint conditioning returned",
        {
            "positive": _conditioning_debug(positive),
            "negative": _conditioning_debug(negative),
            "latent": _latent_debug(latent),
        },
    )
    return positive, negative, latent


def _prepare_masked_generation_latent(
    model_module: UniCanvasModelModule,
    mode: str,
    positive: Any,
    negative: Any,
    vae: Any,
    image_tensor: torch.Tensor,
    mask: torch.Tensor,
    grow_mask_by: int,
    draw_id: str = "unknown",
    gen_settings: dict[str, Any] | None = None,
) -> tuple[Any, Any, dict[str, Any]]:
    if mode == "inpaint":
        positive, negative, native_latent = _prepare_inpaint_model_conditioning(
            positive=positive,
            negative=negative,
            vae=vae,
            image_tensor=image_tensor,
            mask=mask,
            grow_mask_by=grow_mask_by,
            draw_id=draw_id,
        )
        source_latent = _encode_source_latent(vae, image_tensor, mask, grow_mask_by, draw_id=draw_id)
        _uc_log(
            draw_id,
            "hybrid inpaint latent returned",
            {
                "reason": "keep native InpaintModelConditioning concat context while using source-preserving encoded latent",
                "native_latent": _latent_debug(native_latent),
                "source_latent": _latent_debug(source_latent),
            },
        )
        return positive, negative, source_latent

    if not model_module.uses_edit_masked_latents(mode):
        return _prepare_inpaint_model_conditioning(
            positive=positive,
            negative=negative,
            vae=vae,
            image_tensor=image_tensor,
            mask=mask,
            grow_mask_by=grow_mask_by,
            draw_id=draw_id,
        )

    latent = _encode_source_latent(vae, image_tensor, mask, grow_mask_by, draw_id=draw_id)
    return positive, negative, latent


def _unwrap_latent_samples(value: Any):
    while isinstance(value, (list, tuple)) and value:
        value = value[0]
    seen_ids = set()
    while isinstance(value, dict) and "samples" in value:
        value_id = id(value)
        if value_id in seen_ids:
            break
        seen_ids.add(value_id)
        value = value["samples"]
        while isinstance(value, (list, tuple)) and value:
            value = value[0]
    return value
