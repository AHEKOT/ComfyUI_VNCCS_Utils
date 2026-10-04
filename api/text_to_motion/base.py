"""Model description (loaded from JSON) and the interface every motion backend implements."""

from __future__ import annotations

import json
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


# Setup steps a model lists in its JSON. "pip" packages are installed through ComfyUI-Manager from
# the browser, "download" by Pose Studio itself, "auto" happens on the first generation and
# "manual" explains what the user has to do (with a command to copy). Code checkouts are manual on
# purpose: ComfyUI-Manager's git install also runs the repository's requirements.txt, and the
# model repositories pin torch / transformers / numpy versions that would break ComfyUI.
SETUP_KINDS = ("pip", "download", "auto", "manual")
_STEP_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
_MODULE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]{0,63}$")
# One pip requirement: a name with an optional version pin, or a git+https GitHub URL.
_PIP_PACKAGE_RE = re.compile(
    r"^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\[[A-Za-z0-9_,.-]+\])?(?:(?:==|>=|<=|~=|<|>)[A-Za-z0-9.*+!-]{1,40})?"
    r"|git\+https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?(?:@[A-Za-z0-9_./-]+)?)$"
)
_GUIDE_TEXT_KEYS = ("summary", "best_for", "speed", "setup_effort")


def _text(value, limit: int = 600) -> str:
    return str(value or "").strip()[:limit]


def parse_guide(data, model_id: str) -> dict:
    """The model card shown in the panel: plain text that helps the user pick a model."""
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError(f"{model_id}: guide must be an object")
    guide = {key: _text(data.get(key)) for key in _GUIDE_TEXT_KEYS if data.get(key)}
    if data.get("download_gb") is not None:
        guide["download_gb"] = float(data["download_gb"])
    return guide


def parse_setup(data, model_id: str) -> tuple:
    if data is None:
        return ()
    if not isinstance(data, list):
        raise ValueError(f"{model_id}: setup must be a list of steps")
    steps, seen = [], set()
    for entry in data:
        if not isinstance(entry, dict):
            raise ValueError(f"{model_id}: setup steps must be objects")
        step_id, kind = str(entry.get("id") or ""), str(entry.get("kind") or "")
        if not _STEP_ID_RE.match(step_id) or step_id in seen:
            raise ValueError(f"{model_id}: setup step ids must be unique lowercase names: {step_id!r}")
        if kind not in SETUP_KINDS:
            raise ValueError(f"{model_id}: unknown setup step kind {kind!r}")
        seen.add(step_id)
        step = {"id": step_id, "kind": kind, "label": _text(entry.get("label"), 120) or step_id,
                "detail": _text(entry.get("detail"))}
        if kind == "pip":
            packages = entry.get("packages") or []
            if not isinstance(packages, list) or not packages or not all(
                isinstance(p, str) and _PIP_PACKAGE_RE.match(p) for p in packages
            ):
                raise ValueError(f"{model_id}: setup step {step_id!r} needs valid pip packages")
            modules = entry.get("modules") or []
            if not isinstance(modules, list) or not modules or not all(isinstance(m, str) and _MODULE_RE.match(m) for m in modules):
                raise ValueError(f"{model_id}: setup step {step_id!r} needs the Python modules it provides")
            step.update(packages=list(packages), modules=list(modules))
        if entry.get("command"):
            step["command"] = _text(entry.get("command"), 600)
        if entry.get("check") is not None:
            step["check"] = _text(entry.get("check"), 40)
        link = str(entry.get("link") or "")
        if link:
            if not link.startswith("https://"):
                raise ValueError(f"{model_id}: setup step {step_id!r} link must be https")
            step["link"] = link
        steps.append(step)
    return tuple(steps)


_MAX_INDEX_BYTES = 8 * 1024 * 1024
_MAX_SHARDS = 256


def _file_list(data, key: str) -> tuple:
    values = data.get(key) or []
    if not isinstance(values, list):
        raise ValueError(f"{key} must be a list of file names")
    return tuple(safe_relative_path(value, key) for value in values)


