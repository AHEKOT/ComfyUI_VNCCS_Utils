"""Pose Studio per-character outputs: character_json and character_passes.

For each captured image the browser widget uploads the full Character ID pass and,
per visible character, a solo render with every other character hidden
(web/pose_studio/character_passes.mjs): its view-space normal and its packed
24-bit view depth. This module validates them and builds

* ``character_json``: one JSON string per captured image describing the exported
  characters (slots, Character ID colours, z order, bounds, depth range);
* ``character_passes``: one IMAGE batch per exported character, in the order of
  ``character_json`` (images first, then ascending slot), holding
  ``CHARACTER_PASS_ORDER`` at the full capture size.

Crops, masks and the final depth normalization are done by VNCCS Character Export
(nodes/posestudio/character_export.py). It never imports torch.
"""
import base64
import math
from io import BytesIO

import numpy as np
from PIL import Image

from .conditioning import POSE_CHARACTER_ID_COLORS

# Appended after the crop guide outputs; never reorder.
POSE_CHARACTER_OUTPUTS = ("character_json", "character_passes")
# Frames of every character_passes item.
CHARACTER_PASS_ORDER = ("normal_solo", "depth_solo", "silhouette")
CHARACTER_SET_SCHEMA_VERSION = 1
CHARACTER_SET_TYPE = "vnccs_character_set"
# Same levels as the full depth pass (POSE_DEPTH_FAR_LEVEL in the widget).
POSE_DEPTH_NEAR_LEVEL = 255
POSE_DEPTH_FAR_LEVEL = 32
CHARACTER_BACKGROUND = {"normal": [0, 0, 0], "depth": 0}
_DEPTH_UNITS = 16777215

_MAX_PASS_BYTES = 32 * 1024 * 1024
_MAX_TOTAL_CHARS = 64 * 1024 * 1024


def requested_character_outputs(export):
    """Linked character outputs recorded by the widget in ``export.character_outputs``."""
    names = export.get("character_outputs") if isinstance(export, dict) else None
    if not isinstance(names, list):
        return ()
    requested = {name for name in names if isinstance(name, str)}
    return tuple(name for name in POSE_CHARACTER_OUTPUTS if name in requested)


def character_id_color(slot):
    """``#rrggbb`` Character ID colour of a slot (slot 0 = ID 1 = red)."""
    if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < len(POSE_CHARACTER_ID_COLORS):
        raise ValueError(f"character slot must be 0..{len(POSE_CHARACTER_ID_COLORS) - 1}, got {slot!r}")
    return "#%02x%02x%02x" % POSE_CHARACTER_ID_COLORS[slot]


def _decode_png(value, width, height, label):
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty PNG data URL")
    if "," in value:
        value = value.split(",", 1)[1]
    raw = base64.b64decode(value)
    if len(raw) > _MAX_PASS_BYTES:
        raise ValueError(f"{label} is too large")
    with Image.open(BytesIO(raw)) as image:
        if image.format != "PNG" or image.size != (width, height):
            raise ValueError(f"{label} must be a {width} x {height} PNG matching its RGB capture")
        return np.array(image.convert("RGB"))


def mask_bbox(mask):
    """Inclusive-exclusive pixel bounds of a boolean mask, or None when it is empty."""
    rows, cols = np.any(mask, axis=1), np.any(mask, axis=0)
    if not rows.any():
        return None
    y0, y1 = np.flatnonzero(rows)[[0, -1]]
    x0, x1 = np.flatnonzero(cols)[[0, -1]]
    return {"x": int(x0), "y": int(y0), "width": int(x1 - x0 + 1), "height": int(y1 - y0 + 1)}


def decode_character_captures(items, sizes):
    """Decode ``captured_characters``: one entry per RGB capture, ``sizes`` are the RGB (width, height)."""
    if not isinstance(items, list) or len(items) != len(sizes):
        raise ValueError("character passes must contain one entry per RGB capture")
    palette = np.array([(0, 0, 0), *POSE_CHARACTER_ID_COLORS], dtype=np.uint8)
    total_chars = 0
    decoded = []
    for item, (width, height) in zip(items, sizes):
        if not isinstance(item, dict) or not isinstance(item.get("characters"), list):
            raise ValueError("character pass entry must be an object with a characters list")
        clip_far = item.get("clip_far")
        if isinstance(clip_far, bool) or not isinstance(clip_far, (int, float)) \
                or not math.isfinite(clip_far) or clip_far <= 0:
            raise ValueError(f"character pass clip_far must be a positive number, got {clip_far!r}")
        values = [item.get("character_id")]
        for character in item["characters"]:
            if not isinstance(character, dict):
                raise ValueError("character pass characters must be objects")
            values += [character.get("normal"), character.get("depth")]
        total_chars += sum(len(value) for value in values if isinstance(value, str))
        if total_chars > _MAX_TOTAL_CHARS:
            raise ValueError("character pass payload is too large")
        ids = _decode_png(item.get("character_id"), width, height, "character_id pass")
        known = (ids[:, :, None, :] == palette[None, None, :, :]).all(axis=-1).any(axis=-1)
        if not known.all():
            raise ValueError("character_id pass contains colours outside the Character ID palette")
        characters, slots = [], set()
        for character in item["characters"]:
            slot = character.get("slot")
            character_id_color(slot)
            if slot in slots:
                raise ValueError(f"character slot {slot} appears twice in one capture")
            slots.add(slot)
            packed = _decode_png(character.get("depth"), width, height, "character depth pass").astype(np.uint32)
            depth = (packed[:, :, 0] << 16) | (packed[:, :, 1] << 8) | packed[:, :, 2]
            normal = _decode_png(character.get("normal"), width, height, "character normal pass")
            characters.append({"slot": slot, "depth": depth, "normal": normal})
        pose_index = item.get("pose_index")
        if isinstance(pose_index, bool) or not isinstance(pose_index, int):
            pose_index = None
        pose_name = item.get("pose_name")
        decoded.append({
            "ids": ids,
            "clip_far": float(clip_far),
            "pose_index": pose_index,
            "pose_name": pose_name if isinstance(pose_name, str) else "",
            "characters": sorted(characters, key=lambda character: character["slot"]),
        })
    return decoded


