"""Build the local BF16 ARDY checkpoint and cache its ConvRot INT4 encoder."""

from __future__ import annotations

import threading
from pathlib import Path

from . import config_loader

_VENDOR_PACKAGE = __package__ or "vendor"
_ENCODER_LOCK = threading.Lock()
_ENCODER = {"key": None, "encoder": None}

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
    else:
        raise ValueError(f"unknown vendored motion family {family!r}")


def text_encoder(models_dir: Path, sources: dict, device=None, offload: bool = True, report=None, compact_dir=None):
    """Load only the prepared encoder; never download or convert upstream weights."""
    from .llm2vec_encoder import LLM2VecEncoder

    if not compact_dir:
        raise ValueError("the local ARDY compact directory is required")
    key = (str(Path(compact_dir).resolve()), str(device), bool(offload))
    with _ENCODER_LOCK:
        if _ENCODER["key"] == key and _ENCODER["encoder"] is not None:
            return _ENCODER["encoder"]
        if report:
            report("Loading the compact ConvRot INT4 text encoder...", 8)
        encoder = LLM2VecEncoder(Path(compact_dir) / "text_encoder", device=device, offload=offload)
        _ENCODER.update(key=key, encoder=encoder)
        return encoder


def release_text_encoder() -> None:
    with _ENCODER_LOCK:
        _ENCODER.update(key=None, encoder=None)


def motion_model(family: str, repo_id: str, models_dir: Path, device, encoder, report=None, compact_dir=None, motion_precision=None):
    """Build ARDY from its local config and BF16 consolidated checkpoint."""
    if family != "ardy" or not compact_dir or motion_precision != "bf16":
        raise ValueError("BF16 motion requires the local ARDY compact checkpoint")
    _import_family(family)
    folder = Path(compact_dir)
    config_path = folder / "config.yaml"
    if not config_path.is_file():
        raise FileNotFoundError(f"{repo_id} has no config.yaml in {folder}")
    cfg = config_loader.load_yaml(config_path)
    cfg["checkpoint_dir"] = str(folder)
    cfg = config_loader.resolve(cfg)
    cfg.pop("checkpoint_dir", None)
    for component in ("denoiser", "autoencoder"):
        cfg[component]["ckpt_path"] = str(folder / "motion.bf16.safetensors")
    cfg["text_encoder"] = None
    cfg["device"] = device
    if report:
        report(f"Building {repo_id}...", 10)
    registry = config_loader.TargetRegistry(_VENDOR_PACKAGE, (family,))
    model = config_loader.instantiate(cfg, registry)
    model.text_encoder = encoder
    return model.eval()
