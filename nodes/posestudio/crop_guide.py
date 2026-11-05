"""Pose Studio crop guide: normalized framing rectangles and their pixel crops.

The browser widget stores one rectangle per static pose tab in post-projection
image space (normalized 0..1, origin top-left, +x right, +y down, no rotation,
fully inside the image). This module mirrors web/pose_studio/crop_guide.mjs so
the same JSON and image size always produce the same pixel rectangle, and does
the pure image work for the crop outputs.
It never imports torch: tensors are only sliced and cloned through their methods.
"""
import math

CROP_GUIDE_SCHEMA_VERSION = 1
CROP_GUIDE_PIXEL_EPSILON = 1e-6
# The Crop Guide group of Settings > Additional Outputs.
POSE_CROP_GUIDE_OUTPUTS = ("crop_json", "crop_image", "crop_preview")
CROP_GUIDE_ASPECT_RATIOS = {
    "free": None, "1:1": 1.0, "4:3": 4 / 3, "3:4": 3 / 4,
    "16:9": 16 / 9, "9:16": 9 / 16, "custom": None,
}
# Relative difference of width/height ratios that still counts as a pure resize.
# Guide border in crop_preview (matches the editor overlay colour).
CROP_PREVIEW_COLOR = (0.0, 0.85, 1.0)
CROP_PREVIEW_DIM = 0.45


def default_crop_guide():
    return {
        "schema_version": CROP_GUIDE_SCHEMA_VERSION,
        "enabled": False,
        "x": 0.1,
        "y": 0.1,
        "width": 0.8,
        "height": 0.8,
        "aspect_ratio": "free",
        "custom_aspect_ratio": [1, 1],
        "aspect_ratio_locked": False,
    }


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def _clamp(value, low, high):
    return min(max(value, low), high)


def normalize_crop_guide(value):
    """Lenient normalization of editor/workflow data; garbage loads as a disabled default guide."""
    guide = default_crop_guide()
    if not isinstance(value, dict):
        return guide
    x, y = _finite(value.get("x")), _finite(value.get("y"))
    width, height = _finite(value.get("width")), _finite(value.get("height"))
    rect_valid = None not in (x, y, width, height) and width > 0 and height > 0
    if rect_valid:
        guide["width"] = min(width, 1)
        guide["height"] = min(height, 1)
        guide["x"] = _clamp(x, 0, 1 - guide["width"])
        guide["y"] = _clamp(y, 0, 1 - guide["height"])
    guide["enabled"] = value.get("enabled") is True and rect_valid
    aspect = value.get("aspect_ratio")
    if isinstance(aspect, str) and aspect in CROP_GUIDE_ASPECT_RATIOS:
        guide["aspect_ratio"] = aspect
    custom = value.get("custom_aspect_ratio")
    if isinstance(custom, list) and len(custom) == 2:
        cw, ch = _finite(custom[0]), _finite(custom[1])
        if cw is not None and ch is not None and cw > 0 and ch > 0:
            guide["custom_aspect_ratio"] = [cw, ch]
    guide["aspect_ratio_locked"] = guide["aspect_ratio"] != "free" or value.get("aspect_ratio_locked") is True
    return guide


def crop_guide_preset_ratio(guide):
    if guide.get("aspect_ratio") == "custom":
        cw, ch = guide.get("custom_aspect_ratio") or [1, 1]
        return cw / ch
    return CROP_GUIDE_ASPECT_RATIOS.get(guide.get("aspect_ratio"))


def _snap_pixel(value):
    nearest = round(value)
    return nearest if abs(value - nearest) <= CROP_GUIDE_PIXEL_EPSILON else value


def crop_pixel_rect(rect, width, height):
    """Normalized rect -> integer pixel rect: left/top floor, right/bottom ceil (exclusive), clamped, >= 1 px."""
    if isinstance(width, bool) or isinstance(height, bool) or not isinstance(width, int) \
            or not isinstance(height, int) or width < 1 or height < 1:
        raise ValueError(f"crop guide image size must be positive integers, got {width} x {height}")
    left = _clamp(math.floor(_snap_pixel(rect["x"] * width)), 0, width - 1)
    top = _clamp(math.floor(_snap_pixel(rect["y"] * height)), 0, height - 1)
    right = _clamp(math.ceil(_snap_pixel((rect["x"] + rect["width"]) * width)), left + 1, width)
    bottom = _clamp(math.ceil(_snap_pixel((rect["y"] + rect["height"]) * height)), top + 1, height)
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


