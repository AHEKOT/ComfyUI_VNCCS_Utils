"""VNCCS Character Export: per-character crops from Pose Studio character outputs.

Pure image work on the Pose Studio ``images``, ``character_id``,
``character_json`` and ``character_passes`` outputs (see
nodes/posestudio/character_passes.py). Coordinates are full-image pixels with
(0, 0) at the top-left; a crop pixel is ``full - (crop_rect.x, crop_rect.y)``.
It never imports torch: tensors are only sliced and converted through their methods.
"""
import json

import numpy as np

from .character_passes import (
    CHARACTER_BACKGROUND,
    CHARACTER_PASS_ORDER,
    CHARACTER_SET_SCHEMA_VERSION,
    CHARACTER_SET_TYPE,
    POSE_DEPTH_FAR_LEVEL,
    POSE_DEPTH_NEAR_LEVEL,
    character_id_color,
    mask_bbox,
)
from .conditioning import POSE_CHARACTER_ID_COLORS

CHARACTER_EXPORT_SCHEMA_VERSION = 1
CHARACTER_EXPORT_TYPE = "vnccs_character_export_set"
CHARACTER_EXPORT_KINDS = ("normal_solo", "depth_solo", "character_id", "mask_visible", "mask_full", "rgb")
CHARACTER_EXPORT_ALIGNS = (8, 64)
DEPTH_NORMALIZATIONS = ("scene", "character")


