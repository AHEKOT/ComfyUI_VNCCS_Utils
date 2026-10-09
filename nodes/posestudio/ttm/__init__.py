"""Standalone ARDY inference; tensor dependencies load when the backend loads."""
from pathlib import Path
from .base import MotionRequest
from .registry import backend_class, default_models_dir, load_specs
from .transform import SourceMotion

__all__ = ["MotionRequest", "SourceMotion", "create_backend", "load_specs"]


def create_backend(models_dir=None, model_id="ardy-core-rp-20fps-h40"):
    """Create ARDY with an explicit model root or ComfyUI's managed directory."""
    spec = load_specs()[model_id]
    root = default_models_dir() if models_dir is None else Path(models_dir)
    return backend_class(spec.backend)(spec, root)
