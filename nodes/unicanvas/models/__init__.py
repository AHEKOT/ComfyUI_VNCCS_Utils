"""UniCanvas model family adapters.

Each family lives in its own module and derives from
:class:`~.base.UniCanvasModelModule`. Families are registered here, in one
place, so importing any ``models`` submodule (for example ``models.registry``)
always sees the complete registry. See ``docs/UNICANVAS_MODEL_MODULES.md`` for
how to add a new family.
"""

from __future__ import annotations

from .anima import ANIMA_DEFAULTS, AnimaUniCanvasModule
from .base import UniCanvasModelModule
from .flux_klein import FLUX_KLEIN_DEFAULTS, FluxKleinUniCanvasModule
from .krea2_edit import KREA2_EDIT_DEFAULTS, Krea2EditUniCanvasModule
from .minimax_h3 import MiniMaxH3UniCanvasModule
from .qwen_image21 import QwenImage21UniCanvasModule
from .qwen_image_edit import QWEN_IMAGE_EDIT_DEFAULTS, QwenImageEditUniCanvasModule
from .registry import UNICANVAS_MODEL_MODULES, _get_unicanvas_model_module, _register_unicanvas_model_module
from .sdxl import ILLUSTRIOUS_DEFAULTS, SDXLUniCanvasModule
from .z_image import Z_IMAGE_DEFAULTS, ZImageUniCanvasModule


_register_unicanvas_model_module(
    Krea2EditUniCanvasModule("krea2_edit", ("krea2-edit", "krea2_identity_edit"), KREA2_EDIT_DEFAULTS, is_edit_model=True)
)
_register_unicanvas_model_module(SDXLUniCanvasModule("sdxl", ("illustrious",), ILLUSTRIOUS_DEFAULTS))
_register_unicanvas_model_module(AnimaUniCanvasModule("anima", (), ANIMA_DEFAULTS))
_register_unicanvas_model_module(
    FluxKleinUniCanvasModule("flux_klein", ("flux-klein", "klein"), FLUX_KLEIN_DEFAULTS, is_edit_model=True)
)
_register_unicanvas_model_module(
    QwenImageEditUniCanvasModule(
        "qwen_image_edit",
        ("qwen-edit", "qwen_edit", "qwen-image-edit", "qwen_image_edit_2511"),
        QWEN_IMAGE_EDIT_DEFAULTS,
        is_edit_model=True,
    )
)
_register_unicanvas_model_module(ZImageUniCanvasModule("z_image", ("z-image", "zimage", "z_image_turbo"), Z_IMAGE_DEFAULTS))
_register_unicanvas_model_module(MiniMaxH3UniCanvasModule())
_register_unicanvas_model_module(QwenImage21UniCanvasModule())

__all__ = [
    "UNICANVAS_MODEL_MODULES",
    "UniCanvasModelModule",
    "_get_unicanvas_model_module",
    "_register_unicanvas_model_module",
]
