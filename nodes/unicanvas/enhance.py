"""Prompt enhance feature: the default system prompts and the magic-wand request."""

from __future__ import annotations

import os
from typing import Any

import torch

from .generation import _normalize_gen_settings
from .imaging import _decode_data_url
from .loaders import _peek_cached_generation_assets
from .locks import _COMFY_MODEL_OP_LOCK
from .paths import _EXTENSION_ROOT
from .prompt_enhance import edit_images, enhance_text, is_enhance_encoder, load_enhance_clip, release_enhance_clip, resolve_enhance_clip_name

DEFAULTS_DIR = os.path.join(_EXTENSION_ROOT, "config", "prompt_enhance")
MAX_TEXT_CHARS = 8000
MAX_SYSTEM_CHARS = 60000


def load_default_prompts() -> list[dict[str, str]]:
    """``<family>.<positive|edit|negative>.txt`` files grouped into one entry per family."""
    entries: dict[str, dict[str, str]] = {}
    for name in sorted(os.listdir(DEFAULTS_DIR)) if os.path.isdir(DEFAULTS_DIR) else []:
        stem, extension = os.path.splitext(name)
        family, _, kind = stem.rpartition(".")
        if extension != ".txt" or not family or kind not in ("positive", "edit", "negative"):
            continue
        with open(os.path.join(DEFAULTS_DIR, name), encoding="utf-8") as handle:
            entry = entries.setdefault(family, {"family": family, "positive": "", "edit": "", "negative": ""})
            entry[kind] = handle.read().strip()
    return list(entries.values())


def _loaded_family_clip(settings: dict[str, Any], name: str) -> Any:
    """The family's CLIP when it is already loaded and is the enhance encoder: no second 9 GB copy."""
    try:
        normalized = _normalize_gen_settings(dict(settings))
    except Exception:
        return None
    if not is_enhance_encoder(normalized, name):
        return None
    assets = _peek_cached_generation_assets(normalized)
    return assets[1] if assets else None


def _run_unicanvas_enhance_prompt(payload: dict[str, Any]) -> dict[str, Any]:
    payload = payload or {}
    text = str(payload.get("text") or "").strip()
    system = str(payload.get("system_prompt") or "").strip()
    if not text:
        raise ValueError("The prompt is empty.")
    if not system:
        raise ValueError("No system prompt is set for this model family (UniCanvas settings > Prompt enhance).")
    if len(text) > MAX_TEXT_CHARS or len(system) > MAX_SYSTEM_CHARS:
        raise ValueError("The prompt or the system prompt is too long.")
    settings = payload["settings"] if isinstance(payload.get("settings"), dict) else {}
    name = resolve_enhance_clip_name(payload.get("model"))  # may download the default encoder, so not under the model lock
    images = None
    if payload.get("kind") != "negative":  # edit-style prompts are written while looking at the canvas and references
        images = edit_images(_decode_data_url(str(payload["image"]), "RGB") if payload.get("image") else None, settings)
    with _COMFY_MODEL_OP_LOCK, torch.inference_mode():
        clip = _loaded_family_clip(settings, name)
        dedicated = clip is None
        if dedicated:
            clip = load_enhance_clip(name)
        try:
            enhanced = enhance_text(clip, text, system, images)
        finally:
            if dedicated:  # not the draw's own encoder: give its VRAM back right away
                release_enhance_clip(clip)
                del clip
    if not enhanced:
        raise RuntimeError("The text encoder returned no usable prompt. Check the system prompt for this family.")
    return {"prompt": enhanced}
