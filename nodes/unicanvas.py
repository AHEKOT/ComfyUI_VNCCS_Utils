"""VNCCS UniCanvas - in-node canvas editor with direct SDXL draw actions."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import threading
from typing import Any

import numpy as np
import torch
from PIL import Image


_DRAW_LOCK = asyncio.Lock()
_MODEL_CACHE_LOCK = threading.Lock()
_MODEL_CACHE: dict[str, tuple[Any, Any, Any]] = {}
_MAX_UPLOAD_BYTES = 48 * 1024 * 1024
_MAX_PIXELS = 4096 * 4096


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
    import folder_paths

    return folder_paths.get_filename_list("checkpoints")


def _load_checkpoint(ckpt_name: str):
    if not ckpt_name:
        raise ValueError("Checkpoint is required")
    with _MODEL_CACHE_LOCK:
        cached = _MODEL_CACHE.get(ckpt_name)
        if cached is not None:
            return cached

    import nodes

    model, clip, vae = nodes.CheckpointLoaderSimple().load_checkpoint(ckpt_name)
    with _MODEL_CACHE_LOCK:
        _MODEL_CACHE[ckpt_name] = (model, clip, vae)
    return model, clip, vae


def _encode_prompt(clip: Any, text: str):
    import nodes

    return nodes.CLIPTextEncode().encode(clip, text or "")[0]


def _run_sdxl_draw(payload: dict[str, Any]) -> dict[str, Any]:
    import nodes

    mode = str(payload.get("mode") or "img2img")
    if mode not in {"img2img", "inpaint"}:
        raise ValueError("mode must be img2img or inpaint")

    settings = payload.get("settings") or {}
    ckpt_name = str(settings.get("ckpt_name") or "")
    seed = int(settings.get("seed", 0))
    steps = int(settings.get("steps", 24))
    cfg = float(settings.get("cfg", 7.0))
    denoise = float(settings.get("denoise", 0.65 if mode == "img2img" else 1.0))
    sampler_name = str(settings.get("sampler_name") or "euler")
    scheduler = str(settings.get("scheduler") or "normal")
    grow_mask_by = int(settings.get("grow_mask_by", 6))
    positive_text = str(settings.get("positive", ""))
    negative_text = str(settings.get("negative", ""))

    source = _decode_data_url(str(payload.get("image") or ""), "RGB")
    image_tensor = _pil_to_image_tensor(source)
    width, height = source.size

    model, clip, vae = _load_checkpoint(ckpt_name)
    positive = _encode_prompt(clip, positive_text)
    negative = _encode_prompt(clip, negative_text)

    if mode == "inpaint":
        mask_image = _decode_data_url(str(payload.get("mask") or ""), "RGBA")
        if mask_image.size != source.size:
            mask_image = mask_image.resize(source.size, Image.Resampling.BILINEAR)
        mask = _pil_to_mask_tensor(mask_image)
        latent = nodes.VAEEncodeForInpaint().encode(vae, image_tensor, mask, grow_mask_by)[0]
    else:
        latent = nodes.VAEEncode().encode(vae, image_tensor)[0]

    latent = nodes.KSampler().sample(
        model,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        positive,
        negative,
        latent,
        denoise,
    )[0]
    decoded = nodes.VAEDecode().decode(vae, latent)[0]
    result_image = _image_tensor_to_pil(decoded)

    saved = _save_temp_image(result_image)
    return {
        "status": "ok",
        "image": saved,
        "width": width,
        "height": height,
    }


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

    @PromptServer.instance.routes.post("/vnccs/unicanvas/draw")
    async def vnccs_unicanvas_draw(request):
        if not _content_length_ok(request, _MAX_UPLOAD_BYTES * 2 + 1024 * 1024):
            return web.json_response({"error": "UniCanvas draw payload is too large"}, status=413)
        try:
            payload = await request.json()
            async with _DRAW_LOCK:
                result = await asyncio.to_thread(_run_sdxl_draw, payload)
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