def build_crop_json(guide, width, height, pose_index=0):
    """The crop_json record of one output image (mirrors buildCropJson in the widget)."""
    normalized = normalize_crop_guide(guide)
    rect = {key: normalized[key] for key in ("x", "y", "width", "height")}
    record = {
        "schema_version": CROP_GUIDE_SCHEMA_VERSION,
        "type": "vnccs_crop_guide",
        "enabled": normalized["enabled"],
        "coordinate_system": "top_left_normalized",
        "source": {"width": width, "height": height},
        "rect": rect,
        "pixel_rect": crop_pixel_rect(rect, width, height),
        "aspect_ratio": normalized["aspect_ratio"],
        "aspect_ratio_value": crop_guide_preset_ratio(normalized),
        "aspect_ratio_locked": normalized["aspect_ratio_locked"],
        "pose_index": pose_index,
    }
    if normalized["aspect_ratio"] == "custom":
        record["custom_aspect_ratio"] = list(normalized["custom_aspect_ratio"])
    return record


def crop_guide_unsupported_reason(export, editor_mode, output_mode):
    """Modes whose images are not the Studio capture frame the guide was drawn on."""
    if editor_mode == "animation":
        return "Animation mode"
    if isinstance(export, dict) and export.get("interface_mode") == "manager":
        return "Pose Manager"
    if output_mode != "LIST":
        return "GRID output"
    return None


def capture_crop_guides(data, count):
    """One (guide, pose_index) per captured image, in capture order.

    The widget sends ``captured_crop_guides`` aligned with ``captured_images``
    (Debug Mode captures carry the library pose's guide). Older payloads fall
    back to the per-tab ``crop_guides``; anything else is disabled.
    """
    captured = data.get("captured_crop_guides") if isinstance(data, dict) else None
    if isinstance(captured, list) and len(captured) == count:
        result = []
        for index, item in enumerate(captured):
            pose_index = item.get("pose_index") if isinstance(item, dict) else None
            if isinstance(pose_index, bool) or not isinstance(pose_index, int):
                pose_index = None
            result.append((item, pose_index))
        return result
    per_tab = data.get("crop_guides") if isinstance(data, dict) else None
    export = data.get("export") if isinstance(data, dict) else None
    debug = isinstance(export, dict) and export.get("debugMode") is True
    if isinstance(per_tab, list) and len(per_tab) == count and not debug:
        return [(item, index) for index, item in enumerate(per_tab)]
    return [(None, index) for index in range(count)]


def crop_image(image, pixel_rect):
    """Copy of the crop of an IMAGE tensor [B, H, W, C]; the source pixels are never modified."""
    x, y = pixel_rect["x"], pixel_rect["y"]
    return image[:, y:y + pixel_rect["height"], x:x + pixel_rect["width"], :].clone()


def draw_crop_preview(image, pixel_rect):
    """Copy of an IMAGE tensor [B, H, W, C] with the outside dimmed and the guide border drawn inside the crop."""
    preview = image.clone()
    height, width = image.shape[1], image.shape[2]
    x, y, w, h = pixel_rect["x"], pixel_rect["y"], pixel_rect["width"], pixel_rect["height"]
    preview.mul_(CROP_PREVIEW_DIM)
    preview[:, y:y + h, x:x + w, :] = image[:, y:y + h, x:x + w, :]
    thickness = max(1, min(round(min(width, height) / 256), max(1, min(w, h) // 4)))
    color = preview.new_tensor(CROP_PREVIEW_COLOR)
    channels = min(3, preview.shape[3])
    color = color[:channels]
    preview[:, y:y + thickness, x:x + w, :channels] = color
    preview[:, y + h - thickness:y + h, x:x + w, :channels] = color
    preview[:, y:y + h, x:x + thickness, :channels] = color
    preview[:, y:y + h, x + w - thickness:x + w, :channels] = color
    return preview
