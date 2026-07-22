"""ComfyUI bridge for the browser-based VNCCS img2threejs Studio.

The interactive editor and provider calls live in the DOM widget and its
server API.  This node deliberately keeps only an opaque project id in the
workflow, then exposes the latest bounded project artifacts when the graph is
executed.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image


_EMPTY_STATE = '{"schema_version":1,"project_id":""}'
_MAX_STATE_CHARS = 256 * 1024
_MAX_PREVIEW_PIXELS = 4096 * 4096
_MAX_TEXT_ARTIFACT_BYTES = 16 * 1024 * 1024
_PROJECT_ID_RE = re.compile(r"^[a-f0-9]{32}$")


def _parse_state(studio_data: Any) -> dict[str, Any]:
    raw = studio_data if isinstance(studio_data, str) else str(studio_data or "")
    if len(raw) > _MAX_STATE_CHARS:
        raise ValueError("img2threejs Studio state is too large")
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError("img2threejs Studio state is not valid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("img2threejs Studio state must be an object")
    project_id = value.get("project_id", "")
    if project_id and (not isinstance(project_id, str) or not _PROJECT_ID_RE.fullmatch(project_id)):
        raise ValueError("img2threejs Studio project id is invalid")
    return value


def _empty_image() -> torch.Tensor:
    return torch.zeros((1, 64, 64, 3), dtype=torch.float32)


def _bounded_text(path: Path) -> str:
    try:
        if not path.is_file() or path.stat().st_size > _MAX_TEXT_ARTIFACT_BYTES:
            return ""
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return ""


def _preview_tensor(path: Path) -> torch.Tensor:
    if not path.is_file():
        return _empty_image()
    try:
        with Image.open(path) as image:
            if image.width * image.height > _MAX_PREVIEW_PIXELS:
                raise ValueError("img2threejs preview dimensions are too large")
            pixels = np.array(image.convert("RGB"), dtype=np.float32, copy=True) / 255.0
        return torch.from_numpy(pixels).unsqueeze(0)
    except (OSError, ValueError):
        return _empty_image()


def _project_dir(project_id: str) -> Path:
    # Keep path validation and storage policy centralized in the API module.
    from ..api.img2threejs_studio import resolve_project_dir

    return resolve_project_dir(project_id)


class VNCCS_Img2ThreeJSStudio:
    """Expose the last saved img2threejs Studio project to a ComfyUI graph."""

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("preview", "threejs_source", "sculpt_spec", "project_path")
    FUNCTION = "load_project"
    CATEGORY = "VNCCS/3D"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "studio_data": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": _EMPTY_STATE,
                        "dynamicPrompts": False,
                    },
                ),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    @classmethod
    def VALIDATE_INPUTS(cls, studio_data: str = _EMPTY_STATE, **_kwargs):
        try:
            _parse_state(studio_data)
        except ValueError as exc:
            return str(exc)
        return True

    @classmethod
    def IS_CHANGED(cls, studio_data: str = _EMPTY_STATE, **_kwargs):
        digest = hashlib.sha256(str(studio_data or "").encode("utf-8")).hexdigest()
        try:
            state = _parse_state(studio_data)
            project_id = str(state.get("project_id") or "")
            if not project_id:
                return digest
            project = _project_dir(project_id)
            stamps = []
            for name in ("preview.png", "model.ts", "object-sculpt-spec.json", "metadata.json"):
                path = project / name
                if path.is_file():
                    stat = path.stat()
                    stamps.append(f"{name}:{stat.st_mtime_ns}:{stat.st_size}")
            if stamps:
                digest = hashlib.sha256(f"{digest}|{'|'.join(stamps)}".encode("utf-8")).hexdigest()
        except (OSError, ValueError):
            pass
        return digest

    def load_project(self, studio_data: str = _EMPTY_STATE, unique_id=None):
        del unique_id
        state = _parse_state(studio_data)
        project_id = str(state.get("project_id") or "")
        if not project_id:
            return (_empty_image(), "", "", "")

        project = _project_dir(project_id)
        if not project.is_dir():
            return (_empty_image(), "", "", "")

        preview_path = project / "preview.png"
        if not preview_path.is_file():
            # A generated project always has a normalized reference; using it
            # is more informative than emitting an all-black image before the
            # user uploads a viewport capture.
            preview_path = project / "reference.png"

        return (
            _preview_tensor(preview_path),
            _bounded_text(project / "model.ts"),
            _bounded_text(project / "object-sculpt-spec.json"),
            str(project),
        )
