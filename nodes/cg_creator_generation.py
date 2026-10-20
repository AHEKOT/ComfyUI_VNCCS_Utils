"""QI2 refinement of a captured CG frame outside the workflow queue."""

from __future__ import annotations

import copy
import re
import threading
from contextlib import contextmanager
from typing import Any


ASSETS = {
    "diffusion_models": "qwen_image_2.1_int8_convrot.safetensors",
    "text_encoders": "qwen3vl_8b_int8_convrot.safetensors",
    "vae": "qwen_image_2.1_vae_bf16.safetensors",
}
TURBO_LORA = "QI2/Viggle/Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors"
DEFAULT_SETTINGS = {
    "prompt": (
        "Complete this rough 3D background render into a finished image. Preserve the camera angle, "
        "perspective, composition, geometry, and lighting. Reconstruct missing details and remove "
        "Gaussian splat artifacts. Do not add people or characters."
    ),
    "aspect": "16:9", "resolution_mp": 2.0,
    "generation": {
        "steps": 25, "cfg": 1.0, "sampler": "euler", "scheduler": "simple", "seed": 0,
        "turbo": False, "prompt_enhance": True, "cache_device": "gpu", "cache_dtype": "int8",
        "lora_stack": [],
    },
}
TEXT_GENERATION = {
    "max_length": 2048,
    "sampling_mode": {"sampling_mode": "on", "temperature": 0.3, "top_k": 64,
                      "top_p": 0.95, "min_p": 0.05, "repetition_penalty": 1.05,
                      "seed": 0, "presence_penalty": 0.0},
    "thinking": False, "use_default_template": True, "mtp": "auto",
}
ASPECTS = ("16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "3:2", "2:3")
_ASSET_CACHE = None
_ACTIVE_LOCK = threading.Lock()
_ACTIVE: dict[str, Any] | None = None


class GenerationCancelled(RuntimeError):
    pass


def _text(value: Any, name: str, limit: int) -> str:
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 and c not in "\n\r\t" for c in value):
        raise ValueError(f"{name} must be text of at most {limit} characters")
    return value.strip()


