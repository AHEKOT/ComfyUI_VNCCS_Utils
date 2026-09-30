"""ComfyUI-GGUF interop: architecture hints for GGUF files without ``general.architecture``.

stable-diffusion.cpp style GGUF files carry no architecture metadata, so ComfyUI-GGUF guesses
it from tensor names with its own template list (``tools/convert.py: arch_list``). That list
has no Qwen-Image / Qwen-Image 2.1 entry, so such files fail with "Unknown model
architecture!" even though ComfyUI core detects them fine from the state dict.

The detected name only has to pass ComfyUI-GGUF's check (it is used for one SDXL quirk); the
real model type always comes from ComfyUI core's state-dict detection. So for the duration of
one load we put templates in front of ComfyUI-GGUF's list:

- ``arch="auto"``: extra templates for the Qwen-Image family (1.x / Edit / 2.1),
- ``arch=<name>``: a catch-all template reporting ``<name>``, the user's explicit hint.

The list is restored afterwards. Callers hold ``_COMFY_MODEL_OP_LOCK`` for model loads.
"""

from __future__ import annotations

import contextlib
from typing import Any, Iterator

from .comfy_bridge import find_loaded_module, import_loaded_submodule


GGUF_ARCH_AUTO = "auto"

# Tensor-name sets that identify the Qwen-Image family in a reference-format state dict.
_QWEN_IMAGE_KEYS = (
    # Qwen-Image 2.1
    ("txt_in.text_norm.weight", "modulation.1.weight", "img_in.weight", "proj_out.weight"),
    # Qwen-Image 1.x / Edit / Edit 2509 / 2511
    ("txt_norm.weight", "img_in.weight", "transformer_blocks.0.img_mod.1.weight"),
)


def _gguf_loader_module() -> Any:
    """ComfyUI-GGUF's ``loader`` module as loaded by ComfyUI (None when not installed)."""
    return find_loaded_module(
        lambda name, module: name.endswith(".loader")
        and callable(getattr(module, "gguf_sd_loader", None))
        and hasattr(module, "IMG_ARCH_LIST")
    )


def _gguf_convert_module(loader: Any) -> Any:
    """ComfyUI-GGUF's ``tools.convert`` module, the same instance its loader imports."""
    package = getattr(loader, "__package__", None)
    return import_loaded_submodule(f"{package}.tools.convert") if package else None


def gguf_architectures() -> list[str]:
    """Image architectures ComfyUI-GGUF accepts, for the loader's Architecture picker."""
    loader = _gguf_loader_module()
    names = sorted(str(item) for item in (getattr(loader, "IMG_ARCH_LIST", None) or ()))
    return [GGUF_ARCH_AUTO, *names]


def normalize_gguf_arch(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text or GGUF_ARCH_AUTO


@contextlib.contextmanager
def gguf_architecture_hint(arch: Any = GGUF_ARCH_AUTO) -> Iterator[None]:
    """Let ComfyUI-GGUF load a metadata-less GGUF as ``arch`` (or auto + Qwen-Image)."""
    arch = normalize_gguf_arch(arch)
    loader = _gguf_loader_module()
    convert = _gguf_convert_module(loader) if loader is not None else None
    arch_list = getattr(convert, "arch_list", None)
    template = getattr(convert, "ModelTemplate", None)
    if not isinstance(arch_list, list) or template is None:
        yield
        return
    if arch == GGUF_ARCH_AUTO:
        extra = [type("VNCCSQwenImageGGUF", (template,), {"arch": "qwen_image", "keys_detect": list(_QWEN_IMAGE_KEYS)})]
        added = extra
        arch_list.extend(added)
    else:
        allowed = set(getattr(loader, "IMG_ARCH_LIST", ()) or ())
        if allowed and arch not in allowed:
            raise ValueError(f"[VNCCS UniCanvas] ComfyUI-GGUF does not support the GGUF architecture '{arch}'.")
        # An empty key tuple matches every state dict: the user's hint wins over guessing.
        added = [type("VNCCSHintGGUF", (template,), {"arch": arch, "keys_detect": [()]})]
        arch_list[:0] = added
    try:
        yield
    finally:
        for item in added:
            if item in arch_list:
                arch_list.remove(item)
