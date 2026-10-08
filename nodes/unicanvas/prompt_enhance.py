"""Prompt enhance: rewrite a prompt with a Qwen3-VL text encoder (ComfyUI ``TextGenerate``).

Enhancement always runs on one dedicated Qwen3-VL encoder - by default the one Qwen-Image-2.1
uses, downloaded from Hugging Face on first use, or any Qwen3-VL file picked in the ComfyUI
settings - never on the family's own CLIP (SDXL's CLIP cannot generate text at all). The
per-family system prompts are data (``config/prompt_enhance/``, editable in the settings);
nothing in this module knows a family. Enhancement is skipped by callers whenever a VNCSS
Config is linked (``request.external``): a custom model stack has no system prompt.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import shutil
import threading
from typing import Any

import torch
from PIL import Image

from .comfy_bridge import _call_loader_node, _safe_filename_list
from .debug import _uc_log
from .imaging import _decode_data_url, _pil_to_image_tensor
from .paths import _safe_get_folder_paths
from .progress import _set_draw_progress
from .sampling import _ensure_direct_sampling_prompt_context

# Pixel budgets for the pictures the encoder looks at. One 32x32 block is one token, so a megapixel is
# about 1000 tokens. The canvas is what the edit is about (small text must stay readable), each
# reference gets less, and the whole set is capped so five or ten references cannot flood the context.
CANVAS_PIXELS = 1024 * 1024
REFERENCE_PIXELS = 720 * 720
MIN_REFERENCE_PIXELS = 384 * 384
TOTAL_PIXELS = 3_500_000
IMAGE_STEP = 32  # the encoder patches in 32-px steps
# The encoder Qwen-Image-2.1 ships with (config/unicanvas_presets.json, preset qwen_image21).
DEFAULT_ENHANCE_CLIP = "qwen3vl_8b_int8_convrot.safetensors"
DEFAULT_ENHANCE_CLIP_REPO = "Comfy-Org/Qwen-Image-2.1"
DEFAULT_ENHANCE_CLIP_PATH = "text_encoders/qwen3vl_8b_int8_convrot.safetensors"
ENHANCE_CLIP_TYPE = "qwen_image"
_CLIP_LOCK = threading.Lock()
MAX_REFERENCES = 10
MAX_NEW_TOKENS = 2048  # same as VNCCS; safe because enhance_text releases the executor state
_SAMPLING = {
    "temperature": 0.3,
    "top_k": 64,
    "top_p": 0.95,
    "min_p": 0.05,
    "repetition_penalty": 1.05,
    "presence_penalty": 0.0,
}
# Official rewriters answer in JSON (QI2.1 "rewritten_prompt").
_JSON_KEYS = ("rewritten_prompt", "rewritten", "prompt")
_JSON_FIELD = re.compile(r'"(?:rewritten_prompt|rewritten)"\s*:\s*"((?:[^"\\]|\\.)*)"', re.IGNORECASE)


_CJK = re.compile("[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]")
# The 8B encoder answers an English request in Chinese even when the official prompt says not to;
# a hint after the user's text (the last thing it reads) fixes that.
_ENGLISH_HINT = "\n\n(The request above is not in Chinese: write the descriptive prose of your answer in English. Text meant to appear in the image keeps its own language.)"


def compose_request(system_prompt: str, text: str) -> str:
    """System prompt followed by the user's text; official prompts end on the marker ("...:")."""
    system = str(system_prompt or "").strip()
    text = str(text or "").strip()
    joiner = "\n" if system.endswith(":") else "\n\nUser request:\n"
    return system + joiner + text + ("" if _CJK.search(text) else _ENGLISH_HINT)


def extract_prompt(generated: Any) -> str:
    """The rewritten prompt from a generation: plain text, or the field of a JSON answer."""
    text = str(generated or "").strip()
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1].strip()
    elif "<think>" in text:
        return ""
    text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    if text.startswith("{"):
        text = _json_prompt(text)
    if len(text) > 1 and text[0] == text[-1] and text[0] in "\"'" and text.count(text[0]) == 2:
        text = text[1:-1].strip()
    return re.sub(r"\s*\n\s*", " ", text).strip()


