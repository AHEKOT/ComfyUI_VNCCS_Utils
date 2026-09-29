"""CPU compositor that flattens a UniCanvas state (blend modes, opacity, crops) to RGBA."""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from typing import Any

import numpy as np
import torch
from PIL import Image

from .constants import _MAX_PANORAMA_PIXELS, _MAX_PIXELS
from .imaging import _decode_data_url, _pil_rgba_to_image_tensor
from .state import _load_unicanvas_state, _read_unicanvas_state_cache


def _number(value: Any, default: float) -> float:
    try:
        result = float(value)
        if math.isfinite(result):
            return result
    except Exception:
        pass
    return default


def _rect_from_state(value: Any, default: dict[str, float]) -> dict[str, float]:
    data = value if isinstance(value, dict) else {}
    return {
        "x": _number(data.get("x"), default["x"]),
        "y": _number(data.get("y"), default["y"]),
        "width": max(1.0, _number(data.get("width"), default["width"])),
        "height": max(1.0, _number(data.get("height"), default["height"])),
    }


def _apply_layer_opacity(image: Image.Image, opacity: float) -> Image.Image:
    opacity = max(0.0, min(1.0, opacity))
    if opacity >= 0.999:
        return image
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A").point(lambda value: int(round(value * opacity)))
    rgba.putalpha(alpha)
    return rgba


def _blend_luminosity(color: np.ndarray) -> np.ndarray:
    return color[..., 0] * 0.3 + color[..., 1] * 0.59 + color[..., 2] * 0.11


def _blend_saturation(color: np.ndarray) -> np.ndarray:
    return np.max(color, axis=-1) - np.min(color, axis=-1)


def _blend_clip_color(color: np.ndarray) -> np.ndarray:
    result = color.copy()
    luminosity = _blend_luminosity(result)[..., None]
    minimum = np.min(result, axis=-1, keepdims=True)
    maximum = np.max(result, axis=-1, keepdims=True)

    low = minimum < 0.0
    low_scale = np.divide(
        luminosity,
        luminosity - minimum,
        out=np.zeros_like(luminosity),
        where=np.abs(luminosity - minimum) > 1e-7,
    )
    result = np.where(low, luminosity + (result - luminosity) * low_scale, result)

    high = maximum > 1.0
    high_scale = np.divide(
        1.0 - luminosity,
        maximum - luminosity,
        out=np.zeros_like(luminosity),
        where=np.abs(maximum - luminosity) > 1e-7,
    )
    result = np.where(high, luminosity + (result - luminosity) * high_scale, result)
    return np.clip(result, 0.0, 1.0)


def _blend_set_luminosity(color: np.ndarray, luminosity: np.ndarray) -> np.ndarray:
    return _blend_clip_color(color + (luminosity - _blend_luminosity(color))[..., None])


def _blend_set_saturation(color: np.ndarray, saturation: np.ndarray) -> np.ndarray:
    order = np.argsort(color, axis=-1)
    sorted_color = np.take_along_axis(color, order, axis=-1)
    minimum = sorted_color[..., 0]
    middle = sorted_color[..., 1]
    maximum = sorted_color[..., 2]
    span = maximum - minimum
    adjusted_middle = np.divide(
        (middle - minimum) * saturation,
        span,
        out=np.zeros_like(middle),
        where=span > 1e-7,
    )
    adjusted_maximum = np.where(span > 1e-7, saturation, 0.0)
    adjusted_sorted = np.stack(
        (np.zeros_like(adjusted_middle), adjusted_middle, adjusted_maximum),
        axis=-1,
    )
    result = np.empty_like(color)
    np.put_along_axis(result, order, adjusted_sorted, axis=-1)
    return result


def _blend_normal(backdrop: np.ndarray, source: np.ndarray) -> np.ndarray:
    return source


def _blend_overlay(backdrop: np.ndarray, source: np.ndarray) -> np.ndarray:
    return np.where(
        backdrop <= 0.5,
        2.0 * backdrop * source,
        1.0 - 2.0 * (1.0 - backdrop) * (1.0 - source),
    )


def _blend_color_dodge(backdrop: np.ndarray, source: np.ndarray) -> np.ndarray:
    return np.where(
        source >= 1.0 - 1e-7,
        1.0,
        np.minimum(1.0, backdrop / np.maximum(1.0 - source, 1e-7)),
    )


