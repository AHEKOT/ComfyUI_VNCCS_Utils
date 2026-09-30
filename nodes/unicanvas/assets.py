"""Model asset listings (checkpoints, diffusion models, GGUF, LoRAs) for the settings UI."""

from __future__ import annotations

from typing import Any

from .comfy_bridge import _get_node_combo_values, _safe_filename_list
from .gguf_compat import gguf_architectures
from .loaders import UNICANVAS_MODEL_LOADERS
from .models.registry import UNICANVAS_MODEL_MODULES


def _get_checkpoint_names() -> list[str]:
    return _safe_filename_list("checkpoints")


def _get_diffusion_model_names() -> list[str]:
    return [name for name in _safe_filename_list("diffusion_models") if not str(name).lower().endswith(".gguf")]


def _get_gguf_model_names() -> list[str]:
    names = _get_node_combo_values(["UnetLoaderGGUF", "UNETLoaderGGUF", "GGUF Loader"], "unet_name")
    if names:
        return names
    for category in ("diffusion_models", "unet"):
        for name in _safe_filename_list(category):
            if str(name).lower().endswith(".gguf") and name not in names:
                names.append(name)
    return names


def _safe_gguf_architectures() -> list[str]:
    try:
        return gguf_architectures()
    except Exception:
        return ["auto"]


def _get_unicanvas_assets() -> dict[str, Any]:
    try:
        import comfy.samplers

        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
    except Exception:
        samplers = []
        schedulers = []
    return {
        "model_modules": [
            module.describe()
            for module in {module.key: module for module in UNICANVAS_MODEL_MODULES.values()}.values()
        ],
        "model_loaders": [
            {
                "key": loader.key,
                "aliases": list(loader.aliases),
                "forced_mode": loader.forced_mode,
            }
            for loader in {loader.key: loader for loader in UNICANVAS_MODEL_LOADERS.values()}.values()
        ],
        "checkpoints": _safe_filename_list("checkpoints"),
        "diffusion_models": _get_diffusion_model_names(),
        "gguf_models": _get_gguf_model_names(),
        "gguf_architectures": _safe_gguf_architectures(),
        "text_encoders": _safe_filename_list("text_encoders"),
        "vae_models": _safe_filename_list("vae"),
        "model_patches": _safe_filename_list("model_patches"),
        "loras": _safe_filename_list("loras"),
        "samplers": samplers,
        "schedulers": schedulers,
    }
