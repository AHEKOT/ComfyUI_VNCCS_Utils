"""Model description (loaded from JSON) and the interface every motion backend implements."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .transform import SourceMotion


ProgressReport = Callable[[str, float], None]

_MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_REPO_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
_SAFE_RELATIVE_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


class BackendUnavailable(RuntimeError):
    """The model's code or Python dependencies are missing; ``hint`` says how to install them."""

    def __init__(self, message: str, hint: str = ""):
        super().__init__(message)
        self.hint = hint


def safe_relative_path(value, what: str) -> str:
    """A relative path without traversal, for folders under the models directory."""
    text = str(value or "").strip().replace("\\", "/")
    parts = [part for part in text.split("/") if part]
    if not parts or not _SAFE_RELATIVE_RE.match(text) or text.startswith("/") or any(part in (".", "..") for part in parts):
        raise ValueError(f"{what} must be a relative path inside the models folder: {value!r}")
    return "/".join(parts)


@dataclass(frozen=True)
class WeightSource:
    """One Hugging Face snapshot the model needs, stored under ``models/text_to_motion/<local_dir>``."""

    repo_id: str
    local_dir: str
    revision: str = "main"
    allow_patterns: tuple = ()
    url: str = ""
    role: str = "model"
    # False: the model's own code downloads it (for example into the Hugging Face cache).
    managed: bool = True
    gated: bool = False

    @classmethod
    def from_dict(cls, data) -> "WeightSource":
        if not isinstance(data, dict):
            raise ValueError("weight entries must be objects")
        if data.get("source", "huggingface") != "huggingface":
            raise ValueError(f"unsupported weight source: {data.get('source')!r}")
        repo_id = str(data.get("repo_id") or "")
        if not _REPO_ID_RE.match(repo_id):
            raise ValueError(f"invalid Hugging Face repo id: {repo_id!r}")
        patterns = data.get("allow_patterns") or []
        if not isinstance(patterns, list) or not all(isinstance(p, str) for p in patterns):
            raise ValueError("allow_patterns must be a list of strings")
        return cls(
            repo_id=repo_id,
            local_dir=safe_relative_path(data.get("local_dir") or repo_id, "local_dir"),
            revision=str(data.get("revision") or "main"),
            allow_patterns=tuple(patterns),
            url=str(data.get("url") or f"https://huggingface.co/{repo_id}"),
            role=str(data.get("role") or "model"),
            managed=bool(data.get("managed", True)),
            gated=bool(data.get("gated", False)),
        )


def _range(data, key, default):
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError(f"capabilities.{key} must be an object")
    low, high = float(value.get("min", default[0])), float(value.get("max", default[1]))
    initial = float(value.get("default", default[2]))
    if not low <= initial <= high:
        raise ValueError(f"capabilities.{key} default must be between min and max")
    return {"min": low, "max": high, "default": initial}


@dataclass(frozen=True)
class MotionModelSpec:
    """Everything the JSON file says about one model."""

    id: str
    name: str
    backend: str
    description: str = ""
    homepage: str = ""
    code: dict = field(default_factory=dict)
    weights: tuple = ()
    options: dict = field(default_factory=dict)
    capabilities: dict = field(default_factory=dict)
    requirements: dict = field(default_factory=dict)
    license: dict = field(default_factory=dict)
    order: int = 100

    @classmethod
    def from_dict(cls, data) -> "MotionModelSpec":
        if not isinstance(data, dict):
            raise ValueError("model description must be a JSON object")
        model_id = str(data.get("id") or "")
        if not _MODEL_ID_RE.match(model_id):
            raise ValueError(f"invalid model id: {model_id!r}")
        backend = str(data.get("backend") or "")
        if not backend:
            raise ValueError(f"{model_id}: backend is required")
        caps = data.get("capabilities") or {}
        if not isinstance(caps, dict):
            raise ValueError(f"{model_id}: capabilities must be an object")
        capabilities = {
            "start_pose_constraint": bool(caps.get("start_pose_constraint", False)),
            "duration": _range(caps, "duration", (1.0, 10.0, 4.0)) or {"min": 1.0, "max": 10.0, "default": 4.0},
            "steps": _range(caps, "steps", (10, 200, 50)),
            "guidance": _range(caps, "guidance", (1.0, 10.0, 5.0)),
        }
        license_info = data.get("license") or {}
        if not isinstance(license_info, dict):
            raise ValueError(f"{model_id}: license must be an object")
        territories = license_info.get("restricted_territories") or []
        if not isinstance(territories, list) or not all(isinstance(t, str) for t in territories):
            raise ValueError(f"{model_id}: license.restricted_territories must be a list of names")
        weights = data.get("weights") or []
        if not isinstance(weights, list):
            raise ValueError(f"{model_id}: weights must be a list")
        for key in ("code", "options", "requirements"):
            if not isinstance(data.get(key) or {}, dict):
                raise ValueError(f"{model_id}: {key} must be an object")
        return cls(
            id=model_id,
            name=str(data.get("name") or model_id),
            backend=backend,
            description=str(data.get("description") or ""),
            homepage=str(data.get("homepage") or ""),
            code=dict(data.get("code") or {}),
            weights=tuple(WeightSource.from_dict(entry) for entry in weights),
            options=dict(data.get("options") or {}),
            capabilities=capabilities,
            requirements=dict(data.get("requirements") or {}),
            license={**license_info, "restricted_territories": list(territories)},
            order=int(data.get("order", 100)),
        )

    def public(self) -> dict:
        """What the browser needs to list the model, show its limits and warn about its license."""
        return {
            "id": self.id,
            "name": self.name,
            "backend": self.backend,
            "description": self.description,
            "homepage": self.homepage,
            "capabilities": self.capabilities,
            "requirements": self.requirements,
            "license": {
                "name": str(self.license.get("name") or ""),
                "url": str(self.license.get("url") or ""),
                "commercial_use": self.license.get("commercial_use"),
                "restricted_territories": list(self.license.get("restricted_territories") or []),
                "territory_notice": str(self.license.get("territory_notice") or ""),
                "notice": str(self.license.get("notice") or ""),
            },
            "code_url": str(self.code.get("url") or ""),
            "weights": [
                {"repo_id": w.repo_id, "url": w.url, "role": w.role, "gated": w.gated} for w in self.weights
            ],
        }


