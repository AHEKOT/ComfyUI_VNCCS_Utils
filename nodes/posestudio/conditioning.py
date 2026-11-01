"""Pose Studio auxiliary control images uploaded by the browser widget.

The widget renders depth, normal, outline and Character ID passes with the
capture camera of each RGB image (web/pose_studio/conditioning.mjs). This module
validates them and derives the silhouette and mask outputs from Character IDs.
"""
import base64
from io import BytesIO

import numpy as np
from PIL import Image

# Appended after ``images`` and ``lighting_prompt``; never reorder.
POSE_CONDITIONING_OUTPUTS = ("depth", "normal", "outline", "silhouette", "mask", "character_id")
POSE_CONDITIONING_PASSES = ("depth", "normal", "outline", "character_id")
_PASS_FOR_OUTPUT = {
    "depth": "depth", "normal": "normal", "outline": "outline",
    "silhouette": "character_id", "mask": "character_id", "character_id": "character_id",
}
# Character slot -> colour, mirrored from POSE_CHARACTER_ID_COLORS in the widget.
POSE_CHARACTER_ID_COLORS = ((255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0))

_MAX_PASS_BYTES = 32 * 1024 * 1024
_MAX_TOTAL_CHARS = 64 * 1024 * 1024


def requested_conditioning_outputs(export):
    """Linked auxiliary outputs recorded by the widget in ``export.conditioning_outputs``."""
    names = export.get("conditioning_outputs") if isinstance(export, dict) else None
    if not isinstance(names, list):
        return ()
    requested = {name for name in names if isinstance(name, str)}
    return tuple(name for name in POSE_CONDITIONING_OUTPUTS if name in requested)


def conditioning_passes(outputs):
    needed = {_PASS_FOR_OUTPUT[name] for name in outputs}
    return tuple(name for name in POSE_CONDITIONING_PASSES if name in needed)


def _decode_pass(value, width, height):
    if not isinstance(value, str) or not value:
        raise ValueError("auxiliary pass must be a non-empty PNG data URL")
    if "," in value:
        value = value.split(",", 1)[1]
    raw = base64.b64decode(value)
    if len(raw) > _MAX_PASS_BYTES:
        raise ValueError("auxiliary pass is too large")
    with Image.open(BytesIO(raw)) as image:
        if image.format != "PNG" or image.size != (width, height):
            raise ValueError(
                f"auxiliary pass must be a {width} x {height} PNG matching its RGB capture"
            )
        return np.array(image.convert("RGB"))


def decode_pose_conditioning(items, passes, sizes):
    """Decode one dict of pass PNGs per RGB capture; ``sizes`` are the RGB (width, height)."""
    if not isinstance(items, list) or len(items) != len(sizes):
        raise ValueError("auxiliary passes must contain one entry per RGB capture")
    total_chars = 0
    decoded = []
    palette = np.array([(0, 0, 0), *POSE_CHARACTER_ID_COLORS], dtype=np.uint8)
    for item, (width, height) in zip(items, sizes):
        if not isinstance(item, dict):
            raise ValueError("auxiliary pass entry must be an object")
        images = {}
        for name in passes:
            value = item.get(name)
            total_chars += len(value) if isinstance(value, str) else 0
            if total_chars > _MAX_TOTAL_CHARS:
                raise ValueError("auxiliary pass payload is too large")
            images[name] = _decode_pass(value, width, height)
        ids = images.get("character_id")
        if ids is not None:
            known = (ids[:, :, None, :] == palette[None, None, :, :]).all(axis=-1).any(axis=-1)
            if not known.all():
                raise ValueError("character_id pass contains colours outside the Character ID palette")
        decoded.append(images)
    return decoded


def silhouette_from_character_ids(ids):
    """Boolean character coverage of a Character ID image (background is black)."""
    return np.any(ids != 0, axis=-1)