def _json_prompt(text: str) -> str:
    try:
        parsed, _end = json.JSONDecoder().raw_decode(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        for key, value in parsed.items():
            if str(key).lower() in _JSON_KEYS and isinstance(value, str):
                return value.strip()
        return ""
    match = _JSON_FIELD.search(text)  # a truncated answer still carries the prompt
    if not match:
        return ""
    try:
        return json.loads(f'"{match.group(1)}"').strip()
    except json.JSONDecodeError:
        return match.group(1).strip()


def _fit(image: Image.Image, budget: int) -> Image.Image:
    """``image`` shrunk to at most ``budget`` pixels (never upscaled), aspect kept, sides in IMAGE_STEP steps."""
    image = image.convert("RGB")
    scale = min(1.0, (budget / (image.width * image.height)) ** 0.5)
    size = tuple(max(IMAGE_STEP, round(side * scale / IMAGE_STEP) * IMAGE_STEP) for side in image.size)
    return image if size == image.size else image.resize(size, Image.Resampling.LANCZOS)


def fit_images(images: list[Image.Image]) -> list[Image.Image]:
    """The canvas (first) and its references, each at its own aspect ratio within the pixel budgets."""
    canvas = _fit(images[0], CANVAS_PIXELS)
    references = images[1:]
    if not references:
        return [canvas]
    share = (TOTAL_PIXELS - canvas.width * canvas.height) // len(references)
    budget = min(REFERENCE_PIXELS, max(MIN_REFERENCE_PIXELS, share))
    return [canvas, *(_fit(image, budget) for image in references)]


def reference_images(settings: dict[str, Any]) -> list[Image.Image]:
    """The Edit model reference pictures uploaded in the widget (data URLs)."""
    refs = settings.get("edit_reference_images")
    if not isinstance(refs, list):
        return []
    return [_decode_data_url(item, "RGB") for item in refs if isinstance(item, str) and item][:MAX_REFERENCES]


def edit_images(canvas: Image.Image | None, settings: dict[str, Any]) -> list[Image.Image] | None:
    """The pictures an edit-style prompt is written for: the canvas first, then the references.

    UniCanvas numbers the canvas as picture 1 and the references from 2 on, so the references only
    make sense next to a canvas. An empty canvas (which an edit model would draw as a black picture)
    is ignored: the request is a text-to-image one, with no pictures at all.
    """
    if canvas is None:
        return None
    return [canvas, *reference_images(settings)]


def _download_default_clip() -> None:
    """Fetch the default encoder from Hugging Face into the first models/text_encoders folder."""
    import folder_paths
    from huggingface_hub import hf_hub_download

    folders = _safe_get_folder_paths(folder_paths, "text_encoders")
    if not folders:
        raise RuntimeError("no ComfyUI text_encoders folder is configured")
    try:
        cached = hf_hub_download(repo_id=DEFAULT_ENHANCE_CLIP_REPO, filename=DEFAULT_ENHANCE_CLIP_PATH, token=False)
        target = os.path.join(folders[0], DEFAULT_ENHANCE_CLIP)
        if os.path.abspath(cached) != os.path.abspath(target):
            shutil.copyfile(cached, target)
    except Exception as exc:
        raise RuntimeError(f"[VNCCS UniCanvas] Prompt enhance text encoder download failed: {exc}") from exc


def resolve_enhance_clip_name(requested: Any = None) -> str:
    """The installed encoder file to use; the default one is downloaded when it is missing."""
    name = str(requested or "").strip() or DEFAULT_ENHANCE_CLIP
    if name in _safe_filename_list("text_encoders"):
        return name
    if name != DEFAULT_ENHANCE_CLIP:
        raise ValueError(f"The prompt enhance text encoder '{name}' is not in models/text_encoders.")
    with _CLIP_LOCK:
        if DEFAULT_ENHANCE_CLIP not in _safe_filename_list("text_encoders"):
            _download_default_clip()
    return name


def is_enhance_encoder(settings: dict[str, Any], name: str) -> bool:
    """Whether the family's own CLIP is the very file (and loader type) enhancement wants."""
    return (
        os.path.basename(str(settings.get("clip_name") or "")) == os.path.basename(name)
        and str(settings.get("clip_type") or "").lower() == ENHANCE_CLIP_TYPE
    )


def load_enhance_clip(name: str) -> Any:
    """A freshly loaded Qwen3-VL encoder; the caller frees it with ``release_enhance_clip``."""
    clip = _call_loader_node(["CLIPLoader"], ["load_clip"], clip_name=name, model_name=name, type=ENHANCE_CLIP_TYPE)
    if clip is None:
        raise RuntimeError(f"Failed to load the prompt enhance text encoder '{name}'.")
    return clip


def release_enhance_clip(clip: Any) -> None:
    """Unload a dedicated encoder from VRAM and RAM right away (it is not the draw's own CLIP)."""
    try:
        import gc

        import comfy.model_management as model_management

        patcher = getattr(clip, "patcher", None)
        for loaded in list(model_management.current_loaded_models):
            if loaded.model is patcher:
                loaded.model_unload()
                model_management.current_loaded_models.remove(loaded)
        del clip, patcher
        model_management.cleanup_models()
        gc.collect()
        model_management.soft_empty_cache()
    except Exception as exc:  # freeing is best effort: ComfyUI still evicts it under memory pressure
        logging.getLogger(__name__).warning("[VNCCS UniCanvas] Could not release the prompt enhance encoder: %s", exc)


def _release_generation_state() -> None:
    """What ComfyUI's executor does after every node when DynamicVRAM is on.

    A node run outside the executor skips it, and the leftover prefetch queues / cast buffers make the
    next generation on the same encoder trip a CUDA scatter/gather assert, which aborts the process.
    """
    try:
        import comfy.memory_management

        if not comfy.memory_management.aimdo_enabled:
            return
        import comfy.model_management
        import comfy.model_prefetch
        import comfy_aimdo.model_vbar

        comfy.model_prefetch.cleanup_prefetch_queues()
        comfy.model_management.reset_cast_buffers()
        comfy_aimdo.model_vbar.vbars_reset_watermark_limits()
    except Exception:
        pass  # older ComfyUI without DynamicVRAM: nothing to release


def enhance_text(clip: Any, text: str, system_prompt: str, images: list[Image.Image] | None = None) -> str:
    """Rewrite ``text``; "" when the encoder produced nothing usable. Caller holds the model lock.

    ``images`` are the canvas and its references; each keeps its own size, so this tokenizes and
    generates directly (the TextGenerate node only takes one same-size batch).
    """
    _ensure_direct_sampling_prompt_context()
    kwargs: dict[str, Any] = {}
    if images:
        kwargs["images"] = [_pil_to_image_tensor(image) for image in fit_images(images)]
    try:
        tokens = clip.tokenize(compose_request(system_prompt, text), skip_template=False, min_length=1, thinking=False, **kwargs)
        generated_ids = clip.generate(
            tokens,
            do_sample=True,
            max_length=MAX_NEW_TOKENS,
            seed=random.randrange(2**32),
            mtp=True,
            **_SAMPLING,
        )
        generated = clip.decode(generated_ids)
    finally:
        _release_generation_state()
    return extract_prompt(generated)


def apply_auto_enhance(request: Any, draw_clip: Any, source: Image.Image | None) -> None:
    """Rewrite ``request.positive_text`` / ``negative_text`` in place before they are encoded.

    Always runs on the CLIP of the family that draws (``draw_clip``) - no encoder of its own, so it
    costs no extra VRAM. ``source`` is the canvas picture, None when it is empty (a text-to-image
    draw). A failure (a CLIP that cannot generate) keeps the original prompts: enhancement must
    never cost a generation.
    """
    config = request.settings.get("prompt_enhance")
    if request.external or draw_clip is None or not isinstance(config, dict):
        return
    images = edit_images(source, request.settings)
    systems = {
        "positive_text": (config.get("edit_system") if images else None) or config.get("positive_system"),
        "negative_text": config.get("negative_system"),
    }
    _set_draw_progress(request.draw_id, "conditioning", 0.18, 0, request.steps, "Enhancing prompt")
    for field, system in systems.items():
        original = str(getattr(request, field) or "").strip()
        if not original or not str(system or "").strip():
            continue
        try:
            enhanced = enhance_text(draw_clip, original, str(system), images if field == "positive_text" else None)
        except Exception as exc:
            _uc_log(request.draw_id, "prompt enhance failed", {"field": field, "error": str(exc) or type(exc).__name__})
            continue
        if enhanced:
            setattr(request, field, enhanced)
            _uc_log(request.draw_id, "prompt enhanced", {"field": field, "before": len(original), "after": len(enhanced)})
