"""SAM / SAM2 / SAM 3 click segmentation for the selection tools and Remove background."""

from __future__ import annotations

import inspect
from typing import Any

import numpy as np
import torch
from PIL import Image

from .comfy_bridge import find_loaded_module, import_loaded_submodule
from .helper_models import ensure_helper_model_file
from .imaging import _decode_data_url, _encode_png_data_url
from .locks import _COMFY_MODEL_OP_LOCK, _MODEL_CACHE_LOCK


_SAM_CACHE: dict[str, tuple[Any, Any, Any]] = {}

SAM_MODEL_IDS = {
    "sam2_large": "facebook/sam2.1-hiera-large",
    "sam1_huge": "facebook/sam-vit-huge",
}


SAM3_KEY = "sam3"
SAM3_FALLBACK_NOTE = (
    "SAM 3 code not found (install comfyui-easy-sam3 or another node that ships the sam3 package); "
    "used SAM2 Large instead."
)


def _torch_device() -> torch.device:
    try:
        import comfy.model_management as model_management

        device = model_management.get_torch_device()
    except Exception:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if getattr(device, "type", None) not in {"cpu", "cuda"}:
        device = torch.device("cpu")
    return device


def _sam3_code() -> tuple[Any, Any] | None:
    """SAM 3 builder and processor from an installed custom node that ships the sam3 package.

    The weights are ours to fetch (public mirror, see helper_models); the model code is not
    vendored here, so SAM 3 runs only when such a node (e.g. comfyui-easy-sam3) is loaded.
    """
    builder = find_loaded_module(
        lambda name, module: name.endswith(".model_builder") and callable(getattr(module, "build_sam3_image_model", None))
    )
    if builder is None:
        return None
    root = builder.__name__.rsplit(".", 1)[0]
    processor_module = import_loaded_submodule(f"{root}.model.sam3_image_processor")
    processor_cls = getattr(processor_module, "Sam3Processor", None)
    if processor_cls is None:
        return None
    return builder.build_sam3_image_model, processor_cls


def _load_sam3_model() -> tuple[Any, Any]:
    with _MODEL_CACHE_LOCK:
        cached = _SAM_CACHE.get(SAM3_KEY)
        if cached is not None:
            return cached[0], cached[1]
    code = _sam3_code()
    if code is None:
        raise RuntimeError(SAM3_FALLBACK_NOTE)
    build_model, processor_cls = code
    checkpoint = ensure_helper_model_file("sam3")
    device = _torch_device()
    model = build_model(
        device=device.type,
        eval_mode=True,
        checkpoint_path=checkpoint,
        load_from_HF=False,
        enable_segmentation=True,
        enable_inst_interactivity=False,
        compile=False,
    )
    processor = processor_cls(model=model, resolution=1008, device=device.type, confidence_threshold=0.3)
    with _MODEL_CACHE_LOCK:
        _SAM_CACHE[SAM3_KEY] = (model, processor, device)
    return model, processor


def _sam3_mask(image: Image.Image, points: list[list[float]], labels: list[int]) -> Image.Image:
    """Union of the SAM 3 instances grounded by the points (1 = keep, 0 = remove)."""
    width, height = image.size
    _model, processor = _load_sam3_model()
    normalized = [[x / max(1, width), y / max(1, height)] for x, y in points]
    with torch.inference_mode():
        state = processor.set_image(image)
        state = processor.add_point_prompt(normalized, labels, state)
    masks = state.get("masks")
    if masks is None or len(masks) == 0:
        raise RuntimeError("SAM 3 found no object at the keep points")
    masks = torch.as_tensor(masks).detach().float().cpu()
    while masks.ndim > 3:
        masks = masks.flatten(0, 1)
    union = (masks > 0.5).any(dim=0) if masks.ndim == 3 else masks > 0.5
    mask_image = Image.fromarray(union.numpy().astype(np.uint8) * 255, mode="L")
    if mask_image.size != image.size:
        mask_image = mask_image.resize(image.size, Image.Resampling.NEAREST)
    return mask_image


def _load_sam_model(model_key: str) -> tuple[Any, Any, Any]:
    key = model_key if model_key in SAM_MODEL_IDS else "sam2_large"
    with _MODEL_CACHE_LOCK:
        cached = _SAM_CACHE.get(key)
        if cached is not None:
            return cached

    model_id = SAM_MODEL_IDS[key]
    if key == "sam1_huge":
        from transformers.models.sam import SamModel
        from transformers.models.sam.processing_sam import SamProcessor

        model = SamModel.from_pretrained(model_id)
        processor = SamProcessor.from_pretrained(model_id)
    else:
        from transformers.models.sam2 import Sam2Model
        from transformers.models.sam2.processing_sam2 import Sam2Processor

        model = Sam2Model.from_pretrained(model_id)
        processor = Sam2Processor.from_pretrained(model_id)

    device = _torch_device()
    model.to(device)
    model.eval()
    cached = (model, processor, device)
    with _MODEL_CACHE_LOCK:
        _SAM_CACHE[key] = cached
    return cached