def _blend_color_burn(backdrop: np.ndarray, source: np.ndarray) -> np.ndarray:
    return np.where(
        source <= 1e-7,
        0.0,
        1.0 - np.minimum(1.0, (1.0 - backdrop) / np.maximum(source, 1e-7)),
    )


def _blend_hard_light(backdrop: np.ndarray, source: np.ndarray) -> np.ndarray:
    return np.where(
        source <= 0.5,
        2.0 * backdrop * source,
        1.0 - 2.0 * (1.0 - backdrop) * (1.0 - source),
    )


def _blend_soft_light(backdrop: np.ndarray, source: np.ndarray) -> np.ndarray:
    soft_curve = np.where(
        backdrop <= 0.25,
        ((16.0 * backdrop - 12.0) * backdrop + 4.0) * backdrop,
        np.sqrt(np.maximum(backdrop, 0.0)),
    )
    return np.where(
        source <= 0.5,
        backdrop - (1.0 - 2.0 * source) * backdrop * (1.0 - backdrop),
        backdrop + (2.0 * source - 1.0) * (soft_curve - backdrop),
    )


def _blend_hue(backdrop: np.ndarray, source: np.ndarray) -> np.ndarray:
    adjusted = _blend_set_saturation(source, _blend_saturation(backdrop))
    return _blend_set_luminosity(adjusted, _blend_luminosity(backdrop))


def _blend_saturation_mode(backdrop: np.ndarray, source: np.ndarray) -> np.ndarray:
    adjusted = _blend_set_saturation(backdrop, _blend_saturation(source))
    return _blend_set_luminosity(adjusted, _blend_luminosity(backdrop))


# Canvas 2D globalCompositeOperation name -> separable/non-separable blend function
# (backdrop, source) -> blended RGB, all float arrays in 0..1.
BlendFunction = Callable[[np.ndarray, np.ndarray], np.ndarray]
BLEND_MODES: dict[str, BlendFunction] = {
    "source-over": _blend_normal,
    "normal": _blend_normal,
    "multiply": lambda backdrop, source: backdrop * source,
    "screen": lambda backdrop, source: backdrop + source - backdrop * source,
    "overlay": _blend_overlay,
    "darken": np.minimum,
    "lighten": np.maximum,
    "color-dodge": _blend_color_dodge,
    "color-burn": _blend_color_burn,
    "hard-light": _blend_hard_light,
    "soft-light": _blend_soft_light,
    "difference": lambda backdrop, source: np.abs(backdrop - source),
    "exclusion": lambda backdrop, source: backdrop + source - 2.0 * backdrop * source,
    "hue": _blend_hue,
    "saturation": _blend_saturation_mode,
    "color": lambda backdrop, source: _blend_set_luminosity(source, _blend_luminosity(backdrop)),
    "luminosity": lambda backdrop, source: _blend_set_luminosity(backdrop, _blend_luminosity(source)),
}
# Kept for callers that only test membership; the registry is the source of truth.
_UNICANVAS_BLEND_MODES = BLEND_MODES


def register_blend_mode(name: str, blend: BlendFunction) -> None:
    """Add a layer blend mode (the name the widget stores in ``layer.blendMode``)."""
    BLEND_MODES[str(name).lower()] = blend


def _blend_rgb(backdrop: np.ndarray, source: np.ndarray, mode: str) -> np.ndarray:
    return BLEND_MODES.get(mode, _blend_normal)(backdrop, source)