@dataclass
class MotionRequest:
    """A validated generation request, independent of the model."""

    prompt: str
    duration: float
    seed: int
    steps: int | None = None
    guidance: float | None = None
    use_start_pose: bool = True
    keypoints: dict = field(default_factory=dict)
    rest_keypoints: dict = field(default_factory=dict)
    head_axes: dict | None = None


class MotionBackend(ABC):
    """One text-to-motion model family.

    ``load`` prepares the model (downloading weights on first use) and
    ``generate`` returns the motion in the model's own skeleton. The service keeps
    one loaded backend at a time and serializes calls.
    """

    #: Python modules the backend needs; missing ones raise BackendUnavailable.
    requires: tuple = ()

    def __init__(self, spec: MotionModelSpec, models_dir: Path):
        self.spec = spec
        self.models_dir = Path(models_dir)

    def install_hint(self) -> str:
        return str(self.spec.code.get("install") or "")

    def check_available(self) -> None:
        missing = [name for name in self.requires if module_missing(name)]
        if missing:
            raise BackendUnavailable(
                f"{self.spec.name} needs Python packages that are not installed: {', '.join(missing)}.",
                self.install_hint(),
            )

    def weights_dir(self, source: WeightSource) -> Path:
        return self.models_dir / source.local_dir

    def ensure_weights(self, report: ProgressReport, sources=None) -> dict:
        """Download missing snapshots; returns ``{repo_id: local folder}``."""
        folders = {}
        for source in self.spec.weights if sources is None else sources:
            if not source.managed:
                continue
            target = self.weights_dir(source)
            marker = target / ".vnccs_complete"
            if not marker.exists():
                report(f"Downloading {source.repo_id} (first run only)...", 4)
                try:
                    from huggingface_hub import snapshot_download
                except ImportError as exc:
                    raise BackendUnavailable("huggingface_hub is not installed.", "pip install huggingface_hub") from exc
                target.mkdir(parents=True, exist_ok=True)
                # Managed weights are public repositories; gated ones are left to the model's own code.
                snapshot_download(
                    repo_id=source.repo_id,
                    revision=source.revision,
                    allow_patterns=list(source.allow_patterns) or None,
                    local_dir=str(target),
                    token=False,
                )
                marker.write_text(source.revision, encoding="utf-8")
            folders[source.repo_id] = target
        return folders

    @abstractmethod
    def load(self, report: ProgressReport) -> None:
        """Load the model onto the device."""

    @abstractmethod
    def generate(self, request: MotionRequest, report: ProgressReport) -> SourceMotion:
        """Generate one motion. ``report(message, percent)`` updates the browser."""

    def unload(self) -> None:
        """Drop the model and free device memory."""


def module_missing(name: str) -> bool:
    """True when ``name`` cannot be imported (checked without importing it)."""
    import importlib.util
    import sys

    if name in sys.modules:
        return sys.modules[name] is None
    try:
        return importlib.util.find_spec(name) is None
    except (ImportError, ValueError):
        return True


def torch_device(torch):
    try:
        import comfy.model_management as model_management

        return model_management.get_torch_device()
    except Exception:
        return torch.device("cuda:0" if torch.cuda.is_available() else "cpu")


def free_comfy_vram() -> None:
    """Unload ComfyUI's models so the motion model and its text encoder fit."""
    try:
        import comfy.model_management as model_management

        model_management.unload_all_models()
        model_management.soft_empty_cache()
    except Exception:
        pass


def empty_torch_cache() -> None:
    try:
        import gc

        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