@dataclass(frozen=True)
class WeightSource:
    """Files of one public Hugging Face repository, stored under ``models/text_to_motion/<local_dir>``.

    Files are fetched one by one with ``hf_hub_download(..., token=False)``: ``files``
    are required, ``optional_files`` are skipped when the repository lacks them, and
    ``index_file`` (a safetensors index) adds every shard it lists.
    """

    repo_id: str
    local_dir: str
    revision: str = "main"
    files: tuple = ()
    optional_files: tuple = ()
    index_file: str = ""
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
        managed = bool(data.get("managed", True))
        files = _file_list(data, "files")
        index_file = safe_relative_path(data["index_file"], "index_file") if data.get("index_file") else ""
        if managed and not (files or index_file):
            raise ValueError(f"{repo_id}: list the files to download, or set managed to false")
        return cls(
            repo_id=repo_id,
            local_dir=safe_relative_path(data.get("local_dir") or repo_id, "local_dir"),
            revision=str(data.get("revision") or "main"),
            files=files,
            optional_files=_file_list(data, "optional_files"),
            index_file=index_file,
            url=str(data.get("url") or f"https://huggingface.co/{repo_id}"),
            role=str(data.get("role") or "model"),
            managed=managed,
            gated=bool(data.get("gated", False)),
        )