def scene_depth_levels(depth, coverage, near, far):
    """Float gray levels (0..1) of packed depth: ``near`` -> 255, ``far`` -> 32, background 0.

    The values are not quantized so VNCCS Character Export can renormalize them
    per character without banding.
    """
    levels = np.zeros(depth.shape, dtype=np.float32)
    if far > near:
        span = (POSE_DEPTH_NEAR_LEVEL - POSE_DEPTH_FAR_LEVEL) / (far - near)
        values = POSE_DEPTH_NEAR_LEVEL - (depth[coverage].astype(np.float64) - near) * span
    else:
        values = np.full(int(coverage.sum()), POSE_DEPTH_NEAR_LEVEL, dtype=np.float64)
    levels[coverage] = (values / 255.0).astype(np.float32)
    return levels


def _camera_depth(value, clip_far):
    return None if value is None else round(float(value) * clip_far / _DEPTH_UNITS, 6)


def build_character_sets(decoded, sizes):
    """character_json records and character_passes frames for decoded captures.

    Returns ``(records, passes)``: one record (dict) per capture and one
    ``(normal, depth, silhouette)`` tuple of float32 HxWx3 arrays per exported
    character, in list order. A character is exported when its solo render covers
    at least one pixel; one fully hidden behind others is still exported.
    """
    records, passes = [], []
    for capture, (width, height) in zip(decoded, sizes):
        ids, clip_far = capture["ids"], capture["clip_far"]
        exported = []
        for character in capture["characters"]:
            coverage = character["depth"] > 0
            if not coverage.any():
                continue
            visible = np.all(ids == np.array(POSE_CHARACTER_ID_COLORS[character["slot"]], dtype=np.uint8), axis=-1)
            exported.append((character, coverage, visible))
        if exported:
            near = min(int(character["depth"][coverage].min()) for character, coverage, _ in exported)
            far = max(int(character["depth"][coverage].max()) for character, coverage, _ in exported)
        else:
            near = far = None

        # z order: median view depth of the visible pixels, nearest first; fully
        # occluded characters follow, ordered by the median of their whole body.
        def order_key(entry):
            character, coverage, visible = entry
            seen = visible & coverage
            if seen.any():
                return (0, float(np.median(character["depth"][seen])), character["slot"])
            return (1, float(np.median(character["depth"][coverage])), character["slot"])

        z_order = {entry[0]["slot"]: rank for rank, entry in enumerate(sorted(exported, key=order_key))}
        characters = []
        for character, coverage, visible in exported:
            seen = visible & coverage
            slot = character["slot"]
            body = character["depth"][coverage]
            normal = character["normal"].copy()
            normal[~coverage] = 0
            depth = scene_depth_levels(character["depth"], coverage, near, far)
            silhouette = coverage.astype(np.float32)
            passes.append((
                normal.astype(np.float32) / 255.0,
                np.repeat(depth[:, :, None], 3, axis=2),
                np.repeat(silhouette[:, :, None], 3, axis=2),
            ))
            characters.append({
                "slot": slot,
                "id_value": slot + 1,
                "id_color": character_id_color(slot),
                "list_index": len(passes) - 1,
                "z_order": z_order[slot],
                "bbox_full": mask_bbox(coverage),
                "bbox_visible": mask_bbox(seen),
                "pixels_full": int(coverage.sum()),
                "pixels_visible": int(seen.sum()),
                "depth": {
                    "near": _camera_depth(body.min(), clip_far),
                    "far": _camera_depth(body.max(), clip_far),
                    "visible_median": _camera_depth(np.median(character["depth"][seen]) if seen.any() else None,
                                                    clip_far),
                },
            })
        records.append({
            "schema_version": CHARACTER_SET_SCHEMA_VERSION,
            "type": CHARACTER_SET_TYPE,
            "pose_index": capture["pose_index"],
            "pose_name": capture["pose_name"],
            "source": {"width": width, "height": height},
            "passes": list(CHARACTER_PASS_ORDER),
            "background": dict(CHARACTER_BACKGROUND),
            "depth": {
                "normalization": "scene",
                "near_level": POSE_DEPTH_NEAR_LEVEL,
                "far_level": POSE_DEPTH_FAR_LEVEL,
                "near": _camera_depth(near, clip_far),
                "far": _camera_depth(far, clip_far),
            },
            "characters": characters,
        })
    return records, passes


def unavailable_character_set(width, height, reason, pose_index=None):
    """Placeholder record for runs that did not render character passes."""
    return {
        "schema_version": CHARACTER_SET_SCHEMA_VERSION,
        "type": CHARACTER_SET_TYPE,
        "pose_index": pose_index,
        "source": {"width": width, "height": height},
        "characters": [],
        "unavailable": reason,
    }
