"""VNCSS Config node: external model plumbing for VNCCS UniCanvas."""
from __future__ import annotations

import json
import os
from typing import Any

# MiniMax H3 (REF2VA <Picture N>) and Qwen-Image-2.1 (<image N>) accept up to 10 reference
# images beyond the working area, so the node exposes reference_image_1..10.
REFERENCE_INPUTS = tuple(f"reference_image_{index}" for index in range(1, 11))


def _load_state(node_state: str) -> dict[str, Any]:
    try:
        state = json.loads(node_state) if isinstance(node_state, str) and node_state.strip() else (node_state or {})
    except Exception:
        state = {}
    return state if isinstance(state, dict) else {}


def _resolve_lora_path(lora_name: str) -> str:
    """Resolve a loras-folder name (as returned by folder_paths.get_filename_list) to a full path."""
    import folder_paths

    raw = str(lora_name or "").strip()
    normalized = raw.replace("\\", "/")
    candidates = [raw]
    if normalized and normalized != raw:
        candidates.append(normalized)

    for candidate in candidates:
        if not candidate:
            continue
        try:
            full_path = folder_paths.get_full_path("loras", candidate)
        except Exception:
            full_path = None
        if full_path:
            return full_path

    raise RuntimeError(f"[VNCCS Config] LoRA not found: {lora_name}")


def _apply_lora_cached(model, clip, lora_name, strength, clip_strength=None):
    """Resolve a loras-folder name, then patch that LoRA onto model/clip.

    Resolution is mandatory: names from the picker are loras-folder relative, while
    comfy.utils.load_torch_file would resolve them against the process CWD. Despite
    the historical name this helper does not cache the loaded weights.
    """
    import comfy.sd
    import comfy.utils

    lora_sd = comfy.utils.load_torch_file(_resolve_lora_path(lora_name), safe_load=True)
    return comfy.sd.load_lora_for_models(
        model, clip, lora_sd, float(strength),
        float(strength) if clip_strength is None else float(clip_strength),
    )


def normalize_lora_stack(raw: Any) -> list[dict[str, Any]]:
    stack: list[dict[str, Any]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        try:
            strength = float(item.get("strength", 1.0))
        except (TypeError, ValueError):
            strength = 1.0
        clip_strength: float | None
        try:
            raw_clip = item.get("clip_strength")
            clip_strength = None if raw_clip is None else float(raw_clip)
        except (TypeError, ValueError):
            clip_strength = None
        stack.append(
            {"name": name, "strength": strength, "enabled": bool(item.get("enabled", True)), "clip_strength": clip_strength}
        )
    return stack


def apply_lora_stack(model: Any, clip: Any, lora_stack: list[dict[str, Any]], config: Any = None):
    applied: list[str] = []
    for item in lora_stack:
        if not item.get("enabled"):
            continue
        strength = float(item.get("strength", 1.0))
        clip_strength = item.get("clip_strength")
        effective_clip = strength if clip_strength is None else float(clip_strength)
        if abs(strength) <= 1e-6 and abs(effective_clip) <= 1e-6:
            continue
        # The same file is applied once; later duplicates are dropped silently.
        key = os.path.normcase(os.path.realpath(_resolve_lora_path(item["name"])))
        if key in applied:
            continue
        applied.append(key)
        model, clip = _apply_lora_cached(model, clip, item["name"], item["strength"], item.get("clip_strength"))
    return model, clip


class VNCCS_Config:
    """Bundles external MODEL/CLIP/VAE, a LoRA stack and reference images."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "node_state": ("STRING", {"multiline": False, "default": "{}"}),
            },
            "optional": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                **{name: ("IMAGE",) for name in REFERENCE_INPUTS},
            },
        }

    RETURN_TYPES = ("VNCSS_CONFIG",)
    RETURN_NAMES = ("config",)
    FUNCTION = "execute"
    CATEGORY = "VNCCS/config"

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    def execute(
        self,
        node_state: str = "{}",
        model: Any = None,
        clip: Any = None,
        vae: Any = None,
        audio_vae: Any = None,
        **references_kwargs: Any,
    ) -> tuple[dict[str, Any]]:
        # Reference images arrive as reference_image_N kwargs (N is 1..10 and only
        # connected sockets are passed by ComfyUI), so they are collected by name
        # instead of ten explicit parameters.
        state = _load_state(node_state)
        edit_model = bool(state.get("edit_model", False))
        lora_stack = normalize_lora_stack(state.get("loras"))

        if model is None:
            raise RuntimeError("[VNCCS Config] Model input is not connected.")
        if clip is None:
            raise RuntimeError("[VNCCS Config] CLIP input is not connected.")
        if vae is None:
            raise RuntimeError("[VNCCS Config] VAE input is not connected.")

        references = {
            name: references_kwargs[name]
            for name in REFERENCE_INPUTS
            if references_kwargs.get(name) is not None
        }
        if edit_model and "reference_image_1" not in references:
            raise RuntimeError("[VNCCS Config] Edit model requires reference_image_1.")

        model, clip = apply_lora_stack(model, clip, lora_stack)

        config = {
            "model": model,
            "clip": clip,
            "vae": vae,
            "audio_vae": audio_vae,
            "references": references,
            "edit_model": edit_model,
            "lora_stack": lora_stack,
        }
        return (config,)
