"""Model loaders (checkpoint, diffusion model, GGUF, external) and the loaded-model cache."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .comfy_bridge import _call_loader_node
from .gguf_compat import gguf_architecture_hint, normalize_gguf_arch
from .locks import _COMFY_MODEL_OP_LOCK, _MODEL_CACHE_LOCK
from .paths import _get_full_path_agnostic, _resolve_model_filename
from .performance import apply_vae_chunking


_MODEL_CACHE_MAX_ENTRIES = 1
_MODEL_CACHE: dict[Any, tuple[Any, Any, Any]] = {}


@dataclass(frozen=True)
class UniCanvasModelLoader:
    key: str
    aliases: tuple[str, ...]
    forced_mode: str | None = None

    def cache_key(self, gen_settings: dict[str, Any]) -> tuple[Any, ...]:
        raise NotImplementedError

    def load_assets(self, gen_settings: dict[str, Any]):
        raise NotImplementedError


@dataclass(frozen=True)
class CheckpointUniCanvasLoader(UniCanvasModelLoader):
    def cache_key(self, gen_settings: dict[str, Any]) -> tuple[Any, ...]:
        return (self.key, str(gen_settings.get("ckpt_name") or ""))

    def load_assets(self, gen_settings: dict[str, Any]):
        import comfy.sd
        import folder_paths

        ckpt_name = _resolve_model_filename(folder_paths, "checkpoints", gen_settings.get("ckpt_name"))
        if not ckpt_name:
            raise ValueError("Checkpoint is required")
        ckpt_path = _get_full_path_agnostic(folder_paths, "checkpoints", ckpt_name, require_exists=True)
        if not ckpt_path:
            raise ValueError(f"Checkpoint path not found for '{ckpt_name}'")
        out = comfy.sd.load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        assets = out[:3]
        if any(item is None for item in assets):
            raise ValueError(f"Failed to load checkpoint assets from '{ckpt_name}'")
        return assets


@dataclass(frozen=True)
class DiffusionModelUniCanvasLoader(UniCanvasModelLoader):
    def cache_key(self, gen_settings: dict[str, Any]) -> tuple[Any, ...]:
        return (
            self.key,
            gen_settings.get("diffusion_model_name", ""),
            gen_settings.get("clip_name", ""),
            gen_settings.get("vae_name", ""),
            gen_settings.get("clip_type", ""),
        )

    def load_assets(self, gen_settings: dict[str, Any]):
        import comfy.sd
        import folder_paths

        # Default/preset names without a subfolder resolve to the installed file.
        diffusion_model_name = _resolve_model_filename(folder_paths, "diffusion_models", gen_settings.get("diffusion_model_name"))
        clip_name = _resolve_model_filename(folder_paths, "text_encoders", gen_settings.get("clip_name"))
        vae_name = _resolve_model_filename(folder_paths, "vae", gen_settings.get("vae_name"))
        clip_type_name = str(gen_settings.get("clip_type", "stable_diffusion") or "stable_diffusion").lower()

        if gen_settings.get("generation_mode") == "krea2_edit" and not hasattr(comfy.sd.CLIPType, "KREA2"):
            raise ValueError("Krea2 Edit requires native Krea2 and Qwen3-VL support. Update ComfyUI before using this preset.")

        if not diffusion_model_name:
            raise ValueError("No Diffusion Model selected for UniCanvas")
        if not clip_name:
            raise ValueError("No CLIP selected for UniCanvas")
        if not vae_name:
            raise ValueError("No VAE selected for UniCanvas")

        model = _call_loader_node(
            ["UNETLoader", "Load Diffusion Model"],
            ["load_unet", "load_model", "load_diffusion_model"],
            unet_name=diffusion_model_name,
            model_name=diffusion_model_name,
            diffusion_model_name=diffusion_model_name,
            weight_dtype="default",
        )
        if model is None and hasattr(comfy.sd, "load_diffusion_model"):
            diffusion_model_path = _get_full_path_agnostic(folder_paths, "diffusion_models", diffusion_model_name)
            if diffusion_model_path:
                model = comfy.sd.load_diffusion_model(diffusion_model_path)

        clip = _call_loader_node(
            ["CLIPLoader", "Load CLIP"],
            ["load_clip", "load_model"],
            clip_name=clip_name,
            model_name=clip_name,
            type=clip_type_name,
            device="default",
        )
        if clip is None and hasattr(comfy.sd, "load_clip"):
            clip_path = _get_full_path_agnostic(folder_paths, "text_encoders", clip_name)
            if clip_path:
                clip_type = getattr(comfy.sd.CLIPType, clip_type_name.upper(), None)
                if clip_type is None:
                    raise ValueError(
                        f"ComfyUI CLIPType.{clip_type_name.upper()} is not available. "
                        "ANIMA expects CLIPLoader type 'stable_diffusion'."
                    )
                clip = comfy.sd.load_clip(
                    ckpt_paths=[clip_path],
                    embedding_directory=folder_paths.get_folder_paths("embeddings"),
                    clip_type=clip_type,
                )

        vae = _call_loader_node(
            ["VAELoader", "Load VAE"],
            ["load_vae", "load_model"],
            vae_name=vae_name,
            model_name=vae_name,
        )
        if vae is None and hasattr(comfy.sd, "load_vae"):
            vae_path = _get_full_path_agnostic(folder_paths, "vae", vae_name)
            if vae_path:
                vae = comfy.sd.load_vae(vae_path)

        if model is None:
            raise ValueError(f"Failed to load Diffusion Model '{diffusion_model_name}'")
        if clip is None:
            raise ValueError(f"Failed to load CLIP '{clip_name}'")
        if vae is None:
            raise ValueError(f"Failed to load VAE '{vae_name}'")
        return model, clip, vae


@dataclass(frozen=True)
class GGUFUniCanvasLoader(DiffusionModelUniCanvasLoader):
    def cache_key(self, gen_settings: dict[str, Any]) -> tuple[Any, ...]:
        return (
            self.key,
            gen_settings.get("gguf_model_name", ""),
            normalize_gguf_arch(gen_settings.get("gguf_arch")),
            gen_settings.get("clip_name", ""),
            gen_settings.get("vae_name", ""),
            gen_settings.get("clip_type", ""),
        )

    def load_assets(self, gen_settings: dict[str, Any]):
        import comfy.sd
        import folder_paths

        gguf_model_name = _resolve_model_filename(folder_paths, ("unet_gguf", "unet", "diffusion_models"), gen_settings.get("gguf_model_name"))
        clip_name = _resolve_model_filename(folder_paths, "text_encoders", gen_settings.get("clip_name"))
        vae_name = _resolve_model_filename(folder_paths, "vae", gen_settings.get("vae_name"))
        clip_type_name = str(gen_settings.get("clip_type", "stable_diffusion") or "stable_diffusion").lower()

        if not gguf_model_name:
            raise ValueError("No GGUF model selected for UniCanvas")
        if not clip_name:
            raise ValueError("No CLIP selected for UniCanvas")
        if not vae_name:
            raise ValueError("No VAE selected for UniCanvas")

        # Metadata-less (sd.cpp style) GGUF files: the user's Architecture pick, or auto with
        # Qwen-Image detection that ComfyUI-GGUF lacks (see gguf_compat).
        with gguf_architecture_hint(gen_settings.get("gguf_arch")):
            model = _call_loader_node(
                ["UnetLoaderGGUF", "UNETLoaderGGUF", "GGUF Loader"],
                ["load_unet", "load_model", "load_diffusion_model"],
                unet_name=gguf_model_name,
                model_name=gguf_model_name,
                diffusion_model_name=gguf_model_name,
                weight_dtype="default",
            )
        if model is None:
            raise ValueError(
                "Failed to load GGUF model. Install/enable a GGUF loader node such as ComfyUI-GGUF "
                f"and select a valid GGUF model; current model is '{gguf_model_name}'."
            )

        clip = _call_loader_node(
            ["CLIPLoader", "Load CLIP"],
            ["load_clip", "load_model"],
            clip_name=clip_name,
            model_name=clip_name,
            type=clip_type_name,
            device="default",
        )
        if clip is None and hasattr(comfy.sd, "load_clip"):
            clip_path = _get_full_path_agnostic(folder_paths, "text_encoders", clip_name)
            if clip_path:
                clip_type = getattr(comfy.sd.CLIPType, clip_type_name.upper(), None)
                if clip_type is None:
                    raise ValueError(f"ComfyUI CLIPType.{clip_type_name.upper()} is not available.")
                clip = comfy.sd.load_clip(
                    ckpt_paths=[clip_path],
                    embedding_directory=folder_paths.get_folder_paths("embeddings"),
                    clip_type=clip_type,
                )

        vae = _call_loader_node(
            ["VAELoader", "Load VAE"],
            ["load_vae", "load_model"],
            vae_name=vae_name,
            model_name=vae_name,
        )
        if vae is None and hasattr(comfy.sd, "load_vae"):
            vae_path = _get_full_path_agnostic(folder_paths, "vae", vae_name)
            if vae_path:
                vae = comfy.sd.load_vae(vae_path)

        if clip is None:
            raise ValueError(f"Failed to load CLIP '{clip_name}'")
        if vae is None:
            raise ValueError(f"Failed to load VAE '{vae_name}'")
        return model, clip, vae


class ExternalUniCanvasLoader(UniCanvasModelLoader):
    """Pass-through loader for a VNCSS_CONFIG model block."""

    key = "external"
    aliases: tuple[str, ...] = ()

    def __init__(self, forced_mode: str | None = None):
        # UniCanvasModelLoader is a frozen dataclass, so its generated
        # __setattr__ rejects plain field assignment on subclasses.
        object.__setattr__(self, "forced_mode", forced_mode)

    def cache_key(self, gen_settings: dict[str, Any]) -> tuple[Any, ...]:
        return (self.key, "external")

    def load_assets(self, gen_settings: dict[str, Any]):
        external = (gen_settings or {}).get("_external") or {}
        model = external.get("model")
        clip = external.get("clip")
        vae = external.get("vae")
        if model is None or clip is None or vae is None:
            raise RuntimeError("[VNCCS UniCanvas] External model block is missing.")
        return model, clip, vae

    def load(self, gen_settings: dict[str, Any], draw_id: str = "unknown"):
        """Direct call entry point; delegates to the pipeline's load_assets()."""
        return self.load_assets(gen_settings)


