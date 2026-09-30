"""Generation settings normalisation: presets, loader choice and model-family defaults."""

from __future__ import annotations

from typing import Any

from .loaders import _get_unicanvas_model_loader
from .models.registry import DEFAULT_GENERATION_MODE, _get_unicanvas_model_module
from .presets import _PRESET_MODEL_SETTING_KEYS, _unicanvas_load_preset_registry


def _infer_unicanvas_loader_type(settings: dict[str, Any]) -> str:
    explicit = str(settings.get("model_loader") or settings.get("loader_type") or "").lower()
    if explicit:
        return explicit
    if settings.get("gguf_model_name"):
        return "gguf"
    try:
        module = _get_unicanvas_model_module(settings.get("generation_mode"))
    except ValueError:
        module = None
    if module is not None and module.capabilities.default_loader:
        return module.capabilities.default_loader
    if settings.get("diffusion_model_name"):
        return "diffusion_model"
    return "checkpoint"


def _get_selected_preset_model_settings(settings: dict[str, Any]) -> dict[str, Any]:
    if str(settings.get("model_selection_mode") or "").lower() != "presets":
        return {}
    preset_id = str(settings.get("selected_preset_id") or "")
    if not preset_id:
        return {}
    registry = _unicanvas_load_preset_registry()
    for preset in registry.get("presets", []):
        if not isinstance(preset, dict) or str(preset.get("id") or "") != preset_id:
            continue
        preset_settings = preset.get("settings")
        if not isinstance(preset_settings, dict):
            return {}
        return {key: preset_settings[key] for key in _PRESET_MODEL_SETTING_KEYS if key in preset_settings}
    return {}


def _normalize_gen_settings(gen_settings: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(gen_settings or {})
    preset_model_settings = _get_selected_preset_model_settings(normalized)
    normalized.update(preset_model_settings)
    loader = _get_unicanvas_model_loader(_infer_unicanvas_loader_type(normalized))
    generation_mode = loader.forced_mode or str(normalized.get("generation_mode") or DEFAULT_GENERATION_MODE).lower()
    mode_settings = normalized.get("mode_settings", {})
    module = _get_unicanvas_model_module(generation_mode)
    mode_profile = {}
    if isinstance(mode_settings, dict):
        mode_profile = mode_settings.get(generation_mode) or mode_settings.get(module.key) or {}
    defaults = module.defaults
    merged = dict(defaults)
    merged.update(normalized)
    if isinstance(mode_profile, dict):
        merged.update(mode_profile)
    merged.update(preset_model_settings)
    merged["generation_mode"] = module.key
    merged["generation_mode_alias"] = generation_mode
    merged["model_loader"] = loader.key
    if loader.forced_mode:
        merged["loader_forced_generation_mode"] = loader.forced_mode
    if "sampler" in merged and "sampler_name" not in merged:
        merged["sampler_name"] = merged["sampler"]
    if "sampler_name" in merged:
        merged["sampler"] = merged["sampler_name"]
    return module.normalize_settings(merged)

