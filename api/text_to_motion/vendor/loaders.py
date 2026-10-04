"""Load the vendored ARDY / Kimodo models inside ComfyUI's Python (no extra packages).

Checkpoints and the text encoder are downloaded once into ``<ComfyUI>/models/text_to_motion``
with ``token=False``. Both model families share one LLM2Vec text encoder instance.
"""

from __future__ import annotations

import threading
from pathlib import Path

from . import config_loader
from .hub import ensure_repo

_VENDOR_PACKAGE = __package__ or "vendor"
_ENCODER_LOCK = threading.Lock()
_ENCODER = {"key": None, "encoder": None}

TEXT_ENCODER_FILES = (
    "config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json",
    "special_tokens_map.json", "model.safetensors.index.json", "model-*.safetensors",
)
ADAPTER_FILES = ("adapter_config.json", "adapter_model.safetensors", "llm2vec_config.json")


def _import_family(family: str) -> None:
    """Import every vendored module a checkpoint config may name (fills the target registry)."""
    if family == "ardy":
        from .ardy import constraints, geometry, skeleton, tools  # noqa: F401
        from .ardy.model import (  # noqa: F401
            ardy_model, auto_latent_twostage_denoiser, backbone, cfg, diffusion, latent_utils,
        )
        from .ardy.model.autoencoder import fsq, transformer  # noqa: F401
        from .ardy.motion_rep import conditioning, feet, stats  # noqa: F401
        from .ardy.motion_rep.reps import ardy_motionrep, base  # noqa: F401
    elif family == "kimodo":
        from .kimodo import constraints, geometry, skeleton, tools  # noqa: F401
        from .kimodo.model import backbone, cfg, diffusion, kimodo_model, twostage_denoiser  # noqa: F401
        from .kimodo.motion_rep import conditioning, feature_utils, feet, smooth_root, stats  # noqa: F401
        from .kimodo.motion_rep.reps import base, kimodo_motionrep  # noqa: F401
    else:
        raise ValueError(f"unknown vendored motion family {family!r}")


def text_encoder(models_dir: Path, sources: dict, device=None, offload: bool = True, report=None):
    """The shared LLM2Vec encoder (built once per process, reused by ARDY and Kimodo)."""
    from .llm2vec_encoder import LLM2VecEncoder

    def source(name):
        value = sources.get(name)
        if isinstance(value, str):
            return value, "main"
        return (value or {}).get("repo_id"), (value or {}).get("revision") or "main"

    key = (str(models_dir), source("base"), source("mntp"), source("supervised"), bool(offload))
    with _ENCODER_LOCK:
        if _ENCODER["key"] == key and _ENCODER["encoder"] is not None:
            return _ENCODER["encoder"]
        root = Path(models_dir) / "text_encoders"
        repo, revision = source("base")
        base = ensure_repo(repo, root / repo.replace("/", "--"), report, revision=revision, include=TEXT_ENCODER_FILES)
        adapters = []
        for name in ("mntp", "supervised"):
            repo, revision = source(name)
            if repo:
                adapters.append(ensure_repo(repo, root / repo.replace("/", "--"), report, revision=revision, include=ADAPTER_FILES))
        if report:
            report("Loading the text encoder (Llama 3 8B, first time takes a while)...", 8)
        encoder = LLM2VecEncoder(base, adapters, device=device, offload=offload)
        _ENCODER.update(key=key, encoder=encoder)
        return encoder


def release_text_encoder() -> None:
    with _ENCODER_LOCK:
        _ENCODER.update(key=None, encoder=None)


def motion_model(family: str, repo_id: str, models_dir: Path, device, encoder, report=None):
    """Download ``repo_id`` and build its model from the checkpoint's config.yaml."""
    _import_family(family)
    folder = ensure_repo(repo_id, Path(models_dir) / "checkpoints" / repo_id.replace("/", "--"), report)
    config_path = folder / "config.yaml"
    if not config_path.is_file():
        raise FileNotFoundError(f"{repo_id} has no config.yaml in {folder}")
    cfg = config_loader.load_yaml(config_path)
    cfg["checkpoint_dir"] = str(folder)
    cfg = config_loader.resolve(cfg)
    cfg.pop("checkpoint_dir", None)
    cfg["text_encoder"] = None
    cfg["device"] = device
    if report:
        report(f"Building {repo_id}...", 10)
    registry = config_loader.TargetRegistry(_VENDOR_PACKAGE, (family,))
    model = config_loader.instantiate(cfg, registry)
    model.text_encoder = encoder
    return model.eval()