def _alpha_composite_with_blend(backdrop: Image.Image, source: Image.Image, mode: str) -> Image.Image:
    mode = str(mode or "source-over").lower()
    if mode not in BLEND_MODES or mode in {"source-over", "normal"}:
        return Image.alpha_composite(backdrop.convert("RGBA"), source.convert("RGBA"))

    backdrop = backdrop.convert("RGBA")
    source = source.convert("RGBA")
    result = backdrop.copy()
    width, height = backdrop.size
    for top in range(0, height, 256):
        bottom = min(height, top + 256)
        box = (0, top, width, bottom)
        backdrop_values = np.asarray(backdrop.crop(box), dtype=np.float32) / 255.0
        source_values = np.asarray(source.crop(box), dtype=np.float32) / 255.0
        backdrop_rgb = backdrop_values[..., :3]
        source_rgb = source_values[..., :3]
        backdrop_alpha = backdrop_values[..., 3:4]
        source_alpha = source_values[..., 3:4]
        blended_rgb = np.clip(_blend_rgb(backdrop_rgb, source_rgb, mode), 0.0, 1.0)
        output_alpha = source_alpha + backdrop_alpha * (1.0 - source_alpha)
        output_premultiplied = (
            source_alpha * (1.0 - backdrop_alpha) * source_rgb
            + source_alpha * backdrop_alpha * blended_rgb
            + (1.0 - source_alpha) * backdrop_alpha * backdrop_rgb
        )
        output_rgb = np.divide(
            output_premultiplied,
            output_alpha,
            out=np.zeros_like(output_premultiplied),
            where=output_alpha > 1e-7,
        )
        output = np.concatenate((output_rgb, output_alpha), axis=-1)
        output_image = Image.fromarray(np.round(np.clip(output, 0.0, 1.0) * 255.0).astype(np.uint8), "RGBA")
        result.paste(output_image, (0, top))
    return result


class FlatDocument:
    """A normal canvas document: the bbox crops the layers, which may sit anywhere."""

    pixel_limit = _MAX_PIXELS

    def __init__(self, state: dict[str, Any]):
        self.state = state

    def origin(self) -> dict[str, float]:
        return _rect_from_state(self.state.get("origin"), {"x": 0, "y": 0, "width": 1, "height": 1})

    def frame(self) -> dict[str, float]:
        """The output rectangle in document coordinates."""
        return _rect_from_state(self.state.get("bbox"), {"x": 0, "y": 0, "width": 1024, "height": 1024})

    def layers(self) -> list[Any]:
        """Layers bottom-most last, the order the compositor walks in reverse."""
        return self.state.get("layers") or []

    def missing_pixels(self, layer: dict[str, Any]) -> None:
        """A visible layer has no stored pixels; flat documents skip it."""

    def check_layer(self, crop: tuple[int, int, int, int], size: tuple[int, int]) -> None:
        """Validate a layer's crop rectangle against the output size."""

    def check_image(self, image: Image.Image, size: tuple[int, int]) -> None:
        """Validate a decoded layer image against the output size."""


class EquirectangularPanorama(FlatDocument):
    """A 360 panorama: layers hold spherical edits in full equirectangular coordinates.

    The perspective bbox and camera never crop the node output, every layer covers
    the whole document, and the base layer always stays at the bottom.
    """

    pixel_limit = _MAX_PANORAMA_PIXELS
    max_side = 8192

    def __init__(self, state: dict[str, Any]):
        super().__init__(state)
        self.panorama = state["panorama"]
        try:
            self.width, self.height = int(self.panorama["width"]), int(self.panorama["height"])
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise ValueError("Invalid panorama dimensions") from exc
        if not (
            0 < self.width <= self.max_side
            and 0 < self.height <= self.max_side
            and self.width * self.height <= self.pixel_limit
        ):
            raise ValueError("UniCanvas panorama dimensions are too large or invalid")

    def origin(self) -> dict[str, float]:
        return {"x": 0, "y": 0, "width": 1, "height": 1}

    def frame(self) -> dict[str, float]:
        return {"x": 0, "y": 0, "width": self.width, "height": self.height}

    def layers(self) -> list[Any]:
        layers = super().layers()
        base_id = self.panorama.get("baseLayerId")
        if not any(isinstance(layer, dict) and layer.get("id") == base_id and layer.get("type") == "raster" for layer in layers):
            raise ValueError("The panorama base layer is missing")
        return sorted(layers, key=lambda layer: isinstance(layer, dict) and layer.get("id") == base_id)

    def missing_pixels(self, layer: dict[str, Any]) -> None:
        raise ValueError("Panorama layer pixels are missing")

    def check_layer(self, crop: tuple[int, int, int, int], size: tuple[int, int]) -> None:
        if crop != (0, 0, *size):
            raise ValueError("Panorama layer dimensions do not match the document")

    def check_image(self, image: Image.Image, size: tuple[int, int]) -> None:
        if image.size != size:
            raise ValueError("Panorama layer dimensions do not match the document")