def _number(value: Any, name: str, low: float, high: float, *, integer: bool = False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    if not low <= value <= high or (integer and int(value) != value):
        raise ValueError(f"{name} must be between {low} and {high}" + (" and an integer" if integer else ""))
    return int(value) if integer else float(value)


def normalize_settings(data: Any) -> dict[str, Any]:
    """Retain only bounded CG refinement settings for the fixed QI2 model stack."""
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ValueError("CG settings must be an object")
    settings = copy.deepcopy(DEFAULT_SETTINGS)
    if "prompt" in data:
        settings["prompt"] = _text(data["prompt"], "CG prompt", 8000) or DEFAULT_SETTINGS["prompt"]
    settings["aspect"] = data.get("aspect", settings["aspect"])
    if settings["aspect"] not in ASPECTS:
        raise ValueError("Unsupported CG aspect ratio")
    if "resolution_mp" in data:
        settings["resolution_mp"] = _number(data["resolution_mp"], "Resolution", 0.05, 16)
    incoming = data.get("generation", {})
    if not isinstance(incoming, dict):
        raise ValueError("CG generation settings must be an object")
    generation = settings["generation"]
    for key, low, high, integer in (("steps", 1, 150, True), ("cfg", 0, 30, False), ("seed", 0, 2**64 - 1, True)):
        if key in incoming:
            generation[key] = _number(incoming[key], key, low, high, integer=integer)
    for key in ("turbo", "prompt_enhance"):
        if key in incoming:
            if not isinstance(incoming[key], bool):
                raise ValueError(f"{key} must be a boolean")
            generation[key] = incoming[key]
    for key in ("sampler", "scheduler"):
        if key in incoming:
            generation[key] = _text(incoming[key], key, 64)
            if not generation[key]:
                raise ValueError(f"{key} must not be empty")
    for key, choices in (("cache_device", ("auto", "gpu", "cpu", "off")),
                         ("cache_dtype", ("default", "int8", "int4"))):
        if key in incoming:
            if incoming[key] not in choices:
                raise ValueError(f"Unsupported {key}")
            generation[key] = incoming[key]
    stack = incoming.get("lora_stack", [])
    if not isinstance(stack, list) or len(stack) > 8:
        raise ValueError("LoRA stack must contain at most eight entries")
    for item in stack:
        if not isinstance(item, dict):
            raise ValueError("LoRA entries must be objects")
        name = _text(item.get("name", ""), "LoRA name", 512).replace("\\", "/")
        if not name or name == "None":
            continue
        if (name.startswith(("/", "~")) or ":" in name
                or any(not part or part.endswith((" ", ".")) for part in name.split("/"))):
            raise ValueError("LoRA name must be a relative installed model name")
        if name.rsplit("/", 1)[-1].casefold() == TURBO_LORA.rsplit("/", 1)[-1].casefold():
            raise ValueError("Use the Turbo switch for the Viggle adapter")
        generation["lora_stack"].append({"name": name, "strength": _number(item.get("strength", 1), "LoRA strength", -10, 10)})
    return settings


def _call_comfy_node(class_name: str, **kwargs):
    from .unicanvas.comfy_bridge import _call_comfy_node as call
    return call(class_name, **kwargs)


def _installed(category: str) -> list[str]:
    try:
        import folder_paths
        return list(folder_paths.get_filename_list(category) or [])
    except (ImportError, AttributeError, KeyError):
        return []


def _asset_name(category: str, name: str) -> str:
    from .unicanvas.paths import _resolve_model_filename
    import folder_paths
    return _resolve_model_filename(folder_paths, category, name)


def configuration() -> dict[str, Any]:
    from .unicanvas.comfy_bridge import _get_node_combo_values
    assets = []
    for category, name in ASSETS.items():
        installed = [entry.replace("\\", "/") for entry in _installed(category)]
        matches = [entry for entry in installed if entry.rsplit("/", 1)[-1].lower() == name.lower()]
        assets.append({"category": category, "name": name, "installed": name in installed or len(matches) == 1})
    return {"settings": copy.deepcopy(DEFAULT_SETTINGS), "model": "Qwen Image 2.1 INT8 ConvRot",
            "assets": assets, "installed": all(asset["installed"] for asset in assets),
            "loras": _installed("loras"), "aspects": list(ASPECTS),
            "samplers": _get_node_combo_values(["KSampler"], "sampler_name") or ["euler"],
            "schedulers": _get_node_combo_values(["KSampler"], "scheduler") or ["simple"]}


def _load_clip():
    return _call_comfy_node("CLIPLoader", clip_name=_asset_name("text_encoders", ASSETS["text_encoders"]),
                            type="qwen_image", device="default")[0]


def _load_assets():
    global _ASSET_CACHE
    key = tuple(_asset_name(category, name) for category, name in ASSETS.items())
    if _ASSET_CACHE is None or _ASSET_CACHE[0] != key:
        model = _call_comfy_node("UNETLoader", unet_name=key[0], weight_dtype="default")[0]
        clip = _load_clip()
        vae = _call_comfy_node("VAELoader", vae_name=key[2])[0]
        _ASSET_CACHE = (key, model, vae)
    else:
        _, model, vae = _ASSET_CACHE
        # Qwen3-VL generation mutates shared CLIP internals; clone() cannot isolate them.
        clip = _load_clip()
    return model.clone(), clip, vae


def _check_cancel(cancel_event) -> None:
    if cancel_event.is_set():
        raise GenerationCancelled("CG generation cancelled")


def _stage(draw_id: str, cancel_event, stage: str, value: float, message: str) -> None:
    from .unicanvas.progress import _set_draw_progress
    _check_cancel(cancel_event)
    _set_draw_progress(draw_id, stage, value, message=message)


def progress(draw_id: str) -> dict[str, Any]:
    from .unicanvas.progress import _get_draw_progress
    return _get_draw_progress(draw_id)


def interrupt(draw_id: str) -> bool:
    """Only signal ComfyUI while this job owns the shared inference slot."""
    from .unicanvas.progress import set_interrupt
    with _ACTIVE_LOCK:
        if _ACTIVE is None or _ACTIVE["draw_id"] != draw_id:
            return False
        _ACTIVE["cancel_event"].set()
        _ACTIVE["interrupted"] = True
        set_interrupt(True)
        return True


@contextmanager
def _model_session(draw_id: str, cancel_event):
    global _ACTIVE
    from .unicanvas.locks import _COMFY_MODEL_OP_LOCK
    from .unicanvas.progress import _set_draw_progress, interrupt_types, set_interrupt
    _check_cancel(cancel_event)
    while not _COMFY_MODEL_OP_LOCK.acquire(timeout=0.25):
        _check_cancel(cancel_event)
    active = {"draw_id": draw_id, "cancel_event": cancel_event, "interrupted": False}
    try:
        with _ACTIVE_LOCK:
            _check_cancel(cancel_event)
            # Match UniCanvas: an earlier workflow Stop must not cancel a new owned request.
            set_interrupt(False)
            _ACTIVE = active
        _check_cancel(cancel_event)
        yield
    except BaseException as exc:
        cancelled = cancel_event.is_set() or isinstance(exc, (GenerationCancelled,) + interrupt_types())
        _set_draw_progress(draw_id, "cancelled" if cancelled else "error", 0, message=str(exc))
        if cancelled and not isinstance(exc, GenerationCancelled):
            raise GenerationCancelled("CG generation cancelled") from exc
        raise
    finally:
        with _ACTIVE_LOCK:
            if _ACTIVE is active:
                if active["interrupted"]:
                    set_interrupt(False)
                _ACTIVE = None
        _COMFY_MODEL_OP_LOCK.release()


def _clean_text(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("QI2 text generation returned no text")
    value = re.sub(r"<think(?:ing)?>.*?</think(?:ing)?>", "", value, flags=re.I | re.S).strip()
    return re.sub(r"^\s*```(?:json|text)?\s*|\s*```\s*$", "", value, flags=re.I).strip()


def _pil_to_tensor(image):
    from .unicanvas.imaging import _pil_to_image_tensor
    return _pil_to_image_tensor(image)


def _tensor_to_pil(tensor):
    from .unicanvas.imaging import _image_tensor_to_pil
    return _image_tensor_to_pil(tensor).convert("RGB")


def generate_image(settings: dict[str, Any], draw_id: str, cancel_event, reference):
    from PIL import Image
    settings = normalize_settings(settings)
    if not isinstance(reference, Image.Image):
        raise ValueError("CG refinement requires a captured frame")
    width, height = reference.size
    if any(value < 64 or value > 4096 or value % 16 for value in (width, height)) or width * height > 16_000_000:
        raise ValueError("Captured frame dimensions must be multiples of 16, between 64 and 4096, and at most 16 MP")
    generation = settings["generation"]
    if generation["turbo"] and (generation["steps"] != 6 or abs(generation["cfg"] - 1) > 1e-6):
        raise ValueError("QI2 Viggle Turbo requires six steps and CFG 1")
    import torch
    from .unicanvas.sampling import (_ensure_direct_sampling_prompt_context,
        _report_comfy_sampling_progress, _suppress_direct_sampling_comfy_progress)
    prompt = settings["prompt"]
    with _model_session(draw_id, cancel_event), torch.inference_mode():
        _ensure_direct_sampling_prompt_context(f"cg_creator_{draw_id}")
        _stage(draw_id, cancel_event, "loading", 0.03, "Loading Qwen Image 2.1")
        model, clip, vae = _load_assets()
        _stage(draw_id, cancel_event, "loading", 0.12, "Applying CG model settings")
        for item in generation["lora_stack"]:
            model, clip = _call_comfy_node("LoraLoader", model=model, clip=clip, lora_name=item["name"],
                                          strength_model=item["strength"], strength_clip=item["strength"])[:2]
            _check_cancel(cancel_event)
        if generation["turbo"]:
            from .unicanvas.models.qwen_image21 import resolve_qwen21_turbo_lora
            from .unicanvas.models.qwen_image21_viggle import apply_viggle_turbo_lora
            model, clip = apply_viggle_turbo_lora(model, clip, resolve_qwen21_turbo_lora(), 1.0)
        model = _call_comfy_node("QwenImage21Cache", model=model, device=generation["cache_device"],
                                 dtype=generation["cache_dtype"])[0]
        if generation["prompt_enhance"]:
            _stage(draw_id, cancel_event, "conditioning", 0.18, "Enhancing the CG prompt")
            enhanced = _clean_text(_call_comfy_node("TextGenerate", clip=clip, prompt=prompt,
                system_prompt=("Rewrite the user's request as one clear English reference-image editing prompt. "
                    "Preserve the exact camera viewpoint, composition, geometry, lighting and all requested edit constraints. "
                    "Complete the rough environment without introducing people or characters. "
                    "Return only the finished prompt, with no analysis or preamble."),
                **copy.deepcopy(TEXT_GENERATION))[0])
            if enhanced:
                prompt = _text(enhanced, "Enhanced prompt", 16000)
        _stage(draw_id, cancel_event, "conditioning", 0.3, "Encoding the captured CG frame")
        encoded = _call_comfy_node("TextEncodeQwenImage21", clip=clip, vae=vae, prompt=prompt,
            negative_prompt="", resolution=0, width=width, height=height,
            images={"image_1": _pil_to_tensor(reference.convert("RGB"))})
        if not isinstance(encoded, (tuple, list)) or len(encoded) < 3 or encoded[2] is None:
            raise RuntimeError("QI2 returned no camera-aligned reference latent; update ComfyUI")
        positive, negative, latent = encoded[:3]
        _stage(draw_id, cancel_event, "sampling", 0.35, "Rendering the CG frame")
        with _suppress_direct_sampling_comfy_progress(), _report_comfy_sampling_progress(draw_id, generation["steps"]):
            if generation["turbo"]:
                from .unicanvas.models.qwen_image21_viggle import viggle_turbo_sigmas
                noise = _call_comfy_node("RandomNoise", noise_seed=generation["seed"])[0]
                guider = _call_comfy_node("BasicGuider", model=model, conditioning=positive)[0]
                sampler = _call_comfy_node("KSamplerSelect", sampler_name="euler")[0]
                samples = _call_comfy_node("SamplerCustomAdvanced", noise=noise, guider=guider,
                    sampler=sampler, sigmas=viggle_turbo_sigmas(latent), latent_image=latent)[0]
            else:
                samples = _call_comfy_node("KSampler", model=model, seed=generation["seed"], steps=generation["steps"],
                    cfg=generation["cfg"], sampler_name=generation["sampler"], scheduler=generation["scheduler"],
                    positive=positive, negative=negative, latent_image=latent, denoise=1.0)[0]
        _stage(draw_id, cancel_event, "decoding", 0.9, "Decoding the CG image")
        image = _tensor_to_pil(_call_comfy_node("VAEDecode", vae=vae, samples=samples)[0])
        if image.size != (width, height):
            raise RuntimeError(f"QI2 returned {image.size[0]}x{image.size[1]}, expected {width}x{height}")
        _stage(draw_id, cancel_event, "complete", 1, "CG image ready")
        return image, {"settings": settings, "prompt": prompt, "width": width, "height": height,
                       "seed": generation["seed"], "model": "qi2"}
