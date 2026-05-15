"""Auto-mask fallback using BiRefNet lite.

Used when the ComfyUI node graph does not provide a MASK input.
The model snapshot is stored under <ComfyUI>/models/birefnet/BiRefNet_lite.
"""

import os
import threading

import cv2
import numpy as np
from PIL import Image

import folder_paths

_MODEL_REPO = "ZhengPeng7/BiRefNet_lite"
_MODEL_DIR = os.path.join(folder_paths.models_dir, "birefnet", "BiRefNet_lite")
_MODEL_LOCK = threading.Lock()
_MODEL = None
_DEVICE = None


def _ensure_snapshot():
    os.makedirs(_MODEL_DIR, exist_ok=True)
    if os.path.isfile(os.path.join(_MODEL_DIR, "config.json")):
        return _MODEL_DIR

    from huggingface_hub import snapshot_download

    print(f"[SAM3DBody] BiRefNet lite not found. Downloading to {_MODEL_DIR} ...")
    snapshot_download(repo_id=_MODEL_REPO, local_dir=_MODEL_DIR)
    if not os.path.isfile(os.path.join(_MODEL_DIR, "config.json")):
        raise RuntimeError(f"[SAM3DBody] BiRefNet download completed but config.json is missing under {_MODEL_DIR}")
    print("[SAM3DBody] BiRefNet lite download complete.")
    return _MODEL_DIR


def _load_model():
    global _MODEL, _DEVICE
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL, _DEVICE or "cpu"

        import torch
        from transformers import AutoModelForImageSegmentation

        torch.set_float32_matmul_precision("high")
        model_dir = _ensure_snapshot()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[SAM3DBody] Loading BiRefNet lite from {model_dir} on {device}")
        model = AutoModelForImageSegmentation.from_pretrained(
            model_dir,
            trust_remote_code=True,
            local_files_only=True,
        )
        model.to(device)
        model.eval()
        if device == "cuda":
            model.half()

        _MODEL = model
        _DEVICE = device
        return model, device


def _bbox_from_mask(mask_2d):
    rows = np.any(mask_2d > 0, axis=1)
    cols = np.any(mask_2d > 0, axis=0)
    if not rows.any() or not cols.any():
        return None
    rmin, rmax = np.where(rows)[0][[0, -1]]
    cmin, cmax = np.where(cols)[0][[0, -1]]
    return np.array([[cmin, rmin, cmax, rmax]], dtype=np.float32)


def _largest_component(mask_2d):
    num, labels, stats, _ = cv2.connectedComponentsWithStats(mask_2d.astype(np.uint8), connectivity=8)
    if num <= 1:
        return mask_2d.astype(np.uint8)
    best = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return (labels == best).astype(np.uint8)


def auto_mask_bgr(img_bgr, confidence_threshold=0.5):
    import torch
    from torchvision import transforms

    if img_bgr is None or img_bgr.size == 0:
        raise RuntimeError("[SAM3DBody] BiRefNet received an empty image")

    model, device = _load_model()
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    pil_image = Image.fromarray(rgb)
    width, height = pil_image.size

    tfm = transforms.Compose([
        transforms.Resize((1024, 1024)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    input_tensor = tfm(pil_image).unsqueeze(0).to(device)
    if device == "cuda":
        input_tensor = input_tensor.half()

    with torch.no_grad():
        pred = model(input_tensor)[-1].sigmoid().float().cpu().numpy()[0, 0]

    mask_img = Image.fromarray(np.clip(pred * 255.0, 0.0, 255.0).astype(np.uint8), mode="L")
    score_map = np.asarray(mask_img.resize((width, height), Image.BILINEAR), dtype=np.float32) / 255.0
    mask = (score_map >= float(confidence_threshold)).astype(np.uint8)
    if not mask.any():
        raise RuntimeError("[SAM3DBody] BiRefNet produced an empty mask")
    mask = _largest_component(mask)
    bbox = _bbox_from_mask(mask)
    if bbox is None:
        raise RuntimeError("[SAM3DBody] BiRefNet mask bbox is empty")
    return mask.astype(np.uint8), bbox