def _character_count(value, label: str) -> int:
    try:
        count = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a whole number") from None
    if not 1 <= count <= 8:
        raise ValueError(f"{label} must be between 1 and 8")
    return count


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
    guide: dict = field(default_factory=dict)
    setup: tuple = ()

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
            "max_characters": _character_count(caps.get("max_characters", 1), f"{model_id}: capabilities.max_characters"),
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
        parsed_weights = tuple(WeightSource.from_dict(entry) for entry in weights)
        roles = [source.role for source in parsed_weights if source.managed]
        if len(roles) != len(set(roles)):
            raise ValueError(f"{model_id}: managed weights need distinct roles")
        return cls(
            id=model_id,
            name=str(data.get("name") or model_id),
            backend=backend,
            description=str(data.get("description") or ""),
            homepage=str(data.get("homepage") or ""),
            code=dict(data.get("code") or {}),
            weights=parsed_weights,
            options=dict(data.get("options") or {}),
            capabilities=capabilities,
            requirements=dict(data.get("requirements") or {}),
            license={**license_info, "restricted_territories": list(territories)},
            order=int(data.get("order", 100)),
            guide=parse_guide(data.get("guide"), model_id),
            setup=parse_setup(data.get("setup"), model_id),
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
            "guide": dict(self.guide),
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
    #: Characters the motion is generated for; models with max_characters == 1 always get 1.
    characters: int = 1


class MotionBackend(ABC):
    """One text-to-motion model family.

    Every backend so far generates one character. A model that handles interactions between
    several characters (a handshake, a hug) declares ``capabilities.max_characters`` > 1 in its
    JSON; the service then passes ``MotionRequest.characters`` and the backend is expected to
    return one ``SourceMotion`` per character (a list) - that contract is not used yet.

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

    # --- setup ------------------------------------------------------------------------

    def find_code_dir(self, default_local_dir: str) -> Path:
        """The model's code checkout under the models folder."""
        return self.models_dir / safe_relative_path(self.spec.code.get("local_dir") or default_local_dir, "code.local_dir")

    def check_part(self, name: str):
        """Whether a named part of the install is in place (True/False), or None when unknown."""
        return self.weights_ready() if name == "weights" else None

    def step_done(self, step: dict):
        if step["kind"] == "pip":
            return all(not module_missing(name) for name in step["modules"])
        if step.get("check"):
            try:
                return self.check_part(step["check"])
            except Exception:
                return False
        return None

    def setup_status(self) -> list:
        return [{**step, "done": self.step_done(step)} for step in self.spec.setup]

    def run_download(self, step: dict, report: ProgressReport) -> None:
        """Run a ``download`` setup step: the managed weights by default, anything else per backend."""
        if step.get("check") == "weights":
            self.ensure_weights(report)
            return
        raise ValueError(f"{self.spec.name} has no download step {step['id']!r}")

    def load_vendored(self, family: str, report, device):
        """Build a vendored ARDY / Kimodo model (api/text_to_motion/vendor) in ComfyUI's own Python.

        ``options.repo_id`` is the checkpoint repository and ``options.text_encoder`` the
        LLM2Vec sources (``base``, ``mntp``, ``supervised``); both are downloaded once into the
        models folder with ``token=False``.
        """
        from .vendor import loaders

        sources = dict(self.spec.options.get("text_encoder") or {})
        if not (sources.get("base") or {}):
            raise ValueError(f"{self.spec.id}: options.text_encoder.base is required")
        encoder = loaders.text_encoder(self.models_dir, sources, device=device,
                                       offload=bool(self.spec.options.get("offload_text_encoder", True)), report=report)
        return loaders.motion_model(family, str(self.spec.options["repo_id"]), self.models_dir, device, encoder, report)

    def weights_ready(self) -> bool:
        """True when every required file of the managed weights is already downloaded."""
        for source in self.spec.weights:
            if not source.managed:
                continue
            target = self.weights_dir(source)
            names = list(source.files) + ([source.index_file] if source.index_file else [])
            if not all((target / name).is_file() for name in names):
                return False
            if source.index_file and not all((target / shard).is_file() for shard in self._index_shards(target / source.index_file)):
                return False
        return True

    def weights_dir(self, source: WeightSource) -> Path:
        return self.models_dir / source.local_dir

    def ensure_weights(self, report: ProgressReport, sources=None) -> dict:
        """Download missing files of the managed weights; returns ``{role: local folder}``."""
        folders = {}
        for source in self.spec.weights if sources is None else sources:
            if not source.managed:
                continue
            target = self.weights_dir(source)
            self._download_source(source, target, report)
            folders[source.role] = target
        return folders

    def _download_source(self, source: WeightSource, target: Path, report: ProgressReport) -> None:
        pending = [(name, False) for name in source.files] + [(name, True) for name in source.optional_files]
        if source.index_file:
            pending.insert(0, (source.index_file, False))
        expanded = False
        while pending:
            name, optional = pending.pop(0)
            path = target / name
            if not (path.is_file() and path.stat().st_size > 0):
                report(f"Downloading {source.repo_id}/{name} (first run only)...", 4)
                if not self._download_file(source, name, target, optional):
                    continue
            if name == source.index_file and not expanded:
                expanded = True
                pending.extend((shard, False) for shard in self._index_shards(path))

    @staticmethod
    def _download_file(source: WeightSource, name: str, target: Path, optional: bool) -> bool:
        try:
            from huggingface_hub import hf_hub_download
        except ImportError as exc:
            raise BackendUnavailable("huggingface_hub is not installed.", "pip install huggingface_hub") from exc
        target.mkdir(parents=True, exist_ok=True)
        try:
            # Public repositories only: token=False keeps the library from finding credentials.
            hf_hub_download(
                repo_id=source.repo_id,
                filename=name,
                revision=source.revision,
                local_dir=str(target),
                token=False,
            )
        except Exception as exc:
            if optional and type(exc).__name__ in {"EntryNotFoundError", "RemoteEntryNotFoundError"}:
                return False
            raise
        return True

    @staticmethod
    def _index_shards(index_path: Path) -> list:
        if index_path.stat().st_size > _MAX_INDEX_BYTES:
            raise ValueError(f"{index_path.name} is too large")
        weight_map = json.loads(index_path.read_text(encoding="utf-8")).get("weight_map")
        if not isinstance(weight_map, dict):
            raise ValueError(f"{index_path.name} has no weight_map")
        shards = sorted({safe_relative_path(value, "shard") for value in weight_map.values()})
        if not shards or len(shards) > _MAX_SHARDS:
            raise ValueError(f"{index_path.name} lists an unexpected number of shards")
        return shards

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