UNICANVAS_MODEL_LOADERS: dict[str, UniCanvasModelLoader] = {}


def _register_unicanvas_model_loader(loader: UniCanvasModelLoader) -> None:
    UNICANVAS_MODEL_LOADERS[loader.key] = loader
    for alias in loader.aliases:
        UNICANVAS_MODEL_LOADERS[alias] = loader


_register_unicanvas_model_loader(CheckpointUniCanvasLoader("checkpoint", ("ckpt",), forced_mode="sdxl"))
_register_unicanvas_model_loader(DiffusionModelUniCanvasLoader("diffusion_model", ("unet", "diffusion"), forced_mode=None))
_register_unicanvas_model_loader(GGUFUniCanvasLoader("gguf", (), forced_mode=None))
_register_unicanvas_model_loader(ExternalUniCanvasLoader())


def _get_unicanvas_model_loader(loader_type: str | None) -> UniCanvasModelLoader:
    key = str(loader_type or "checkpoint").lower()
    loader = UNICANVAS_MODEL_LOADERS.get(key)
    if loader is None:
        supported = sorted({loader.key for loader in UNICANVAS_MODEL_LOADERS.values()})
        raise ValueError(f"Unsupported UniCanvas model loader '{key}'. Supported loaders: {', '.join(supported)}")
    return loader


