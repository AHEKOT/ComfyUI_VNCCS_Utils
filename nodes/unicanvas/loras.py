"""LoRA and model-patch loading."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .comfy_bridge import _call_node_method
from .paths import _get_full_path_agnostic, _resolve_model_filename


def _clone_model_clip(model: Any, clip: Any) -> tuple[Any, Any]:
    return (model.clone() if hasattr(model, "clone") else model, clip.clone() if hasattr(clip, "clone") else clip)


def _normalize_lora_name(value: Any) -> str:
    return str(value or "").replace("\\", "/").strip().lower()


def _lora_name_matches(value: Any, expected: str) -> bool:
    normalized = _normalize_lora_name(value)
    expected_normalized = _normalize_lora_name(expected)
    return normalized == expected_normalized or os.path.basename(normalized) == os.path.basename(expected_normalized)


def _lora_name_in(value: Any, names: list[str] | tuple[str, ...]) -> bool:
    key = _lora_file_key(value)
    return any(key == _lora_file_key(name) for name in names)


def _lora_file_key(name: Any) -> str:
    try:
        path = _get_lora_full_path(str(name or ""))
    except ValueError:
        # Missing files still reach the loader's error; never collapse distinct folders.
        path = str(name or "").replace("\\", "/").strip()
    return os.path.normcase(os.path.realpath(path))


def _active_lora_names(lora_stack: Any) -> list[str]:
    """Names a LoRA stack actually applies to either the model or CLIP."""
    names = []
    for item in lora_stack if isinstance(lora_stack, list) else []:
        if not isinstance(item, dict) or item.get("enabled") is False:
            continue
        name = str(item.get("name") or item.get("lora_name") or "")
        try:
            strength = float(item.get("strength", item.get("model_strength", 1.0)))
            clip_strength = item.get("clip_strength")
            effective_clip = strength if clip_strength is None else float(clip_strength)
        except (TypeError, ValueError):
            continue
        if name and (strength != 0 or effective_clip != 0):
            names.append(name)
    return names


def _get_lora_full_path(lora_name: str) -> str:
    import folder_paths

    path = _get_full_path_agnostic(folder_paths, "loras", lora_name, require_exists=True)
    if not path:
        resolved = _resolve_model_filename(folder_paths, "loras", lora_name)
        if resolved != lora_name:
            path = _get_full_path_agnostic(folder_paths, "loras", resolved, require_exists=True)
    if not path:
        raise ValueError(f"LoRA not found: {lora_name}")
    return path


def _apply_lora_cached(model: Any, clip: Any, lora_name: str, strength: float, clip_strength: float | None = None):
    effective_clip = strength if clip_strength is None else clip_strength
    if not lora_name or (float(strength or 0) == 0 and float(effective_clip or 0) == 0):
        return model, clip
    import comfy.sd
    import comfy.utils

    lora = comfy.utils.load_torch_file(_get_lora_full_path(lora_name), safe_load=True)
    return comfy.sd.load_lora_for_models(model, clip, lora, strength, strength if clip_strength is None else clip_strength)


def _load_model_patch(patch_name: str):
    if not patch_name:
        raise ValueError("Model patch name is required")
    loaded = _call_node_method(
        ["ModelPatchLoader"],
        ["load_model_patch"],
        name=patch_name,
    )
    if loaded is None:
        raise ValueError(f"Model patch not found or failed to load: {patch_name}")
    return loaded


def _setting_float(settings: dict[str, Any], key: str | None, default: float) -> float:
    if not key:
        return float(default)
    value = settings.get(key, default)
    if value is None or value == "":
        return float(default)
    return float(value)


@dataclass(frozen=True)
class LoraRequirement:
    """A LoRA a model family applies on its own, before the user's LoRA stack.

    Families declare these instead of hand-writing ``apply_loras``. A rule reads
    the LoRA name from ``name_setting`` (falling back to ``default_name``) and is
    applied only when every condition holds:

    * ``enabled_setting`` is truthy (e.g. a Turbo switch), when given;
    * the name matches ``match`` (a canonical file), when given;
    * the draw mode is in ``draw_modes``, when given;
    * the strength is non-zero, and positive when ``require_positive_strength``.

    ``required`` rules apply regardless of the node's own LoRA settings being
    overridden by a linked config; a missing file raises instead of being skipped.
    ``fixed_strength`` pins the strength (the user cannot change it). A LoRA is never
    applied twice: a rule whose file a linked VNCSS Config stack already carries is
    skipped, and the user's stack skips files already applied. ``resolver`` maps the name to a loadable file, e.g. a
    lazy download: it runs when ``resolve_match`` is unset or matches the name.
    ``apply(model, clip, name, strength) -> (model, clip)`` replaces the default merged
    LoRA load, e.g. for adapters that must stay unmerged.
    """

    name_setting: str
    default_name: str = ""
    match: str | None = None
    enabled_setting: str | None = None
    strength_setting: str | None = None
    default_strength: float = 1.0
    fixed_strength: float | None = None
    require_positive_strength: bool = False
    clip_strength: float | None = None
    draw_modes: frozenset[str] | None = None
    required: bool = False
    resolver: Callable[[], str] | None = None
    resolve_match: str | None = None
    apply: Callable[[Any, Any, str, float], tuple[Any, Any]] | None = None
    description: str = ""

    def resolve(self, settings: dict[str, Any]) -> tuple[str, float] | None:
        """Return ``(lora_name, strength)`` when the rule applies to these settings."""
        if not self.required and (settings.get("_config_model_override") or settings.get("model_loader") == "external"):
            return None
        name = str(settings.get(self.name_setting) or self.default_name or "")
        if not name:
            return None
        if self.enabled_setting and not settings.get(self.enabled_setting):
            return None
        if self.match and not _lora_name_matches(name, self.match):
            return None
        if self.draw_modes is not None and str(settings.get("draw_mode") or "") not in self.draw_modes:
            return None
        if self.fixed_strength is not None:
            strength = float(self.fixed_strength)
        else:
            strength = _setting_float(settings, self.strength_setting, self.default_strength)
        if strength == 0 or (self.require_positive_strength and strength <= 0):
            return None
        if self.resolver is not None and (self.resolve_match is None or _lora_name_matches(name, self.resolve_match)):
            name = self.resolver()
        elif name == self.default_name and "/" in name.replace("\\", "/"):
            import folder_paths

            name = _resolve_model_filename(folder_paths, "loras", name, allow_subfolder_fallback=True)
        return name, strength

    def describe(self) -> dict[str, Any]:
        """JSON-safe summary for the frontend (``/vnccs/unicanvas/assets``)."""
        return {
            "name_setting": self.name_setting,
            "default_name": self.default_name,
            "match": self.match,
            "enabled_setting": self.enabled_setting,
            "strength_setting": self.strength_setting,
            "fixed_strength": self.fixed_strength,
            "draw_modes": sorted(self.draw_modes) if self.draw_modes is not None else None,
            "required": self.required,
            "description": self.description,
        }


def _apply_lora_requirements(
    model: Any,
    clip: Any,
    requirements: tuple[LoraRequirement, ...],
    settings: dict[str, Any],
) -> tuple[Any, Any, list[str]]:
    """Apply the family's own LoRAs; return every applied name so the user stack skips it."""
    external = settings.get("_external")
    applied = _active_lora_names(external.get("lora_stack") if isinstance(external, dict) else None)
    for requirement in requirements:
        resolved = requirement.resolve(settings)
        if resolved is None:
            continue
        name, strength = resolved
        if _lora_name_in(name, applied):
            continue
        if requirement.apply is not None:
            model, clip = requirement.apply(model, clip, name, strength)
        else:
            model, clip = _apply_lora_cached(model, clip, name, strength, clip_strength=requirement.clip_strength)
        applied.append(name)
    return model, clip, applied


def _apply_lora_stack(model: Any, clip: Any, lora_stack: Any, skip_names: list[str] | tuple[str, ...] = ()):
    """Apply the user's LoRA stack (node widget or VNCSS Config); a file already applied is skipped."""
    if not isinstance(lora_stack, list):
        return model, clip
    applied = list(skip_names)
    for item in lora_stack:
        if not isinstance(item, dict) or item.get("enabled") is False:
            continue
        lora_name = str(item.get("name") or item.get("lora_name") or "")
        if _lora_name_in(lora_name, applied):
            continue
        strength = float(item.get("strength", item.get("model_strength", 1.0)))
        clip_strength = item.get("clip_strength", None)
        effective_clip = strength if clip_strength is None else float(clip_strength)
        if strength == 0 and effective_clip == 0:
            continue
        applied.append(lora_name)
        model, clip = _apply_lora_cached(
            model,
            clip,
            lora_name,
            strength,
            None if clip_strength is None else float(clip_strength),
        )
    return model, clip
