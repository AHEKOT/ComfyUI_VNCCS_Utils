"""Layer color matching against a reference image.

Backs ``POST /vnccs/unicanvas/color_match`` ``{ image, reference, method, strength }``.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import torch
from PIL import Image

from .imaging import _decode_data_url, _encode_png_data_url, _uc_image_to_rgb_tensor


def _reinhard_lab_transfer_np(src: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """Pure Reinhard (LAB mean/std) transfer - fallback when color-matcher is unavailable.

    Delegates to the torch implementation so the LAB transfer math has a single
    source of truth; the array signature stays for the numpy callers.
    """
    matched = _reinhard_lab_gpu_transfer(
        torch.from_numpy(np.asarray(src, dtype=np.float32)),
        torch.from_numpy(np.asarray(ref, dtype=np.float32)),
    )
    return matched.detach().cpu().numpy()


def _torch_srgb_to_lab(rgb: torch.Tensor) -> torch.Tensor:
    array = rgb.clamp(0.0, 1.0).to(dtype=torch.float32)
    linear = torch.where(array <= 0.04045, array / 12.92, ((array + 0.055) / 1.055) ** 2.4)
    matrix = array.new_tensor(
        [
            [0.4124564, 0.3575761, 0.1804375],
            [0.2126729, 0.7151522, 0.0721750],
            [0.0193339, 0.1191920, 0.9503041],
        ]
    )
    xyz = linear @ matrix.T
    xyz = xyz / xyz.new_tensor([0.95047, 1.0, 1.08883])
    f = torch.where(xyz > 0.008856, torch.clamp(xyz, min=0.0) ** (1.0 / 3.0), 7.787 * xyz + 16.0 / 116.0)
    fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]
    return torch.stack([116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)], dim=-1)


def _torch_lab_to_srgb(lab: torch.Tensor) -> torch.Tensor:
    fy = (lab[..., 0] + 16.0) / 116.0
    fx = fy + lab[..., 1] / 500.0
    fz = fy - lab[..., 2] / 200.0
    f = torch.stack([fx, fy, fz], dim=-1)
    cube = f ** 3
    xyz = torch.where(cube > 0.008856, cube, (f - 16.0 / 116.0) / 7.787) * lab.new_tensor([0.95047, 1.0, 1.08883])
    matrix = lab.new_tensor(
        [
            [3.2404542, -1.5371385, -0.4985314],
            [-0.9692660, 1.8760108, 0.0415560],
            [0.0556434, -0.2040259, 1.0572252],
        ]
    )
    linear = xyz @ matrix.T
    return torch.where(linear <= 0.0031308, 12.92 * linear, 1.055 * torch.clamp(linear, min=0.0) ** (1.0 / 2.4) - 0.055).clamp(0.0, 1.0)


def _reinhard_lab_gpu_transfer(src: torch.Tensor, ref: torch.Tensor) -> torch.Tensor:
    """Torch Reinhard (LAB mean/std) transfer; follows the tensors' device."""
    src_lab = _torch_srgb_to_lab(src)
    ref_lab = _torch_srgb_to_lab(ref)
    out = torch.empty_like(src_lab)
    for channel in range(3):
        source = src_lab[..., channel]
        reference = ref_lab[..., channel]
        out[..., channel] = (source - source.mean()) / (source.std(unbiased=False) + 1e-6) * (reference.std(unbiased=False) + 1e-6) + reference.mean()
    return _torch_lab_to_srgb(out)


def _load_color_matcher_class():
    """Return the color-matcher ColorMatcher class, or None when the package is unavailable."""
    try:
        from color_matcher import ColorMatcher
    except Exception:
        return None
    return ColorMatcher


def _uc_tensor_to_u8(tensor: torch.Tensor) -> np.ndarray:
    array = tensor.detach().to(device="cpu", dtype=torch.float32).clamp(0.0, 1.0).numpy()
    return (array * 255.0).round().astype(np.uint8)


