"""Registry that maps generation-mode keys and aliases to model family adapters."""

from __future__ import annotations

from .base import UniCanvasModelModule


UNICANVAS_MODEL_MODULES: dict[str, UniCanvasModelModule] = {}
# Family used when a draw names none (the historical widget default).
DEFAULT_GENERATION_MODE = "illustrious"


def _register_unicanvas_model_module(module: UniCanvasModelModule) -> None:
    UNICANVAS_MODEL_MODULES[module.key] = module
    for alias in module.aliases:
        UNICANVAS_MODEL_MODULES[alias] = module


def _get_unicanvas_model_module(generation_mode: str | None) -> UniCanvasModelModule:
    key = str(generation_mode or DEFAULT_GENERATION_MODE).lower()
    module = UNICANVAS_MODEL_MODULES.get(key)
    if module is None:
        supported = sorted({module.key for module in UNICANVAS_MODEL_MODULES.values()})
        raise ValueError(f"Unsupported UniCanvas model mode '{key}'. Supported modes: {', '.join(supported)}")
    return module
