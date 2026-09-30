"""PIL / data URL / ComfyUI tensor conversions shared by the UniCanvas backend."""

from __future__ import annotations

import base64
import io

import numpy as np
import torch
from PIL import Image

from .constants import _MAX_PIXELS, _MAX_UPLOAD_BYTES


def _decode_data_url(data_url: str, mode: str, max_pixels: int = _MAX_PIXELS) -> Image.Image:
    if not isinstance(data_url, str) or not data_url:
        raise ValueError("Missing image data")
    payload = data_url.split(",", 1)[1] if "," in data_url else data_url
    raw = base64.b64decode(payload, validate=False)
    if len(raw) > _MAX_UPLOAD_BYTES:
        raise ValueError("Image upload is too large")
    image = Image.open(io.BytesIO(raw))
    if image.width * image.height > max_pixels:
        raise ValueError("Image dimensions are too large")
    return image.convert(mode)


def _encode_png_data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _pil_rgba_to_image_tensor(image: Image.Image) -> torch.Tensor:
    arr = np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _pil_to_image_tensor(image: Image.Image) -> torch.Tensor:
    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _pil_to_mask_tensor(image: Image.Image) -> torch.Tensor:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0
    alpha = rgba[..., 3]
    luminance = rgba[..., :3].mean(axis=2)
    mask = alpha if np.any(alpha < 0.999) else luminance
    return torch.from_numpy(mask)[None,]


def _pil_to_mask_image(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32)
    alpha = rgba[..., 3]
    luminance = rgba[..., :3].mean(axis=2)
    mask = alpha if np.any(alpha < 254.5) else luminance
    return Image.fromarray(np.clip(mask, 0, 255).astype(np.uint8), mode="L")


def _image_tensor_to_pil(images: torch.Tensor) -> Image.Image:
    image = images.detach().cpu().numpy()
    while image.ndim > 3 and image.shape[0] == 1:
        image = image[0]
    if image.ndim == 4:
        image = image[0]
    if image.ndim == 3 and image.shape[0] in (1, 3, 4) and image.shape[-1] not in (1, 3, 4):
        image = np.moveaxis(image, 0, -1)
    if image.ndim == 2:
        image = np.repeat(image[..., None], 3, axis=-1)
    if image.ndim != 3 or image.shape[-1] not in (1, 3, 4):
        raise ValueError(f"Unsupported image tensor shape for PIL conversion: {tuple(images.shape)}")
    if image.shape[-1] == 1:
        image = np.repeat(image, 3, axis=-1)
    image = np.clip(image * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(image)


def _image_tensor_to_pil_list(images: torch.Tensor) -> list[Image.Image]:
    if torch.is_tensor(images) and images.ndim == 4:
        return [_image_tensor_to_pil(images[index]) for index in range(int(images.shape[0]))]
    return [_image_tensor_to_pil(images)]


def _uc_image_to_rgb_tensor(image: Image.Image) -> torch.Tensor:
    """(H,W,3) float32 tensor in 0..1 - the shared layer-utility image contract."""
    array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(array.copy())


def _uc_rgba_tensor_to_image(tensor: torch.Tensor) -> Image.Image:
    array = tensor.detach().to(device="cpu", dtype=torch.float32).clamp(0.0, 1.0).numpy()
    if array.ndim != 3 or array.shape[-1] not in (3, 4):
        raise ValueError(f"[VNCCS UniCanvas] Unsupported result tensor shape {tuple(array.shape)}.")
    data = (array * 255.0).round().astype(np.uint8)
    return Image.fromarray(data, mode="RGBA" if array.shape[-1] == 4 else "RGB")
