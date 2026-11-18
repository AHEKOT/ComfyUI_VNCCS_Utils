"""Durable image storage for Pose Studio reference layers.

Workflows keep only the compact asset name. The file name is the SHA-256 of the image
bytes plus an extension for the decoded format, so assets are immutable and identical
images are stored once. They live in the ComfyUI user directory, which survives restarts
and temporary-folder cleanup, and are not pruned automatically: any saved workflow may
still reference them.
"""
import hashlib
import io
import os
import re
import tempfile

from PIL import Image

from ..shared.paths import _vnccs_user_data_root

# The browser stores at most 1024 px on the long side; these limits only bound what the
# endpoint accepts.
REFERENCE_ASSET_MAX_BYTES = 16 * 1024 * 1024
_MAX_EDGE = 4096

_FORMATS = {
    "WEBP": ("webp", "image/webp"),
    "PNG": ("png", "image/png"),
    "JPEG": ("jpg", "image/jpeg"),
}
_CONTENT_TYPES = {extension: content_type for extension, content_type in _FORMATS.values()}
_ASSET_RE = re.compile(r"[0-9a-f]{64}\.(webp|png|jpg)")


class ReferenceAssetRejected(ValueError):
    """The upload is not an acceptable image."""


class ReferenceAssetStorageError(OSError):
    """The image is valid but could not be written."""


def _assets_dir():
    return os.path.join(_vnccs_user_data_root(), "pose_reference_layers")


def is_reference_asset_name(name):
    return isinstance(name, str) and _ASSET_RE.fullmatch(name) is not None


def _inspect_image(raw):
    """Fully decodes the image and returns (format key, width, height)."""
    try:
        with Image.open(io.BytesIO(raw)) as image:
            kind = image.format
            width, height = image.size
            if kind not in _FORMATS:
                raise ReferenceAssetRejected("Reference images must be WebP, PNG or JPEG.")
            # Checked from the header, before any pixels are decoded.
            if width < 1 or height < 1 or max(width, height) > _MAX_EDGE:
                raise ReferenceAssetRejected(f"Reference images are limited to {_MAX_EDGE} px per side.")
            image.load()
    except ReferenceAssetRejected:
        raise
    except Exception as exc:
        raise ReferenceAssetRejected("The file is not a readable image.") from exc
    return kind, width, height


def store_reference_asset(raw):
    """Validates and stores image bytes; returns the asset name and pixel size."""
    if not isinstance(raw, (bytes, bytearray)) or not raw:
        raise ReferenceAssetRejected("The image is empty.")
    if len(raw) > REFERENCE_ASSET_MAX_BYTES:
        raise ReferenceAssetRejected("The image is too large for a reference layer.")
    kind, width, height = _inspect_image(raw)
    name = f"{hashlib.sha256(raw).hexdigest()}.{_FORMATS[kind][0]}"
    directory = _assets_dir()
    path = os.path.join(directory, name)
    temp_path = None
    try:
        os.makedirs(directory, exist_ok=True)
        if not os.path.isfile(path) or os.path.getsize(path) != len(raw):
            with tempfile.NamedTemporaryFile(mode="wb", dir=directory, prefix="upload_", delete=False) as handle:
                temp_path = handle.name
                handle.write(raw)
            os.replace(temp_path, path)
            temp_path = None
    except OSError as exc:
        raise ReferenceAssetStorageError(f"Could not write the image to {directory}: {exc.strerror or exc}") from exc
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
    return {"asset": name, "width": width, "height": height}


def reference_asset_file(name):
    """Returns (path, content type) of a stored asset, or None when it does not exist."""
    if not is_reference_asset_name(name):
        raise ReferenceAssetRejected("Invalid reference asset name.")
    path = os.path.join(_assets_dir(), name)
    if not os.path.isfile(path):
        return None
    return path, _CONTENT_TYPES[name.rsplit(".", 1)[1]]