# state["panorama"]["projection"] -> document class. New projections (cubemap, ...) register here.
PANORAMA_PROJECTIONS: dict[str, type[FlatDocument]] = {"equirectangular": EquirectangularPanorama}


def register_panorama_projection(name: str, document_class: type[FlatDocument]) -> None:
    PANORAMA_PROJECTIONS[str(name)] = document_class


def _document_projection(state: dict[str, Any]) -> FlatDocument:
    panorama = state.get("panorama")
    if panorama is None:
        return FlatDocument(state)
    document_class = PANORAMA_PROJECTIONS.get(panorama.get("projection")) if isinstance(panorama, dict) else None
    if document_class is None:
        raise ValueError("Unsupported UniCanvas panorama projection")
    return document_class(state)


def _flat_output_state(unicanvas_state: str) -> dict[str, Any] | None:
    """The flattened, bbox-cropped output the widget uploads for a panorama (``output_id``), if cached."""
    try:
        state = json.loads(unicanvas_state or "{}")
    except Exception:
        return None
    if not isinstance(state, dict):
        return None
    # The widget names the upload (output_id); a panorama without it still finds the upload by convention.
    output_id = state.get("output_id") or (f"{state['state_id']}_out" if state.get("panorama") and state.get("state_id") else None)
    cached = _read_unicanvas_state_cache(str(output_id)) if output_id else None
    return cached if isinstance(cached, dict) and isinstance(cached.get("layers"), list) else None


def _render_unicanvas_state_to_rgba(unicanvas_state: str) -> Image.Image:
    flat = _flat_output_state(unicanvas_state)
    document = _document_projection(flat if flat is not None else _load_unicanvas_state(unicanvas_state))
    origin = document.origin()
    bbox = document.frame()
    width = max(1, int(round(bbox["width"])))
    height = max(1, int(round(bbox["height"])))
    pixel_limit = document.pixel_limit
    if width * height > pixel_limit:
        raise ValueError("UniCanvas output dimensions are too large")
    bbox_local_x = bbox["x"] - origin["x"]
    bbox_local_y = bbox["y"] - origin["y"]
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    for layer in reversed(document.layers()):
        if not isinstance(layer, dict):
            continue
        if layer.get("type") not in {"raster", "pose"} or layer.get("visible") is False:
            continue
        crop = layer.get("crop")
        data_url = layer.get("dataURL")
        if not isinstance(crop, dict) or not data_url:
            document.missing_pixels(layer)
            continue

        layer_x = int(round(_number(crop.get("x"), 0)))
        layer_y = int(round(_number(crop.get("y"), 0)))
        layer_w = max(1, int(round(_number(crop.get("width"), 1))))
        layer_h = max(1, int(round(_number(crop.get("height"), 1))))
        document.check_layer((layer_x, layer_y, layer_w, layer_h), (width, height))
        dst_x = int(round(layer_x - bbox_local_x))
        dst_y = int(round(layer_y - bbox_local_y))
        inter_left = max(0, dst_x)
        inter_top = max(0, dst_y)
        inter_right = min(width, dst_x + layer_w)
        inter_bottom = min(height, dst_y + layer_h)
        if inter_right <= inter_left or inter_bottom <= inter_top:
            continue

        image = _decode_data_url(str(data_url), "RGBA", max_pixels=pixel_limit)
        document.check_image(image, (width, height))
        src_left = inter_left - dst_x
        src_top = inter_top - dst_y
        src_right = src_left + (inter_right - inter_left)
        src_bottom = src_top + (inter_bottom - inter_top)
        image = image.crop((src_left, src_top, src_right, src_bottom))
        image = _apply_layer_opacity(image, _number(layer.get("opacity"), 1.0))
        blend_mode = str(layer.get("blendMode") or "source-over").lower()
        if blend_mode in {"source-over", "normal"} or blend_mode not in BLEND_MODES:
            out.alpha_composite(image, (inter_left, inter_top))
        else:
            region = out.crop((inter_left, inter_top, inter_right, inter_bottom))
            out.paste(_alpha_composite_with_blend(region, image, blend_mode), (inter_left, inter_top))

    return out


def _render_unicanvas_state_to_image_tensor(unicanvas_state: str) -> torch.Tensor:
    return _pil_rgba_to_image_tensor(_render_unicanvas_state_to_rgba(unicanvas_state))