def _peek_cached_generation_assets(gen_settings: dict[str, Any]):
    """The (model, clip, vae) already loaded for these settings, or None; never loads anything."""
    loader = _get_unicanvas_model_loader(str(gen_settings.get("model_loader") or "checkpoint").lower())
    if loader.key == "external":
        return None
    with _MODEL_CACHE_LOCK:
        return _MODEL_CACHE.get(loader.cache_key(gen_settings))


def _load_generation_assets(gen_settings: dict[str, Any]):
    """(model, clip, vae) for the settings; the VAE runs chunked when "vae_chunking" is on."""
    model, clip, vae = _load_generation_assets_cached(gen_settings)
    return model, clip, apply_vae_chunking(vae, gen_settings)


def _load_generation_assets_cached(gen_settings: dict[str, Any]):
    loader = _get_unicanvas_model_loader(str(gen_settings.get("model_loader") or "checkpoint").lower())
    if loader.key == "external":
        # The external pass-through loader returns the caller's own VNCSS_CONFIG block, so its
        # assets cannot be keyed by the loader alone: caching them under a constant key would make
        # a later external draw reuse the first draw's model/clip/vae. Bypass _MODEL_CACHE entirely.
        return loader.load_assets(gen_settings)
    asset_key = loader.cache_key(gen_settings)
    with _COMFY_MODEL_OP_LOCK:
        with _MODEL_CACHE_LOCK:
            cached = _MODEL_CACHE.get(asset_key)
            if cached is not None:
                return cached
            if len(_MODEL_CACHE) >= _MODEL_CACHE_MAX_ENTRIES:
                _MODEL_CACHE.clear()
        assets = loader.load_assets(gen_settings)
        with _MODEL_CACHE_LOCK:
            _MODEL_CACHE[asset_key] = assets
        return assets
