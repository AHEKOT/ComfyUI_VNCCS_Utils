"""Layer background removal: a registry of backends (edit model, BiRefNet, rembg ONNX, SAM 3).

Backs ``POST /vnccs/unicanvas/remove_bg``
``{ method: "edit" | "birefnet" | "rembg" | "sam3", edit_model?, image }``.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

from .imaging import _decode_data_url, _encode_png_data_url, _uc_image_to_rgb_tensor, _uc_rgba_tensor_to_image
from .models.registry import UNICANVAS_MODEL_MODULES, _get_unicanvas_model_module
from .rembg_onnx import remove_background_rembg
from .sampling import _ensure_direct_sampling_prompt_context
from .segment import _run_unicanvas_segment


UC_QI21_REMOVE_BG_UNAVAILABLE = (
    "[VNCCS UniCanvas] Remove bg – QI2.1 requires the Qwen-Image-2.1 module (QI2.1 family)."
)


def _uc_load_birefnet_masker():
    # Inside a ComfyUI process this extension loads vnccs_sam3d as a sibling
    # subpackage, so the relative form resolves; the absolute fallback covers
    # flat imports (tests/conftest.py stubs "nodes" as a top-level package,
    # where the relative form cannot resolve).
    try:
        from ...vnccs_sam3d.processing.birefnet_mask import auto_mask_bgr
    except ImportError:
        from vnccs_sam3d.processing.birefnet_mask import auto_mask_bgr

    return auto_mask_bgr


# Edit families offered even when their module is unavailable (the request then fails with
# the family's "unavailable" message instead of "unknown model"). Any other registered family
# that implements remove_background() joins the list automatically. Only families with an
# RGBA VAE qualify: MiniMax H3 decodes RGB only (video model), so it is not one of them.
UC_REMOVE_BG_EDIT_MODELS = ("qwen_image21",)
UC_EDIT_REMOVE_BG_UNAVAILABLE = (
    "[VNCCS UniCanvas] Remove bg – Edit model requires an RGBA-VAE edit model module ({model})."
)
UC_SAM3_REMOVE_BG_UNAVAILABLE = (
    "[VNCCS UniCanvas] Remove bg – SAM 3 needs the SAM stack: {error}"
)


def _uc_resolve_edit_remove_bg_module(edit_model: str):
    try:
        module = _get_unicanvas_model_module(edit_model)
    except Exception:
        module = None
    if module is None or not callable(getattr(module, "remove_background", None)):
        if edit_model == "qwen_image21":
            raise RuntimeError(UC_QI21_REMOVE_BG_UNAVAILABLE)
        raise RuntimeError(UC_EDIT_REMOVE_BG_UNAVAILABLE.format(model=edit_model))
    return module


def _uc_remove_bg_rembg(image: Image.Image) -> Image.Image:
    # rembg's u2net over onnxruntime; the model downloads itself on first use (rembg_onnx).
    return remove_background_rembg(image)


def _uc_remove_bg_sam3(image: Image.Image) -> Image.Image:
    """SAM-stack automatic subject mask (the extension's SAM 3 pipeline).

    Reuses the interactive segmentation logic with automatic prompts: one
    centre-positive point plus corner-negative points, then the largest
    predicted mask becomes the kept subject.
    """
    width, height = image.size
    points = [
        {"x": width * 0.5, "y": height * 0.5, "label": 1},
        {"x": 1, "y": 1, "label": 0},
        {"x": width - 2, "y": 1, "label": 0},
        {"x": 1, "y": height - 2, "label": 0},
        {"x": width - 2, "y": height - 2, "label": 0},
    ]
    try:
        result = _run_unicanvas_segment({
            "model": "sam3",
            "image": _encode_png_data_url(image.convert("RGB")),
            "points": points,
        })
    except Exception as exc:
        raise RuntimeError(UC_SAM3_REMOVE_BG_UNAVAILABLE.format(error=exc)) from exc
    return _decode_data_url(str(result.get("mask") or ""), "RGBA")


@dataclass(frozen=True)
class RemoveBgRequest:
    method: str
    raw_method: str
    edit_model: str
    payload: dict[str, Any]
    edit_settings: dict[str, Any] | None = None


class BackgroundRemover:
    """One background-removal backend. Subclass, then :func:`register_background_remover`."""

    key: str = ""
    aliases: tuple[str, ...] = ()
    uses_edit_model = False

    def prepare(self, request: RemoveBgRequest) -> None:
        """Fail fast, before any pixel work, when the backend is unavailable."""

    def remove(self, image: Image.Image, request: RemoveBgRequest) -> Image.Image:
        """Return ``image`` as RGBA with the background made transparent."""
        raise NotImplementedError


class EditModelRemover(BackgroundRemover):
    """RGBA-VAE edit families (``remove_background`` on the model module)."""

    key = "edit"
    aliases = ("qi21",)
    uses_edit_model = True

    def prepare(self, request: RemoveBgRequest) -> None:
        if request.edit_model not in _uc_remove_bg_edit_models():
            raise ValueError(f"[VNCCS UniCanvas] Unknown remove bg edit model '{request.edit_model}'.")
        _uc_resolve_edit_remove_bg_module(request.edit_model)

    def remove(self, image: Image.Image, request: RemoveBgRequest) -> Image.Image:
        module = _uc_resolve_edit_remove_bg_module(request.edit_model)
        _ensure_direct_sampling_prompt_context()  # graph-less sampling needs a prompt context
        # The layer's own size, scaled into the edit model's working range (at most 2 MP),
        # and the result scaled back to the layer size.
        work = image.resize(edit_working_size(image.size), Image.Resampling.LANCZOS)
        result = _uc_rgba_tensor_to_image(module.remove_background(_uc_image_to_rgb_tensor(work), request.edit_settings))
        return result if result.size == image.size else result.resize(image.size, Image.Resampling.LANCZOS)


class BiRefNetRemover(BackgroundRemover):
    key = "birefnet"

    def remove(self, image: Image.Image, request: RemoveBgRequest) -> Image.Image:
        masker = _uc_load_birefnet_masker()
        img_bgr = np.asarray(image, dtype=np.uint8)[:, :, ::-1].copy()
        mask, _bounds = masker(img_bgr)
        alpha = (np.asarray(mask) > 0).astype(np.uint8) * 255
        result = Image.new("RGBA", image.size, (255, 255, 255, 0))
        result.putalpha(Image.fromarray(alpha, mode="L"))
        return result


class RembgRemover(BackgroundRemover):
    key = "rembg"

    def remove(self, image: Image.Image, request: RemoveBgRequest) -> Image.Image:
        return _uc_remove_bg_rembg(image)


class Sam3Remover(BackgroundRemover):
    key = "sam3"

    def remove(self, image: Image.Image, request: RemoveBgRequest) -> Image.Image:
        return _uc_remove_bg_sam3(image)


BACKGROUND_REMOVERS: dict[str, BackgroundRemover] = {}
_BACKGROUND_REMOVER_ALIASES: dict[str, str] = {}


def register_background_remover(remover: BackgroundRemover) -> None:
    BACKGROUND_REMOVERS[remover.key] = remover
    for alias in remover.aliases:
        _BACKGROUND_REMOVER_ALIASES[alias] = remover.key


for _remover in (EditModelRemover(), BiRefNetRemover(), RembgRemover(), Sam3Remover()):
    register_background_remover(_remover)


def _resolve_background_remover(raw_method: str) -> BackgroundRemover:
    method = _BACKGROUND_REMOVER_ALIASES.get(raw_method, raw_method)
    remover = BACKGROUND_REMOVERS.get(method)
    if remover is None:
        raise ValueError(f"[VNCCS UniCanvas] Unknown remove bg method '{raw_method}'.")
    return remover


def _uc_remove_bg_edit_models() -> tuple[str, ...]:
    keys = list(UC_REMOVE_BG_EDIT_MODELS)
    for name, module in UNICANVAS_MODEL_MODULES.items():
        key = getattr(module, "key", name)
        if key not in keys and callable(getattr(module, "remove_background", None)):
            keys.append(key)
    return tuple(keys)


# What the settings popover may override for an edit-model run; everything else stays the
# family's default. The seed is not user-facing: every run draws a fresh one. An optional
# single (turbo) LoRA becomes the run's LoRA stack.
_EDIT_SETTING_TEXT_KEYS = (
    "model_loader", "diffusion_model_name", "gguf_model_name", "gguf_arch",
    "clip_name", "vae_name", "scheduler", "sampler_name",
)
# Longest side and area limits for the image an edit model sees (the result is scaled back).
EDIT_MAX_PIXELS = 2_000_000
EDIT_MIN_PIXELS = 1_000_000
EDIT_SIZE_MULTIPLE = 32


def edit_working_size(size: tuple[int, int]) -> tuple[int, int]:
    """Size the edit model works at: the layer's aspect, 1-2 MP, sides in multiples of 32."""
    width, height = max(1, int(size[0])), max(1, int(size[1]))
    area = width * height
    scale = 1.0
    if area > EDIT_MAX_PIXELS:
        scale = (EDIT_MAX_PIXELS / area) ** 0.5
    elif area < EDIT_MIN_PIXELS:
        scale = (EDIT_MIN_PIXELS / area) ** 0.5
    step = EDIT_SIZE_MULTIPLE
    out_w = max(step, int(width * scale) // step * step)
    out_h = max(step, int(height * scale) // step * step)
    return out_w, out_h


def _uc_edit_remove_bg_settings(raw: Any) -> dict[str, Any]:
    settings: dict[str, Any] = {}
    source = raw if isinstance(raw, dict) else {}
    for key in _EDIT_SETTING_TEXT_KEYS:
        value = str(source.get(key) or "").strip()
        if value:
            settings[key] = value
    try:
        steps = int(source.get("steps"))
        if 1 <= steps <= 200:
            settings["steps"] = steps
    except (TypeError, ValueError):
        pass
    try:
        cfg = float(source.get("cfg"))
        if 0.0 <= cfg <= 30.0:
            settings["cfg"] = cfg
    except (TypeError, ValueError):
        pass
    lora_name = str(source.get("lora_name") or "").strip()
    if "lora_name" in source:
        settings["lora_stack"] = []  # an explicit pick, "None" included, replaces the family default
    prompt = str(source.get("prompt") or "").strip()
    if prompt:
        settings["prompt"] = prompt[:2000]
    if lora_name and lora_name.lower() != "none":
        try:
            strength = float(source.get("lora_strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        if -10.0 <= strength <= 10.0 and strength != 0.0:
            settings["lora_stack"] = [{"name": lora_name, "strength": strength}]
    settings["seed"] = secrets.randbelow(2**32)
    return settings


def _run_unicanvas_remove_bg(payload: dict[str, Any]) -> dict[str, Any]:
    payload = payload or {}
    raw_method = str(payload.get("method") or "").strip().lower()
    remover = _resolve_background_remover(raw_method)
    request = RemoveBgRequest(
        method=remover.key,
        raw_method=raw_method,
        edit_model=str(payload.get("edit_model") or "qwen_image21").strip().lower(),
        payload=payload,
        edit_settings=_uc_edit_remove_bg_settings(payload.get("edit_settings")) if remover.uses_edit_model else None,
    )
    remover.prepare(request)
    image = _decode_data_url(str(payload.get("image") or ""), "RGB")
    result = remover.remove(image, request)
    return {
        "alpha": _encode_png_data_url(result),
        "width": result.width,
        "height": result.height,
        "method": remover.key,
        "edit_model": request.edit_model if remover.uses_edit_model else None,
    }

