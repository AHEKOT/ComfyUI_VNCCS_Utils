"""VNCCS UniCanvas - in-node canvas editor with direct SDXL draw actions."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import inspect
import threading
from typing import Any
import os
import ntpath

import numpy as np
import torch
from PIL import Image


_DRAW_LOCK = asyncio.Lock()
_MODEL_CACHE_LOCK = threading.Lock()
_MODEL_CACHE: dict[Any, tuple[Any, Any, Any]] = {}
_LORA_CACHE: dict[str, Any] = {}
_MAX_UPLOAD_BYTES = 48 * 1024 * 1024
_MAX_PIXELS = 4096 * 4096

ILLUSTRIOUS_DEFAULTS = {
    "generation_mode": "illustrious",
    "ckpt_name": "",
    "sampler": "euler",
    "sampler_name": "euler",
    "scheduler": "normal",
    "steps": 20,
    "cfg": 8.0,
}

ANIMA_DEFAULTS = {
    "generation_mode": "anima",
    "diffusion_model_name": "",
    "clip_name": "qwen_3_06b_base.safetensors",
    "vae_name": "qwen_image_vae.safetensors",
    "clip_type": "stable_diffusion",
    "sampler": "er_sde",
    "sampler_name": "er_sde",
    "scheduler": "simple",
    "steps": 30,
    "cfg": 4.0,
    "turbo_enabled": False,
    "dmd_lora_name": "anima\\anima-turbo-lora-v0.1.safetensors",
    "dmd_lora_strength": 1.0,
    "lora_stack": [],
}


class VNCCS_UniCanvas:
    """A ComfyUI node that hosts the VNCCS UniCanvas editor.

    The node's visible work happens in the frontend widget. Its DRAW button calls
    the custom backend endpoint below and intentionally does not queue the whole
    ComfyUI graph.
    """

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("unicanvas_state",)
    FUNCTION = "export_state"
    CATEGORY = "VNCCS/canvas"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "unicanvas_state": ("STRING", {"multiline": True, "default": "{}"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, unicanvas_state: str = "{}", unique_id: str | None = None):
        return unicanvas_state

    def export_state(self, unicanvas_state: str = "{}", unique_id: str | None = None):
        return (unicanvas_state,)


def _content_length_ok(request, max_bytes: int) -> bool:
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        return int(raw_length) <= max_bytes
    except Exception:
        return False


def _decode_data_url(data_url: str, mode: str) -> Image.Image:
    if not isinstance(data_url, str) or not data_url:
        raise ValueError("Missing image data")
    payload = data_url.split(",", 1)[1] if "," in data_url else data_url
    raw = base64.b64decode(payload, validate=False)
    if len(raw) > _MAX_UPLOAD_BYTES:
        raise ValueError("Image upload is too large")
    image = Image.open(io.BytesIO(raw))
    if image.width * image.height > _MAX_PIXELS:
        raise ValueError("Image dimensions are too large")
    return image.convert(mode)


def _pil_to_image_tensor(image: Image.Image) -> torch.Tensor:
    arr = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None,]


def _pil_to_mask_tensor(image: Image.Image) -> torch.Tensor:
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0
    alpha = rgba[..., 3]
    luminance = rgba[..., :3].mean(axis=2)
    mask = np.maximum(alpha, luminance)
    return torch.from_numpy(mask)[None,]


def _image_tensor_to_pil(images: torch.Tensor) -> Image.Image:
    image = images[0].detach().cpu().numpy()
    image = np.clip(image * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(image)


def _normalize_path(value: str) -> str:
    return str(value or "").strip().replace("\\", os.sep).replace("/", os.sep)


def _is_absolute_any_os(value: str) -> bool:
    raw = str(value or "").strip()
    return os.path.isabs(raw) or ntpath.isabs(raw) or bool(ntpath.splitdrive(raw)[0])


def _path_variants(name: str) -> list[str]:
    raw = str(name or "").strip()
    if not raw:
        return []
    variants = []
    for candidate in (raw, raw.replace("\\", "/"), raw.replace("/", "\\")):
        if candidate and candidate not in variants:
            variants.append(candidate)
    return variants


def _safe_get_folder_paths(folder_paths: Any, category: str) -> list[str]:
    try:
        return folder_paths.get_folder_paths(category) or []
    except Exception:
        return []


def _is_under_any_folder(path: str, folders: list[str]) -> bool:
    try:
        path_abs = os.path.abspath(_normalize_path(path))
        for folder in folders:
            folder_abs = os.path.abspath(_normalize_path(folder))
            if os.path.commonpath([folder_abs, path_abs]) == folder_abs:
                return True
    except Exception:
        return False
    return False


def _get_full_path_agnostic(folder_paths: Any, category: str, name: str, require_exists: bool = False) -> str | None:
    folders = _safe_get_folder_paths(folder_paths, category)
    first_match = None

    for candidate in _path_variants(name):
        try:
            found = folder_paths.get_full_path(category, candidate)
        except Exception:
            found = None
        if found:
            if os.path.exists(found):
                return found
            if first_match is None:
                first_match = found

        for folder in folders:
            joined = os.path.join(folder, _normalize_path(candidate))
            if os.path.exists(joined):
                return joined
            if first_match is None:
                first_match = joined

        if _is_absolute_any_os(candidate) and _is_under_any_folder(candidate, folders):
            normalized_candidate = _normalize_path(candidate)
            if os.path.exists(normalized_candidate):
                return normalized_candidate
            if first_match is None:
                first_match = normalized_candidate

    return None if require_exists else first_match


def _safe_filename_list(category: str) -> list[str]:
    try:
        import folder_paths

        return folder_paths.get_filename_list(category)
    except Exception:
        return []


def _normalize_gen_settings(gen_settings: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(gen_settings or {})
    generation_mode = str(normalized.get("generation_mode", "illustrious")).lower()
    mode_settings = normalized.get("mode_settings", {})
    mode_profile = mode_settings.get(generation_mode, {}) if isinstance(mode_settings, dict) else {}
    defaults = ANIMA_DEFAULTS if generation_mode == "anima" else ILLUSTRIOUS_DEFAULTS
    merged = dict(defaults)
    merged.update(normalized)
    if isinstance(mode_profile, dict):
        merged.update(mode_profile)
    merged["generation_mode"] = generation_mode
    if "sampler" in merged and "sampler_name" not in merged:
        merged["sampler_name"] = merged["sampler"]
    if "sampler_name" in merged:
        merged["sampler"] = merged["sampler_name"]
    return merged


def _call_loader_node(class_names: list[str], method_names: list[str], **kwargs):
    import nodes

    mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    for class_name in class_names:
        loader_cls = mappings.get(class_name)
        if loader_cls is None:
            continue
        loader = loader_cls()
        for method_name in method_names:
            method = getattr(loader, method_name, None)
            if method is None:
                continue
            signature = inspect.signature(method)
            accepted_kwargs = {key: value for key, value in kwargs.items() if key in signature.parameters}
            result = method(**accepted_kwargs)
            if isinstance(result, tuple):
                return result[0]
            return result
    return None


def _call_node_method(class_names: list[str], method_names: list[str], **kwargs):
    import nodes

    mappings = getattr(nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    for class_name in class_names:
        node_cls = mappings.get(class_name)
        if node_cls is None:
            continue
        node_instance = node_cls()
        for method_name in method_names:
            method = getattr(node_instance, method_name, None)
            if method is None:
                continue
            signature = inspect.signature(method)
            accepted_kwargs = {key: value for key, value in kwargs.items() if key in signature.parameters}
            return method(**accepted_kwargs)
    return None


def _load_anima_assets(gen_settings: dict[str, Any]):
    import comfy.sd
    import folder_paths

    diffusion_model_name = gen_settings.get("diffusion_model_name")
    clip_name = gen_settings.get("clip_name")
    vae_name = gen_settings.get("vae_name")
    clip_type_name = str(gen_settings.get("clip_type", "stable_diffusion") or "stable_diffusion").lower()

    if not diffusion_model_name:
        raise ValueError("No Diffusion Model selected for UniCanvas ANIMA mode")
    if not clip_name:
        raise ValueError("No CLIP selected for UniCanvas ANIMA mode")
    if not vae_name:
        raise ValueError("No VAE selected for UniCanvas ANIMA mode")

    model = _call_loader_node(
        ["UNETLoader", "Load Diffusion Model"],
        ["load_unet", "load_model", "load_diffusion_model"],
        unet_name=diffusion_model_name,
        model_name=diffusion_model_name,
        diffusion_model_name=diffusion_model_name,
        weight_dtype="default",
    )
    if model is None and hasattr(comfy.sd, "load_diffusion_model"):
        diffusion_model_path = _get_full_path_agnostic(folder_paths, "diffusion_models", diffusion_model_name)
        if diffusion_model_path:
            model = comfy.sd.load_diffusion_model(diffusion_model_path)

    clip = _call_loader_node(
        ["CLIPLoader", "Load CLIP"],
        ["load_clip", "load_model"],
        clip_name=clip_name,
        model_name=clip_name,
        type=clip_type_name,
        device="default",
    )
    if clip is None and hasattr(comfy.sd, "load_clip"):
        clip_path = _get_full_path_agnostic(folder_paths, "text_encoders", clip_name)
        if clip_path:
            clip_type = getattr(comfy.sd.CLIPType, clip_type_name.upper(), None)
            if clip_type is None:
                raise ValueError(
                    f"ComfyUI CLIPType.{clip_type_name.upper()} is not available. "
                    "ANIMA expects CLIPLoader type 'stable_diffusion'."
                )
            clip = comfy.sd.load_clip(
                ckpt_paths=[clip_path],
                embedding_directory=folder_paths.get_folder_paths("embeddings"),
                clip_type=clip_type,
            )

    vae = _call_loader_node(
        ["VAELoader", "Load VAE"],
        ["load_vae", "load_model"],
        vae_name=vae_name,
        model_name=vae_name,
    )
    if vae is None and hasattr(comfy.sd, "load_vae"):
        vae_path = _get_full_path_agnostic(folder_paths, "vae", vae_name)
        if vae_path:
            vae = comfy.sd.load_vae(vae_path)

    if model is None:
        raise ValueError(f"Failed to load Diffusion Model '{diffusion_model_name}'")
    if clip is None:
        raise ValueError(f"Failed to load CLIP '{clip_name}'")
    if vae is None:
        raise ValueError(f"Failed to load VAE '{vae_name}'")
    return model, clip, vae


def _load_generation_assets(gen_settings: dict[str, Any]):
    import comfy.sd
    import folder_paths

    generation_mode = str(gen_settings.get("generation_mode", "illustrious")).lower()
    if generation_mode == "anima":
        asset_key = (
            generation_mode,
            gen_settings.get("diffusion_model_name", ""),
            gen_settings.get("clip_name", ""),
            gen_settings.get("vae_name", ""),
        )
        with _MODEL_CACHE_LOCK:
            cached = _MODEL_CACHE.get(asset_key)
            if cached is not None:
                return cached
        assets = _load_anima_assets(gen_settings)
        with _MODEL_CACHE_LOCK:
            _MODEL_CACHE[asset_key] = assets
        return assets

    ckpt_name = str(gen_settings.get("ckpt_name") or "")
    if not ckpt_name:
        raise ValueError("Checkpoint is required")
    asset_key = (generation_mode, ckpt_name)
    with _MODEL_CACHE_LOCK:
        cached = _MODEL_CACHE.get(asset_key)
        if cached is not None:
            return cached

    ckpt_path = _get_full_path_agnostic(folder_paths, "checkpoints", ckpt_name, require_exists=True)
    if not ckpt_path:
        raise ValueError(f"Checkpoint path not found for '{ckpt_name}'")
    out = comfy.sd.load_checkpoint_guess_config(
        ckpt_path,
        output_vae=True,
        output_clip=True,
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
    )
    assets = out[:3]
    if any(item is None for item in assets):
        raise ValueError(f"Failed to load checkpoint assets from '{ckpt_name}'")
    with _MODEL_CACHE_LOCK:
        _MODEL_CACHE[asset_key] = assets
    return assets


def _clone_model_clip(model: Any, clip: Any) -> tuple[Any, Any]:
    return (model.clone() if hasattr(model, "clone") else model, clip.clone() if hasattr(clip, "clone") else clip)


def _get_lora_full_path(lora_name: str) -> str:
    import folder_paths

    path = _get_full_path_agnostic(folder_paths, "loras", lora_name, require_exists=True)
    if not path:
        raise ValueError(f"LoRA not found: {lora_name}")
    return path


def _apply_lora_cached(model: Any, clip: Any, lora_name: str, strength: float, clip_strength: float | None = None):
    if not lora_name or float(strength or 0) == 0:
        return model, clip
    import comfy.sd
    import comfy.utils

    with _MODEL_CACHE_LOCK:
        lora = _LORA_CACHE.get(lora_name)
    if lora is None:
        lora = comfy.utils.load_torch_file(_get_lora_full_path(lora_name), safe_load=True)
        with _MODEL_CACHE_LOCK:
            _LORA_CACHE[lora_name] = lora
    return comfy.sd.load_lora_for_models(model, clip, lora, strength, strength if clip_strength is None else clip_strength)


def _apply_generation_loras(model: Any, clip: Any, gen_settings: dict[str, Any]):
    generation_mode = str(gen_settings.get("generation_mode", "illustrious")).lower()
    if generation_mode == "anima" and gen_settings.get("turbo_enabled"):
        model, clip = _apply_lora_cached(
            model,
            clip,
            str(gen_settings.get("dmd_lora_name") or ""),
            float(gen_settings.get("dmd_lora_strength", 1.0)),
            0.0,
        )
    elif generation_mode != "anima":
        for key in ("dmd_lora_name", "age_lora_name"):
            lora_name = str(gen_settings.get(key) or "")
            if lora_name:
                strength_key = key.replace("_name", "_strength")
                model, clip = _apply_lora_cached(model, clip, lora_name, float(gen_settings.get(strength_key, 1.0)))

    lora_stack = gen_settings.get("lora_stack") or []
    if isinstance(lora_stack, list):
        for item in lora_stack:
            if not isinstance(item, dict):
                continue
            lora_name = str(item.get("name") or item.get("lora_name") or "")
            strength = float(item.get("strength", item.get("model_strength", 1.0)))
            clip_strength = item.get("clip_strength", None)
            model, clip = _apply_lora_cached(
                model,
                clip,
                lora_name,
                strength,
                None if clip_strength is None else float(clip_strength),
            )
    return model, clip


def _encode_generation_prompt(clip: Any, text: str, gen_settings: dict[str, Any]):
    if str(gen_settings.get("generation_mode", "illustrious")).lower() == "anima":
        encoded = _call_node_method(["CLIPTextEncode"], ["encode"], clip=clip, text=text or "")
        if isinstance(encoded, tuple) and encoded:
            return encoded[0]
        if encoded is not None:
            return encoded

    tokens = clip.tokenize(text or "")
    cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
    return [[cond, {"pooled_output": pooled}]]


def _validate_anima_conditioning(positive: Any, negative: Any, clip_name: str) -> None:
    def context_width(conditioning):
        try:
            if not conditioning:
                return None
            return conditioning[0][0].shape[-1]
        except Exception:
            return None

    widths = [width for width in (context_width(positive), context_width(negative)) if width is not None]
    bad_widths = [width for width in widths if width != 1024]
    if bad_widths:
        raise ValueError(
            "ANIMA conditioning has the wrong text-encoder width "
            f"{bad_widths[0]} instead of 1024. Select 'qwen_3_06b_base.safetensors' in the CLIP field; "
            f"current CLIP is '{clip_name}'."
        )


def _encode_source_latent(vae: Any, image_tensor: torch.Tensor, mask: torch.Tensor | None, grow_mask_by: int):
    import nodes

    if mask is not None:
        encoded = _call_node_method(
            ["VAEEncodeForInpaint"],
            ["encode"],
            vae=vae,
            pixels=image_tensor,
            image=image_tensor,
            mask=mask,
            grow_mask_by=grow_mask_by,
        )
        if isinstance(encoded, tuple) and encoded:
            return encoded[0]
        if encoded is not None:
            return encoded
        return nodes.VAEEncodeForInpaint().encode(vae, image_tensor, mask, grow_mask_by)[0]

    encoded = _call_node_method(["VAEEncode"], ["encode"], vae=vae, pixels=image_tensor, image=image_tensor)
    if isinstance(encoded, tuple) and encoded:
        return encoded[0]
    if encoded is not None:
        return encoded
    return nodes.VAEEncode().encode(vae, image_tensor)[0]


def _sample_generation_latent(
    model: Any,
    positive: Any,
    negative: Any,
    latent: Any,
    seed: int,
    steps: int,
    cfg: float,
    sampler_name: str,
    scheduler: str,
    denoise: float,
    gen_settings: dict[str, Any],
):
    import nodes

    if str(gen_settings.get("generation_mode", "illustrious")).lower() == "anima":
        sampled = _call_node_method(
            ["KSampler"],
            ["sample"],
            model=model,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            positive=positive,
            negative=negative,
            latent_image=latent,
            latent=latent,
            denoise=denoise,
        )
        if isinstance(sampled, tuple) and sampled:
            return sampled[0]
        if sampled is not None:
            return sampled

    return nodes.common_ksampler(
        model=model,
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler_name=sampler_name,
        scheduler=scheduler,
        positive=positive,
        negative=negative,
        latent=latent,
        denoise=denoise,
    )[0]


def _decode_generation_samples(vae: Any, samples: Any, gen_settings: dict[str, Any]):
    def unwrap_latent_samples(value):
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

    if str(gen_settings.get("generation_mode", "illustrious")).lower() == "anima":
        latent_payload = samples if isinstance(samples, dict) else {"samples": samples}
        latent_tensor = unwrap_latent_samples(latent_payload)
        decoded = _call_node_method(["VAEDecode"], ["decode"], samples={"samples": latent_tensor}, vae=vae)
        if isinstance(decoded, tuple) and decoded:
            return decoded[0]
        if decoded is not None:
            return decoded
        return vae.decode(latent_tensor)

    latent_samples = unwrap_latent_samples(samples)
    return vae.decode_tiled(latent_samples, tile_x=512, tile_y=512)


def _save_temp_image(image: Image.Image, prefix: str = "VNCCS_UniCanvas") -> dict[str, str]:
    import folder_paths

    output_dir = folder_paths.get_temp_directory()
    full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        prefix, output_dir, image.width, image.height
    )
    file = f"{filename}_{counter:05}_.png"
    image.save(f"{full_output_folder}/{file}", compress_level=1)
    return {"filename": file, "subfolder": subfolder, "type": "temp"}


def _get_checkpoint_names() -> list[str]:
    return _safe_filename_list("checkpoints")


def _get_unicanvas_assets() -> dict[str, Any]:
    try:
        import comfy.samplers

        samplers = list(comfy.samplers.KSampler.SAMPLERS)
        schedulers = list(comfy.samplers.KSampler.SCHEDULERS)
    except Exception:
        samplers = []
        schedulers = []
    return {
        "checkpoints": _safe_filename_list("checkpoints"),
        "diffusion_models": _safe_filename_list("diffusion_models"),
        "text_encoders": _safe_filename_list("text_encoders"),
        "vae_models": _safe_filename_list("vae"),
        "loras": _safe_filename_list("loras"),
        "samplers": samplers,
        "schedulers": schedulers,
    }


def _load_checkpoint(ckpt_name: str):
    return _load_generation_assets({"generation_mode": "illustrious", "ckpt_name": ckpt_name})


def _encode_prompt(clip: Any, text: str):
    return _encode_generation_prompt(clip, text, {"generation_mode": "illustrious"})


def _run_unicanvas_draw(payload: dict[str, Any]) -> dict[str, Any]:
    mode = str(payload.get("mode") or "img2img")
    if mode not in {"img2img", "inpaint"}:
        raise ValueError("mode must be img2img or inpaint")

    settings = _normalize_gen_settings(payload.get("settings") or {})
    seed = int(settings.get("seed", 0))
    steps = int(settings.get("steps", 24))
    cfg = float(settings.get("cfg", 7.0))
    denoise = float(settings.get("denoise", 0.65 if mode == "img2img" else 1.0))
    sampler_name = str(settings.get("sampler_name") or settings.get("sampler") or "euler")
    scheduler = str(settings.get("scheduler") or "normal")
    grow_mask_by = int(settings.get("grow_mask_by", 6))
    positive_text = str(settings.get("positive", ""))
    negative_text = str(settings.get("negative", ""))

    source = _decode_data_url(str(payload.get("image") or ""), "RGB")
    image_tensor = _pil_to_image_tensor(source)
    width, height = source.size

    with torch.inference_mode():
        model, clip, vae = _load_generation_assets(settings)
        model, clip = _clone_model_clip(model, clip)
        model, clip = _apply_generation_loras(model, clip, settings)
        positive = _encode_generation_prompt(clip, positive_text, settings)
        negative = _encode_generation_prompt(clip, negative_text, settings)
        if str(settings.get("generation_mode", "illustrious")).lower() == "anima":
            _validate_anima_conditioning(positive, negative, str(settings.get("clip_name") or ""))

        mask = None
        if mode == "inpaint":
            mask_image = _decode_data_url(str(payload.get("mask") or ""), "RGBA")
            if mask_image.size != source.size:
                mask_image = mask_image.resize(source.size, Image.Resampling.BILINEAR)
            mask = _pil_to_mask_tensor(mask_image)
        latent = _encode_source_latent(vae, image_tensor, mask, grow_mask_by)
        latent = _sample_generation_latent(
            model=model,
            positive=positive,
            negative=negative,
            latent=latent,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
            denoise=denoise,
            gen_settings=settings,
        )
        decoded = _decode_generation_samples(vae, latent, settings)
        result_image = _image_tensor_to_pil(decoded)

    saved = _save_temp_image(result_image)
    return {
        "status": "ok",
        "image": saved,
        "width": width,
        "height": height,
        "generation_mode": settings.get("generation_mode", "illustrious"),
    }


def _run_sdxl_draw(payload: dict[str, Any]) -> dict[str, Any]:
    return _run_unicanvas_draw(payload)


def register_unicanvas_routes() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    @PromptServer.instance.routes.get("/vnccs/unicanvas/checkpoints")
    async def vnccs_unicanvas_checkpoints(_request):
        try:
            return web.json_response({"checkpoints": _get_checkpoint_names()})
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/vnccs/unicanvas/assets")
    async def vnccs_unicanvas_assets(_request):
        try:
            return web.json_response(_get_unicanvas_assets())
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.post("/vnccs/unicanvas/draw")
    async def vnccs_unicanvas_draw(request):
        if not _content_length_ok(request, _MAX_UPLOAD_BYTES * 2 + 1024 * 1024):
            return web.json_response({"error": "UniCanvas draw payload is too large"}, status=413)
        try:
            payload = await request.json()
            async with _DRAW_LOCK:
                result = await asyncio.to_thread(_run_unicanvas_draw, payload)
            return web.json_response(result)
        except Exception as exc:
            import traceback

            traceback.print_exc()
            return web.json_response({"error": str(exc)}, status=500)


NODE_CLASS_MAPPINGS = {
    "VNCCS_UniCanvas": VNCCS_UniCanvas,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VNCCS_UniCanvas": "VNCCS UniCanvas",
}