def parse_character_json(value):
    """Strict validation of one Pose Studio character_json value."""
    if isinstance(value, dict):
        record = value
    else:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("character_json is empty. Connect the character_json output of VNCCS Pose Studio.")
        try:
            record = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"character_json is not valid JSON: {exc.msg} (position {exc.pos})") from exc
    if not isinstance(record, dict) or record.get("type") != CHARACTER_SET_TYPE:
        raise ValueError(f"character_json must be a {CHARACTER_SET_TYPE} object from VNCCS Pose Studio")
    version = record.get("schema_version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError(f"character_json needs a positive integer schema_version, got {version!r}")
    if version > CHARACTER_SET_SCHEMA_VERSION:
        raise ValueError(
            f"character_json schema_version {version} is newer than this node supports "
            f"({CHARACTER_SET_SCHEMA_VERSION}); update ComfyUI_VNCCS_Utils"
        )
    if record.get("unavailable"):
        raise ValueError(
            f"character_json has no characters: {record['unavailable']}. Link character_json and "
            "character_passes of VNCCS Pose Studio in Studio, Image mode and LIST output."
        )
    source = record.get("source")
    size = (source.get("width"), source.get("height")) if isinstance(source, dict) else (None, None)
    if any(isinstance(v, bool) or not isinstance(v, int) or v < 1 for v in size):
        raise ValueError(f"character_json source must have positive integer width and height, got {source!r}")
    if list(record.get("passes") or CHARACTER_PASS_ORDER) != list(CHARACTER_PASS_ORDER):
        raise ValueError(f"character_json passes must be {list(CHARACTER_PASS_ORDER)}")
    characters = record.get("characters")
    if not isinstance(characters, list):
        raise ValueError("character_json must contain a characters list")
    for character in characters:
        if not isinstance(character, dict):
            raise ValueError("character_json characters must be objects")
        character_id_color(character.get("slot"))
        for key in ("list_index", "z_order"):
            number = character.get(key)
            if isinstance(number, bool) or not isinstance(number, int) or number < 0:
                raise ValueError(f"character_json character {key} must be a non-negative integer, got {number!r}")
    return record


def character_crop_rect(bbox, width, height, margin, align):
    """Crop rectangle of a full-body bbox.

    1. Expand the bbox by ``margin`` on every side.
    2. Grow width and height to multiples of ``align``, centred on the expanded box.
    3. Shift the rectangle inward to fit the frame; only when an aligned side is
       larger than the frame is that axis clamped to the whole frame.
    """
    if isinstance(margin, bool) or not isinstance(margin, int) or margin < 0:
        raise ValueError(f"margin must be a non-negative integer, got {margin!r}")
    if align not in CHARACTER_EXPORT_ALIGNS:
        raise ValueError(f"align must be one of {CHARACTER_EXPORT_ALIGNS}, got {align!r}")

    def axis(start, length, size):
        low, high = start - margin, start + length + margin
        span = high - low
        aligned = -(-span // align) * align
        low -= (aligned - span) // 2
        if aligned > size:
            return 0, size
        low = min(max(low, 0), size - aligned)
        return low, aligned

    x, w = axis(bbox["x"], bbox["width"], width)
    y, h = axis(bbox["y"], bbox["height"], height)
    return {"x": int(x), "y": int(y), "width": int(w), "height": int(h)}


def normalize_character_depth(levels, mask, mode):
    """8-bit depth (as 0..1 floats) of one character from the scene-normalized float levels.

    ``scene`` keeps the character_passes scale (nearest surface of any character
    255, farthest 32). ``character`` stretches the same 255..32 over this
    character's own full body. Background is 0.
    """
    if mode not in DEPTH_NORMALIZATIONS:
        raise ValueError(f"depth_normalization must be scene or character, got {mode!r}")
    values = levels.astype(np.float64) * 255.0
    output = np.zeros(levels.shape, dtype=np.float32)
    if not mask.any():
        return output
    body = values[mask]
    if mode == "character":
        nearest, farthest = body.max(), body.min()
        if nearest > farthest:
            body = POSE_DEPTH_NEAR_LEVEL - (nearest - body) / (nearest - farthest) * (
                POSE_DEPTH_NEAR_LEVEL - POSE_DEPTH_FAR_LEVEL)
        else:
            body = np.full(body.shape, POSE_DEPTH_NEAR_LEVEL, dtype=np.float64)
    output[mask] = (np.clip(np.round(body), 1, 255) / 255.0).astype(np.float32)
    return output


def _as_array(tensor, label):
    if getattr(tensor, "ndim", None) != 4:
        raise ValueError(f"{label} must be an IMAGE tensor shaped [batch, height, width, channels]")
    return tensor.detach().cpu().numpy() if hasattr(tensor, "detach") else np.asarray(tensor)


def _per_record(items, count, label):
    """One single-image array per character_json, from N items or one batch of N."""
    items = list(items or [])
    if len(items) == count and all(int(item.shape[0]) == 1 for item in items):
        return [_as_array(item, label)[0] for item in items]
    if len(items) == 1 and int(items[0].shape[0]) == count:
        batch = _as_array(items[0], label)
        return [batch[index] for index in range(count)]
    batch = ", ".join(str(int(item.shape[0])) for item in items)
    raise ValueError(
        f"Character Export received {len(items)} {label} item(s) (batch sizes {batch}) for {count} "
        f"character_json values. Connect {label} from the same VNCCS Pose Studio run."
    )


def export_characters(images, character_ids, records, character_passes, margin=64, align=8,
                      depth_normalization="scene"):
    """Per-kind lists of HxWx3 float32 crops and one meta dict per record.

    ``images`` and ``character_ids`` give one image per record; ``character_passes``
    is one [3, H, W, 3] array per exported character in character_json order.
    """
    if depth_normalization not in DEPTH_NORMALIZATIONS:
        raise ValueError(f"depth_normalization must be scene or character, got {depth_normalization!r}")
    expected = sum(len(record["characters"]) for record in records)
    if len(character_passes) != expected:
        raise ValueError(
            f"Character Export received {len(character_passes)} character_passes item(s) for {expected} "
            "characters in character_json. Connect both from the same VNCCS Pose Studio run."
        )
    outputs = {kind: [] for kind in CHARACTER_EXPORT_KINDS}
    metas = []
    for image, ids_image, record in zip(images, character_ids, records):
        width, height = record["source"]["width"], record["source"]["height"]
        for label, array in (("images", image), ("character_id", ids_image)):
            if array.shape[:2] != (height, width):
                raise ValueError(
                    f"{label} is {array.shape[1]} x {array.shape[0]} but character_json was made for "
                    f"{width} x {height}; connect the uncropped Pose Studio output"
                )
        ids = np.round(ids_image[:, :, :3] * 255).astype(np.uint8)
        characters = []
        for character in record["characters"]:
            list_index = len(outputs["rgb"])
            if character["list_index"] != list_index:
                raise ValueError(
                    f"character_json list_index {character['list_index']} does not match position {list_index}; "
                    "connect character_json and character_passes from the same run"
                )
            frames = character_passes[list_index]
            if frames.shape[0] != len(CHARACTER_PASS_ORDER) or frames.shape[1:3] != (height, width):
                raise ValueError(
                    f"character_passes item {list_index} must hold {len(CHARACTER_PASS_ORDER)} frames of "
                    f"{width} x {height} ({', '.join(CHARACTER_PASS_ORDER)})"
                )
            slot = character["slot"]
            mask_full = frames[2, :, :, 0] > 0.5
            mask_visible = np.all(ids == np.array(POSE_CHARACTER_ID_COLORS[slot], dtype=np.uint8), axis=-1)
            bbox_full = mask_bbox(mask_full)
            if bbox_full is None:
                raise ValueError(f"character_passes item {list_index} has an empty silhouette")
            bbox_visible = mask_bbox(mask_visible)
            rect = character_crop_rect(bbox_full, width, height, margin, align)
            ys = slice(rect["y"], rect["y"] + rect["height"])
            xs = slice(rect["x"], rect["x"] + rect["width"])
            depth = normalize_character_depth(frames[1, :, :, 0], mask_full, depth_normalization)
            outputs["normal_solo"].append(frames[0, ys, xs, :3].copy())
            outputs["depth_solo"].append(np.repeat(depth[ys, xs, None], 3, axis=2))
            outputs["character_id"].append(ids_image[ys, xs, :3].copy())
            outputs["mask_visible"].append(np.repeat(mask_visible[ys, xs, None], 3, axis=2).astype(np.float32))
            outputs["mask_full"].append(np.repeat(mask_full[ys, xs, None], 3, axis=2).astype(np.float32))
            outputs["rgb"].append(image[ys, xs, :].copy())
            full_pixels = int(mask_full.sum())
            characters.append({
                "slot": slot,
                "id_value": slot + 1,
                "id_color": character_id_color(slot),
                "list_index": list_index,
                "z_order": character["z_order"],
                "crop_rect": rect,
                "bbox_full": bbox_full,
                "bbox_visible": bbox_visible,
                "visible_ratio": round(int((mask_visible & mask_full).sum()) / full_pixels, 4),
            })
        metas.append({
            "schema_version": CHARACTER_EXPORT_SCHEMA_VERSION,
            "type": CHARACTER_EXPORT_TYPE,
            "pose_index": record.get("pose_index"),
            "pose_name": record.get("pose_name", ""),
            "source": {"width": width, "height": height},
            "background": {"normal": list(CHARACTER_BACKGROUND["normal"]), "depth": CHARACTER_BACKGROUND["depth"]},
            "depth_normalization": depth_normalization,
            "characters": characters,
        })
    return outputs, metas


def export_character_lists(images, character_id, character_json, character_passes, margin=64, align=8,
                           depth_normalization="scene"):
    """Node entry: ComfyUI lists in, numpy per-kind lists and meta JSON strings out."""
    records = [parse_character_json(value) for value in (character_json or [])]
    if not records:
        raise ValueError("Character Export received no character_json")
    image_arrays = _per_record(images, len(records), "images")
    id_arrays = _per_record(character_id, len(records), "character_id")
    passes = [_as_array(item, "character_passes") for item in (character_passes or [])]
    outputs, metas = export_characters(image_arrays, id_arrays, records, passes, margin, align, depth_normalization)
    return outputs, [json.dumps(meta) for meta in metas]