class ColorTransfer:
    """One color-match method. Subclass, then :func:`register_color_transfer`."""

    key: str = ""
    uses_mask = False  # True: transfer() also takes the layer's opacity mask (H,W) 0..1

    def transfer(self, src: torch.Tensor, ref: torch.Tensor) -> tuple[torch.Tensor, str]:
        """Return (src recolored to ref's statistics as (H,W,3) float 0..1, engine name)."""
        raise NotImplementedError


def _local_mean(values: torch.Tensor, weight: torch.Tensor, sigma: float) -> torch.Tensor:
    """Weighted Gaussian-window mean of (H,W,C) ``values`` (weights (H,W)), computed on a
    reduced grid and upsampled, so a 4K layer costs about as much as a thumbnail."""
    import torch.nn.functional as F

    height, width = values.shape[:2]
    factor = max(1, int(max(height, width) // 96))
    stack = torch.cat([values * weight[..., None], weight[..., None]], dim=-1).permute(2, 0, 1)[None]
    small = F.avg_pool2d(stack, factor, ceil_mode=True) if factor > 1 else stack
    radius_sigma = max(0.5, sigma / factor)
    radius = max(1, int(radius_sigma * 3))
    offsets = torch.arange(-radius, radius + 1, device=values.device, dtype=values.dtype)
    kernel = torch.exp(-(offsets ** 2) / (2 * radius_sigma ** 2))
    kernel = kernel / kernel.sum()
    channels = small.shape[1]
    small = F.pad(small, (radius, radius, radius, radius), mode="replicate")
    small = F.conv2d(small, kernel.view(1, 1, 1, -1).repeat(channels, 1, 1, 1), groups=channels)
    small = F.conv2d(small, kernel.view(1, 1, -1, 1).repeat(channels, 1, 1, 1), groups=channels)
    full = F.interpolate(small, size=(height, width), mode="bilinear", align_corners=False)[0].permute(1, 2, 0)
    return full[..., :-1] / full[..., -1:].clamp(min=1e-4)


def _local_lab_transfer(src: torch.Tensor, ref: torch.Tensor, mask: torch.Tensor | None = None) -> torch.Tensor:
    """Per-pixel LAB transfer: every pixel takes the local mean/contrast of the reference
    around it (a Gaussian window about 1/8 of the layer), so the layer blends into the
    colors actually below each part of it instead of one global average."""
    src_lab = _torch_srgb_to_lab(src)
    ref_lab = _torch_srgb_to_lab(ref)
    height, width = src.shape[:2]
    weight = mask.to(src_lab) if mask is not None else torch.ones(height, width, dtype=src_lab.dtype, device=src_lab.device)
    ones = torch.ones_like(weight)
    sigma = max(height, width) / 8.0
    src_mean = _local_mean(src_lab, weight, sigma)
    src_std = (_local_mean(src_lab ** 2, weight, sigma) - src_mean ** 2).clamp(min=0).sqrt()
    ref_mean = _local_mean(ref_lab, ones, sigma)
    ref_std = (_local_mean(ref_lab ** 2, ones, sigma) - ref_mean ** 2).clamp(min=0).sqrt()
    # Keep the layer's own detail: contrast follows the reference only within 0.5x-1.5x.
    ratio = ((ref_std + 1.0) / (src_std + 1.0)).clamp(0.5, 1.5)
    return _torch_lab_to_srgb((src_lab - src_mean) * ratio + ref_mean)


class LocalLabTransfer(ColorTransfer):
    key = "local_lab"
    uses_mask = True

    def transfer(self, src: torch.Tensor, ref: torch.Tensor, mask: torch.Tensor | None = None) -> tuple[torch.Tensor, str]:
        return _local_lab_transfer(src, ref, mask), "local_lab"


class ReinhardLabGpuTransfer(ColorTransfer):
    key = "reinhard_lab_gpu"

    def transfer(self, src: torch.Tensor, ref: torch.Tensor) -> tuple[torch.Tensor, str]:
        return _reinhard_lab_gpu_transfer(src, ref), "reinhard_lab_gpu"


class ColorMatcherTransfer(ColorTransfer):
    """A method of the color-matcher package, with the NumPy Reinhard LAB fallback."""

    def __init__(self, key: str):
        self.key = key

    def transfer(self, src: torch.Tensor, ref: torch.Tensor) -> tuple[torch.Tensor, str]:
        matcher_cls = _load_color_matcher_class()
        if matcher_cls is not None:
            try:
                matched = matcher_cls().transfer(src=_uc_tensor_to_u8(src), ref=_uc_tensor_to_u8(ref), method=self.key)
                return torch.from_numpy(np.asarray(matched, dtype=np.float32) / 255.0), "color-matcher"
            except Exception:
                pass
        fallback = _reinhard_lab_transfer_np(src.detach().cpu().numpy(), ref.detach().cpu().numpy())
        return torch.from_numpy(fallback), "reinhard-fallback"


COLOR_TRANSFERS: dict[str, ColorTransfer] = {}


def register_color_transfer(transfer: ColorTransfer) -> None:
    COLOR_TRANSFERS[transfer.key] = transfer


for _transfer in (
    LocalLabTransfer(),
    *(ColorMatcherTransfer(key) for key in ("mkl", "hm", "reinhard", "mvgd", "hm-mvgd-hm", "hm-mkl-hm")),
    ReinhardLabGpuTransfer(),
):
    register_color_transfer(_transfer)

# Built-in methods in the order the widget lists them.
UC_COLOR_MATCH_METHODS = tuple(COLOR_TRANSFERS)


def _color_match_transfer(src: torch.Tensor, ref: torch.Tensor, method: str, mask: torch.Tensor | None = None) -> tuple[torch.Tensor, str]:
    """Transfer ref's color statistics onto src; returns (matched RGB, engine name)."""
    method = str(method or "local_lab").strip().lower()
    transfer = COLOR_TRANSFERS.get(method)
    if transfer is None:
        raise ValueError(f"[VNCCS UniCanvas] Unknown color match method '{method}'.")
    if getattr(transfer, "uses_mask", False):
        return transfer.transfer(src, ref, mask)
    return transfer.transfer(src, ref)


def _uc_clamp_strength(strength: Any) -> float:
    try:
        value = float(strength)
    except (TypeError, ValueError):
        value = 10.0
    return max(0.0, min(10.0, value))


def _apply_color_match_strength(src: torch.Tensor, matched: torch.Tensor, strength: Any) -> torch.Tensor:
    """strength 0..10: 0 keeps the target, 10 applies the full transfer."""
    alpha = _uc_clamp_strength(strength) / 10.0
    return (src + (matched - src) * alpha).clamp(0.0, 1.0)


def _run_unicanvas_color_match(payload: dict[str, Any]) -> dict[str, Any]:
    payload = payload or {}
    image = _decode_data_url(str(payload.get("image") or ""), "RGBA")
    reference = _decode_data_url(str(payload.get("reference") or ""), "RGB")
    method = str(payload.get("method") or "local_lab").strip().lower()
    src = _uc_image_to_rgb_tensor(image)
    ref = _uc_image_to_rgb_tensor(reference)
    if ref.shape != src.shape:
        ref = _uc_image_to_rgb_tensor(reference.resize(image.size, Image.Resampling.BILINEAR))
    mask = torch.from_numpy(np.asarray(image)[:, :, 3].astype(np.float32) / 255.0)
    matched, engine = _color_match_transfer(src, ref, method, mask)
    result = _apply_color_match_strength(src, matched, payload.get("strength", 10.0))
    rgb = (result.detach().to(device="cpu", dtype=torch.float32).clamp(0.0, 1.0).numpy() * 255.0).round().astype(np.uint8)
    alpha = np.asarray(image.convert("RGBA"))[:, :, 3]
    rgba = np.concatenate([rgb, alpha[:, :, None]], axis=-1)
    return {
        "image": _encode_png_data_url(Image.fromarray(rgba, mode="RGBA")),
        "method": method,
        "engine": engine,
        "strength": _uc_clamp_strength(payload.get("strength", 10.0)),
    }
