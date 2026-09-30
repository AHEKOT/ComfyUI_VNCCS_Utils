"""Opt-in UniCanvas debug logging and tensor/latent/conditioning summaries."""

from __future__ import annotations

import json
from typing import Any

import torch


# Switched at runtime by the "Debug mode" UniCanvas setting (POST /vnccs/unicanvas/debug and
# every draw payload); read it through debug_enabled(), never import the value.
UNICANVAS_DEBUG = 0


def set_unicanvas_debug(enabled: Any) -> bool:
    global UNICANVAS_DEBUG
    UNICANVAS_DEBUG = 1 if enabled else 0
    return bool(UNICANVAS_DEBUG)


def debug_enabled() -> bool:
    return bool(UNICANVAS_DEBUG)


def debug_event(topic: str, message: str, data: dict[str, Any] | None = None) -> None:
    """One structured debug line for a non-draw operation (remove bg, SAM, naming, ...)."""
    _uc_log(topic, message, data)


def _uc_log(draw_id: str, message: str, data: dict[str, Any] | None = None) -> None:
    if not UNICANVAS_DEBUG:
        return
    if data is None:
        print(f"[VNCCS UniCanvas][draw:{draw_id}] {message}", flush=True)
        return
    try:
        payload = json.dumps(data, ensure_ascii=False, default=str, sort_keys=True)
    except Exception:
        payload = str(data)
    print(f"[VNCCS UniCanvas][draw:{draw_id}] {message}: {payload}", flush=True)


def _tensor_debug(value: Any) -> dict[str, Any]:
    if not UNICANVAS_DEBUG:
        return {}
    if value is None:
        return {"present": False}
    if not torch.is_tensor(value):
        return {"present": True, "type": type(value).__name__}
    tensor = value.detach().float().cpu()
    stats: dict[str, Any] = {
        "present": True,
        "shape": list(value.shape),
        "dtype": str(value.dtype),
        "device": str(value.device),
        "min": float(tensor.min().item()) if tensor.numel() else None,
        "max": float(tensor.max().item()) if tensor.numel() else None,
        "mean": float(tensor.mean().item()) if tensor.numel() else None,
        "sum": float(tensor.sum().item()) if tensor.numel() else None,
        "nonzero_gt_0_01": int((tensor > 0.01).sum().item()) if tensor.numel() else 0,
        "nonzero_gt_0_5": int((tensor > 0.5).sum().item()) if tensor.numel() else 0,
    }
    if tensor.numel() and tensor.ndim >= 2:
        plane = tensor
        if tensor.ndim == 4 and tensor.shape[-1] in (1, 3, 4):
            plane = tensor[0].amax(dim=-1)
        elif tensor.ndim == 4 and tensor.shape[1] in (1, 3, 4, 16):
            plane = tensor[0].amax(dim=0)
            while plane.ndim > 2:
                plane = plane[0]
        else:
            while plane.ndim > 2:
                plane = plane[0]
        points = torch.nonzero(plane > 0.01, as_tuple=False)
        if points.numel():
            y_min = int(points[:, 0].min().item())
            y_max = int(points[:, 0].max().item())
            x_min = int(points[:, 1].min().item())
            x_max = int(points[:, 1].max().item())
            active_bbox = {"x": x_min, "y": y_min, "width": x_max - x_min + 1, "height": y_max - y_min + 1}
            stats["active_bbox_gt_0_01"] = active_bbox
            stats["bbox_gt_0_01"] = active_bbox
    return stats


def _latent_debug(latent: Any) -> dict[str, Any]:
    if not UNICANVAS_DEBUG:
        return {}
    if not isinstance(latent, dict):
        return {"type": type(latent).__name__, "is_dict": False}
    return {
        "type": type(latent).__name__,
        "is_dict": True,
        "keys": sorted(str(key) for key in latent.keys()),
        "samples": _tensor_debug(latent.get("samples")),
        "noise_mask": _tensor_debug(latent.get("noise_mask")),
    }


def _conditioning_debug(conditioning: Any) -> dict[str, Any]:
    if not UNICANVAS_DEBUG:
        return {}
    if not isinstance(conditioning, list):
        return {"type": type(conditioning).__name__, "is_list": False}
    entries = []
    for item in conditioning[:2]:
        entry: dict[str, Any] = {"type": type(item).__name__}
        if isinstance(item, (list, tuple)) and item:
            entry["conditioning"] = _tensor_debug(item[0])
        if isinstance(item, (list, tuple)) and len(item) > 1 and isinstance(item[1], dict):
            metadata = item[1]
            entry["keys"] = sorted(str(key) for key in metadata.keys())
            for key in ("attention_mask", "concat_latent_image", "concat_mask", "pooled_output"):
                if key in metadata:
                    entry[key] = _tensor_debug(metadata.get(key))
        entries.append(entry)
    return {"type": type(conditioning).__name__, "is_list": True, "count": len(conditioning), "entries": entries}
