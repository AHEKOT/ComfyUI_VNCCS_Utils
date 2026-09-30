"""Content-based layer names from a small local vision model.

Backs ``POST /vnccs/unicanvas/describe_layers`` ``{ layers: [{ id, image }], model? }`` ->
``{ names: [{ id, name }] }``. Models (Apache-2.0, downloaded on first use into ``models/LLM/``,
one kept loaded): Qwen3-VL-2B-Instruct (default, ~4 GB, recognises what it sees) and
SmolVLM-256M-Instruct (~500 MB, fast but vague). A name is 1-5 words in Title Case; an
answer that does not look like a name yields ``name: null`` so the layer keeps its current name.
"""

from __future__ import annotations

import re
import threading
from typing import Any

from PIL import Image

from .helper_models import ensure_helper_model
from .imaging import _decode_data_url
from .locks import _COMFY_MODEL_OP_LOCK


SMOLVLM_KEY = "smolvlm_256m"
QWEN3VL_KEY = "qwen3vl_2b"
NAMING_MODELS = (QWEN3VL_KEY, SMOLVLM_KEY)
DEFAULT_NAMING_MODEL = QWEN3VL_KEY
MAX_LAYERS_PER_REQUEST = 16
NAME_PROMPT = (
    "Give this picture a short layer name of 1 to 4 words describing its main subject, "
    "like 'Blonde Woman' or 'Night Street'. Answer with the name only."
)
_THUMBNAIL_SIZE = 384
_MODEL_LOCK = threading.Lock()
_MODEL: dict[str, Any] = {}


def naming_model_key(value: Any) -> str:
    key = str(value or "").strip().lower()
    return key if key in NAMING_MODELS else DEFAULT_NAMING_MODEL


def _load_model(key: str = DEFAULT_NAMING_MODEL) -> tuple[Any, Any, Any]:
    with _MODEL_LOCK:
        cached = _MODEL.get(key)
        if cached is not None:
            return cached
        _MODEL.clear()  # one naming model at a time
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        root = ensure_helper_model(key)
        try:
            import comfy.model_management as model_management

            device = model_management.get_torch_device()
        except Exception:
            device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if getattr(device, "type", None) not in {"cpu", "cuda"}:
            device = torch.device("cpu")
        dtype = torch.float16 if device.type == "cuda" else torch.float32
        if key == QWEN3VL_KEY and device.type == "cuda":
            dtype = torch.bfloat16
        processor = AutoProcessor.from_pretrained(root, local_files_only=True)
        model = AutoModelForImageTextToText.from_pretrained(root, torch_dtype=dtype, local_files_only=True).to(device).eval()
        _MODEL[key] = (model, processor, device)
        return _MODEL[key]


def layer_thumbnail(image: Image.Image) -> Image.Image:
    """The layer's pixels on neutral gray, alpha-cropped and fitted into 384 px."""
    rgba = image.convert("RGBA")
    bbox = rgba.getchannel("A").getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    rgba.thumbnail((_THUMBNAIL_SIZE, _THUMBNAIL_SIZE), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", rgba.size, (128, 128, 128))
    canvas.paste(rgba, mask=rgba.getchannel("A"))
    return canvas


_TRAILING_STOPWORDS = {"a", "an", "the", "in", "on", "of", "with", "and", "at", "by", "for", "to"}


def clean_layer_name(text: Any) -> str | None:
    """A model answer as a layer name, or None when it is not one."""
    line = str(text or "").strip().splitlines()[0] if str(text or "").strip() else ""
    line = re.sub(r"^(assistant|name|layer name)\s*:\s*", "", line, flags=re.IGNORECASE)
    line = re.sub(r"[\"'`*_#.:;!?()\[\]{}]", "", line).strip()
    words = [word for word in re.split(r"\s+", line) if word]
    if not words or len(words) > 6:
        return None
    if words[0].lower() in {"a", "an", "the"} and len(words) > 1:
        words = words[1:]
    words = words[:5]
    # Never end a name on a dangling function word ("Blonde Woman In A").
    while len(words) > 1 and words[-1].lower() in _TRAILING_STOPWORDS:
        words.pop()
    name = " ".join(word[:1].upper() + word[1:] for word in words)
    return name[:40] or None


def _describe(image: Image.Image, key: str = DEFAULT_NAMING_MODEL) -> str | None:
    import torch

    model, processor, device = _load_model(key)
    messages = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": NAME_PROMPT}]}]
    prompt = processor.apply_chat_template(messages, add_generation_prompt=True)
    inputs = processor(text=prompt, images=[layer_thumbnail(image)], return_tensors="pt").to(device)
    if "pixel_values" in inputs and device.type == "cuda":
        inputs["pixel_values"] = inputs["pixel_values"].to(model.dtype)
    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=12, do_sample=False)
    answer = processor.batch_decode(generated[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
    return clean_layer_name(answer)


def _run_unicanvas_describe_layers(payload: dict[str, Any]) -> dict[str, Any]:
    items = (payload or {}).get("layers")
    if not isinstance(items, list) or not items:
        raise ValueError("[VNCCS UniCanvas] describe_layers needs a non-empty 'layers' list.")
    key = naming_model_key((payload or {}).get("model"))
    names = []
    with _COMFY_MODEL_OP_LOCK:
        for item in items[:MAX_LAYERS_PER_REQUEST]:
            if not isinstance(item, dict) or not item.get("id") or not item.get("image"):
                continue
            image = _decode_data_url(str(item["image"]), "RGBA")
            names.append({"id": str(item["id"]), "name": _describe(image, key)})
    return {"names": names, "model": key}