def _largest_sam_mask(mask_batch: Any) -> torch.Tensor:
    masks = mask_batch[0] if isinstance(mask_batch, (list, tuple)) else mask_batch
    if isinstance(masks, np.ndarray):
        masks = torch.from_numpy(masks)
    masks = masks.detach().cpu()
    while masks.ndim > 3:
        masks = masks[0]
    if masks.ndim == 2:
        return masks > 0
    if masks.ndim != 3:
        raise RuntimeError(f"Unexpected SAM mask shape: {tuple(masks.shape)}")
    binary = masks > 0
    areas = binary.flatten(1).sum(dim=1)
    if not int(areas.max().item()):
        return binary[0]
    return binary[int(torch.argmax(areas).item())]


def _feature_value(features: Any, key: str) -> Any:
    try:
        if isinstance(features, dict):
            return features.get(key)
        data = getattr(features, "data", None)
        if isinstance(data, dict):
            return data.get(key)
        return getattr(features, key, None)
    except Exception:
        return None


def _to_cpu_tensor(value: Any) -> Any:
    return value.detach().cpu() if hasattr(value, "detach") else value


def _post_process_sam_masks(processor: Any, pred_masks: torch.Tensor, inputs: Any) -> Any:
    original_sizes = _to_cpu_tensor(_feature_value(inputs, "original_sizes"))
    reshaped_input_sizes = _to_cpu_tensor(_feature_value(inputs, "reshaped_input_sizes"))
    if original_sizes is None:
        raise RuntimeError("SAM processor returned no original image sizes")

    kwargs = {"masks": pred_masks.detach().cpu(), "original_sizes": original_sizes}
    signature = inspect.signature(processor.post_process_masks)
    if "reshaped_input_sizes" in signature.parameters:
        kwargs["reshaped_input_sizes"] = reshaped_input_sizes if reshaped_input_sizes is not None else original_sizes
    return processor.post_process_masks(**kwargs)


def _run_unicanvas_segment(payload: dict[str, Any]) -> dict[str, Any]:
    model_key = str(payload.get("model") or "sam2_large")
    note = ""
    if model_key == SAM3_KEY and _sam3_code() is None:
        model_key, note = "sam2_large", SAM3_FALLBACK_NOTE
    model_key = model_key if model_key in SAM_MODEL_IDS or model_key == SAM3_KEY else "sam2_large"
    points_payload = payload.get("points") or []
    if not isinstance(points_payload, list) or not points_payload:
        raise ValueError("SAM needs at least one point")

    image_rgba = _decode_data_url(str(payload.get("image") or ""), "RGBA")
    image = Image.new("RGB", image_rgba.size, (255, 255, 255))
    image.paste(image_rgba, mask=image_rgba.getchannel("A"))
    width, height = image.size

    points: list[list[float]] = []
    labels: list[int] = []
    for item in points_payload:
        if not isinstance(item, dict):
            continue
        x = float(item.get("x", -1))
        y = float(item.get("y", -1))
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        label = 0 if int(item.get("label", 1)) <= 0 else 1
        points.append([x, y])
        labels.append(label)
    if not points:
        raise ValueError("SAM points are outside the layer crop")

    if model_key == SAM3_KEY:
        with _COMFY_MODEL_OP_LOCK:
            mask_image = _sam3_mask(image, points, labels)
        return _mask_result(mask_image, image, model_key, note)

    with _COMFY_MODEL_OP_LOCK:
        model, processor, device = _load_sam_model(model_key)
        if model_key == "sam1_huge":
            processor_points = [points]
            processor_labels = [labels]
        else:
            processor_points = [[points]]
            processor_labels = [[labels]]
        inputs = processor(
            images=image,
            input_points=processor_points,
            input_labels=processor_labels,
            return_tensors="pt",
        )
        if hasattr(inputs, "to"):
            inputs = inputs.to(device)
        else:
            inputs = {key: value.to(device) if hasattr(value, "to") else value for key, value in inputs.items()}

        with torch.inference_mode():
            outputs = model(**inputs)

    pred_masks = getattr(outputs, "pred_masks", None)
    if pred_masks is None:
        raise RuntimeError("SAM returned no masks")
    masks = _post_process_sam_masks(processor, pred_masks, inputs)
    mask = _largest_sam_mask(masks)
    mask_np = (mask.numpy().astype(np.uint8) * 255)
    mask_image = Image.fromarray(mask_np, mode="L")
    if mask_image.size != image.size:
        mask_image = mask_image.resize(image.size, Image.Resampling.NEAREST)
    return _mask_result(mask_image, image, model_key, note)


def _mask_result(mask_image: Image.Image, image: Image.Image, model_key: str, note: str = "") -> dict[str, Any]:
    rgba_mask = Image.new("RGBA", image.size, (255, 255, 255, 0))
    rgba_mask.putalpha(mask_image)
    result = {
        "status": "ok",
        "model": model_key,
        "mask": _encode_png_data_url(rgba_mask),
        "width": image.width,
        "height": image.height,
    }
    if note:
        result["note"] = note
    return result
