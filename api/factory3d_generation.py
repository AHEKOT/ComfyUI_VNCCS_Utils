"""Generation providers used by the VNCCS 3D Factory authoring API.

TripoSplat remains implemented by :mod:`factory3d` because it uses the pinned
vendored runtime. Pixal3D and TRELLIS.2 are orchestrated here through the
native comfy-core nodes shipped with current ComfyUI builds. Keeping the mesh
pipeline on those nodes preserves ComfyUI model management and avoids carrying
a second copy of the rapidly evolving TRELLIS.2 runtime in VNCCS-Utils.
"""

from __future__ import annotations

import asyncio
import gc
import inspect
import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

from PIL import Image, ImageOps


TRIPOSPLAT = "triposplat"
PIXAL3D = "pixal3d"
TRELLIS2 = "trellis2"
PROVIDER_KEYS = (TRIPOSPLAT, PIXAL3D, TRELLIS2)
MESH_PROVIDER_KEYS = (PIXAL3D, TRELLIS2)


# Revisions are pinned to the public repository heads used while importing the
# official ComfyUI workflow. Downloads always pass token=False in factory3d.py.
WEIGHT_SPECS: dict[str, dict[str, str]] = {
    "vae/trellis_2_texture_vae_bf16.safetensors": {
        "repo_id": "Comfy-Org/Pixal3D",
        "revision": "e69bd0b6c7b959661a87051187aab18e8e5abcdf",
        "filename": "vae/trellis_2_texture_vae_bf16.safetensors",
    },
    "vae/trellis_2_shape_vae_bf16.safetensors": {
        "repo_id": "Comfy-Org/Pixal3D",
        "revision": "e69bd0b6c7b959661a87051187aab18e8e5abcdf",
        "filename": "vae/trellis_2_shape_vae_bf16.safetensors",
    },
    "clip_vision/dino_v3_L_naf_fp32.safetensors": {
        "repo_id": "Comfy-Org/Pixal3D",
        "revision": "e69bd0b6c7b959661a87051187aab18e8e5abcdf",
        "filename": "clip_vision/dino_v3_L_naf_fp32.safetensors",
    },
    "background_removal/birefnet.safetensors": {
        "repo_id": "Comfy-Org/BiRefNet",
        "revision": "5a1bd8ae750548f8cd42e3c8afa854fd3eba0fb1",
        "filename": "background_removal/birefnet.safetensors",
    },
    "geometry_estimation/moge_2_vitl_normal_fp16.safetensors": {
        "repo_id": "Comfy-Org/MoGe",
        "revision": "14cbe5bcaaab2fcabaccac085b24a82af2669b14",
        "filename": "geometry_estimation/moge_2_vitl_normal_fp16.safetensors",
    },
    "diffusion_models/pixal3d_int8_convrot.safetensors": {
        "repo_id": "Comfy-Org/Pixal3D",
        "revision": "e69bd0b6c7b959661a87051187aab18e8e5abcdf",
        "filename": "diffusion_models/pixal3d_int8_convrot.safetensors",
    },
    "diffusion_models/trellis_2_int8_convrot.safetensors": {
        "repo_id": "Comfy-Org/TRELLIS.2",
        "revision": "463441b1c32829ee876e4f297dcfff533cb357a7",
        "filename": "diffusion_models/trellis_2_int8_convrot.safetensors",
    },
}

_SHARED_MESH_WEIGHTS = (
    "vae/trellis_2_texture_vae_bf16.safetensors",
    "vae/trellis_2_shape_vae_bf16.safetensors",
    "clip_vision/dino_v3_L_naf_fp32.safetensors",
    "background_removal/birefnet.safetensors",
)

PROVIDER_WEIGHT_FILES: dict[str, tuple[str, ...]] = {
    PIXAL3D: (
        *_SHARED_MESH_WEIGHTS,
        "geometry_estimation/moge_2_vitl_normal_fp16.safetensors",
        "diffusion_models/pixal3d_int8_convrot.safetensors",
    ),
    TRELLIS2: (
        *_SHARED_MESH_WEIGHTS,
        "diffusion_models/trellis_2_int8_convrot.safetensors",
    ),
}

_COMMON_MESH_NODES = (
    "ApplyTextureToMesh",
    "BakeAmbientOcclusion",
    "BakeNormalMapFromMesh",
    "BakeTextureFromVoxel",
    "CFGOverride",
    "CLIPVisionLoader",
    "DecimateMesh",
    "EmptyTrellis2LatentStructure",
    "ImageCropToMask",
    "KSampler",
    "LoadBackgroundRemovalModel",
    "MeshSmoothNormals",
    "MeshToFile3D",
    "ModelSamplingSD3",
    "RemeshMesh",
    "RemoveBackground",
    "RescaleCFG",
    "Trellis2ShapeStage",
    "Trellis2TextureStage",
    "Trellis2UpsampleStage",
    "UNETLoader",
    "UnwrapMesh",
    "VAELoader",
    "VaeDecodeShapeTrellis",
    "VaeDecodeStructureTrellis2",
    "VaeDecodeTextureTrellis",
)

PROVIDER_NODE_TYPES: dict[str, tuple[str, ...]] = {
    PIXAL3D: (
        *_COMMON_MESH_NODES,
        "LoadMoGeModel",
        "MoGeGeometryToFOV",
        "MoGeInference",
        "Pixal3DConditioning",
    ),
    TRELLIS2: (*_COMMON_MESH_NODES, "Trellis2Conditioning"),
}

QUALITY_PRESETS: dict[str, dict[str, int]] = {
    "preview": {
        "target_resolution": 1024,
        "remesh_resolution": 384,
        "target_face_count": 150_000,
        "texture_resolution": 1024,
        "normal_resolution": 1024,
        "ao_resolution": 512,
        "ao_samples": 32,
    },
    "balanced": {
        "target_resolution": 1536,
        "remesh_resolution": 512,
        "target_face_count": 350_000,
        "texture_resolution": 2048,
        "normal_resolution": 1024,
        "ao_resolution": 512,
        "ao_samples": 48,
    },
    "high": {
        "target_resolution": 1536,
        "remesh_resolution": 768,
        "target_face_count": 700_000,
        "texture_resolution": 4096,
        "normal_resolution": 2048,
        "ao_resolution": 1024,
        "ao_samples": 64,
    },
}

MESH_DEFAULTS: dict[str, Any] = {
    "quality": "high",
    "structure_steps": 12,
    "shape_steps": 20,
    "upsample_steps": 12,
    "texture_steps": 12,
    "remove_background": True,
    "seed": -1,
}

PROVIDER_PUBLIC: dict[str, dict[str, Any]] = {
    TRIPOSPLAT: {
        "key": TRIPOSPLAT,
        "name": "TripoSplat",
        "output_kind": "gaussian",
        "output_format": "ply",
        "output_label": "Gaussian PLY",
        "description": "Gaussian splat generation with adjustable density.",
    },
    PIXAL3D: {
        "key": PIXAL3D,
        "name": "Pixal3D",
        "output_kind": "mesh",
        "output_format": "glb",
        "output_label": "Textured GLB",
        "description": "Camera-aware mesh generation with baked PBR textures.",
    },
    TRELLIS2: {
        "key": TRELLIS2,
        "name": "TRELLIS.2",
        "output_kind": "mesh",
        "output_format": "glb",
        "output_label": "Textured GLB",
        "description": "TRELLIS.2 mesh generation with baked PBR textures.",
    },
}


def normalize_provider(value: Any) -> str:
    key = str(value or TRIPOSPLAT).strip().lower()
    if key not in PROVIDER_KEYS:
        raise ValueError("generator must be triposplat, pixal3d, or trellis2")
    return key


def normalize_mesh_settings(values: Any) -> dict[str, Any]:
    data = values if hasattr(values, "get") else {}
    quality = str(data.get("quality", MESH_DEFAULTS["quality"])).strip().lower()
    if quality not in QUALITY_PRESETS:
        raise ValueError("quality must be preview, balanced, or high")
    preset = QUALITY_PRESETS[quality]

    def bounded_int(key: str, default: int, minimum: int, maximum: int) -> int:
        return max(minimum, min(maximum, int(data.get(key, default))))

    remove_background = str(data.get("remove_background", "1")).strip().lower() in {
        "1", "true", "yes", "on",
    }
    return {
        "provider": normalize_provider(data.get("provider")),
        "quality": quality,
        "structure_steps": bounded_int("structure_steps", 12, 1, 100),
        "shape_steps": bounded_int("shape_steps", 20, 1, 100),
        "upsample_steps": bounded_int("upsample_steps", 12, 1, 100),
        "texture_steps": bounded_int("texture_steps", 12, 1, 100),
        "target_resolution": preset["target_resolution"],
        "remesh_resolution": preset["remesh_resolution"],
        "target_face_count": preset["target_face_count"],
        "texture_resolution": preset["texture_resolution"],
        "normal_resolution": preset["normal_resolution"],
        "ao_resolution": preset["ao_resolution"],
        "ao_samples": preset["ao_samples"],
        "remove_background": remove_background,
        "seed": max(-1, min(2**31 - 1, int(data.get("seed", -1)))),
    }


def runtime_status(provider: Any) -> dict[str, Any]:
    key = normalize_provider(provider)
    if key == TRIPOSPLAT:
        return {"ready": True, "missing_nodes": []}
    try:
        import nodes as comfy_nodes

        mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}) or {}
        missing = [name for name in PROVIDER_NODE_TYPES[key] if name not in mappings]
        return {"ready": not missing, "missing_nodes": missing}
    except Exception as exc:
        return {"ready": False, "missing_nodes": list(PROVIDER_NODE_TYPES[key]), "error": str(exc)}


def _unwrap_node_output(value: Any) -> tuple[Any, ...]:
    block = getattr(value, "block_execution", None)
    if block:
        raise RuntimeError(str(block))
    if hasattr(value, "result") and hasattr(value, "args"):
        value = value.result
    elif isinstance(value, dict) and "result" in value:
        value = value["result"]
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    return (value,)


def _node_input_names(node_cls: Any) -> set[str]:
    input_types = getattr(node_cls, "INPUT_TYPES", None)
    if input_types is None:
        return set()
    try:
        schema = input_types()
    except Exception:
        return set()
    names: set[str] = set()
    if isinstance(schema, dict):
        for section in ("required", "optional", "hidden"):
            values = schema.get(section)
            if isinstance(values, dict):
                names.update(str(name) for name in values)
    return names


def _call_node(node_type: str, **kwargs: Any) -> tuple[Any, ...]:
    import nodes as comfy_nodes

    mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {}) or {}
    node_cls = mappings.get(node_type)
    if node_cls is None:
        raise RuntimeError(
            f"Required comfy-core node '{node_type}' is unavailable. Update ComfyUI and restart it."
        )
    prepare_clone = getattr(node_cls, "PREPARE_CLASS_CLONE", None)
    if callable(prepare_clone):
        node_cls = prepare_clone(None)
    instance = node_cls()
    method_name = getattr(node_cls, "FUNCTION", None)
    method = getattr(instance, method_name, None) if method_name else None
    if method is None:
        method = getattr(instance, "execute", None)
    if method is None:
        raise RuntimeError(f"ComfyUI node '{node_type}' has no callable execution method")

    signature = inspect.signature(method)
    accepts_kwargs = any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    )
    declared = _node_input_names(node_cls)
    if declared:
        accepted = {key: value for key, value in kwargs.items() if key in declared}
    elif accepts_kwargs:
        accepted = dict(kwargs)
    else:
        accepted = {key: value for key, value in kwargs.items() if key in signature.parameters}

    def invoke() -> Any:
        result = method(**accepted)
        if inspect.isawaitable(result):
            return asyncio.run(result)
        return result

    try:
        return _unwrap_node_output(invoke())
    except AttributeError as exc:
        if not any(
            marker in str(exc)
            for marker in (
                "'NoneType' object has no attribute 'node_id'",
                "'NoneType' object has no attribute 'unique_id'",
            )
        ):
            raise
        module = inspect.getmodule(node_cls) or inspect.getmodule(method)
        context_getter = getattr(module, "get_executing_context", None) if module else None
        if context_getter is None:
            raise
        setattr(module, "get_executing_context", lambda: SimpleNamespace(node_id=f"vnccs-factory-{node_type}"))
        try:
            return _unwrap_node_output(invoke())
        finally:
            setattr(module, "get_executing_context", context_getter)


def _image_tensor(image: Image.Image) -> tuple[Any, Any]:
    import numpy as np
    import torch

    rgba = ImageOps.exif_transpose(image).convert("RGBA")
    array = np.asarray(rgba, dtype=np.float32) / 255.0
    rgb = torch.from_numpy(array[..., :3].copy()).unsqueeze(0)
    alpha = torch.from_numpy(array[..., 3].copy()).unsqueeze(0)
    return rgb, alpha


def _save_prepared_image(tensor: Any, target: Path) -> None:
    import numpy as np

    value = tensor[0].detach().float().cpu().clamp(0.0, 1.0).numpy()
    array = np.rint(value * 255.0).astype(np.uint8)
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(array, mode="RGB").save(target, format="PNG", optimize=True)


def _seed(value: int, offset: int) -> int:
    return (int(value) + int(offset)) % (2**31 - 1)


def _sampler(
    model: Any,
    positive: Any,
    negative: Any,
    latent: Any,
    *,
    seed: int,
    steps: int,
    cfg: float,
    scheduler: str,
) -> Any:
    return _call_node(
        "KSampler",
        model=model,
        seed=seed,
        steps=steps,
        cfg=cfg,
        sampler_name="euler",
        scheduler=scheduler,
        positive=positive,
        negative=negative,
        latent_image=latent,
        denoise=1.0,
    )[0]


def _save_file3d(value: Any, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if hasattr(value, "save_to"):
        value.save_to(str(target))
    elif hasattr(value, "get_bytes"):
        target.write_bytes(value.get_bytes())
    elif isinstance(value, (bytes, bytearray, memoryview)):
        target.write_bytes(bytes(value))
    elif isinstance(value, (str, Path)):
        source = Path(value).resolve()
        if not source.is_file():
            raise FileNotFoundError("ComfyUI returned a missing GLB file")
        shutil.copy2(source, target)
    else:
        raise RuntimeError("ComfyUI returned an unsupported File3D result")
    with target.open("rb") as handle:
        magic = handle.read(4)
    if target.stat().st_size < 20 or magic != b"glTF":
        raise RuntimeError("Pixal3D/TRELLIS.2 produced an invalid GLB file")


def run_mesh_generation(
    provider: str,
    image: Image.Image,
    target_glb: Path,
    prepared_path: Path,
    settings: dict[str, Any],
    *,
    emit: Callable[[str, float, str, str], None],
    check_cancel: Callable[[], None],
) -> dict[str, Any]:
    """Run the official Pixal3D/TRELLIS.2 graph and materialize its GLB."""
    key = normalize_provider(provider)
    if key not in MESH_PROVIDER_KEYS:
        raise ValueError("mesh generation requires pixal3d or trellis2")
    status = runtime_status(key)
    if not status["ready"]:
        raise RuntimeError(
            "This generator requires a newer ComfyUI release. Missing nodes: "
            + ", ".join(status["missing_nodes"])
        )

    check_cancel()
    emit("preprocess", 4, "Preparing the reference image", key)
    source_image, source_alpha = _image_tensor(image)
    if settings["remove_background"]:
        bg_model = _call_node(
            "LoadBackgroundRemovalModel",
            bg_removal_name="birefnet.safetensors",
        )[0]
        mask = _call_node(
            "RemoveBackground",
            bg_removal_model=bg_model,
            image=source_image,
        )[0]
    else:
        mask = source_alpha
        if float(mask.max().item()) <= 0.0:
            mask = mask.new_ones(mask.shape)
    prepared = _call_node(
        "ImageCropToMask",
        images=source_image,
        masks=mask,
        width=1024,
        height=1024,
        pad_factor=1.1,
        grow_mask=0,
        background="#000000",
    )[0]
    _save_prepared_image(prepared, prepared_path)
    check_cancel()

    emit("models", 10, "Loading shared Pixal3D/TRELLIS.2 components", key)
    clip = _call_node(
        "CLIPVisionLoader",
        clip_name="dino_v3_L_naf_fp32.safetensors",
    )[0]
    shape_vae = _call_node(
        "VAELoader",
        vae_name="trellis_2_shape_vae_bf16.safetensors",
    )[0]
    texture_vae = _call_node(
        "VAELoader",
        vae_name="trellis_2_texture_vae_bf16.safetensors",
    )[0]
    unet_name = (
        "pixal3d_int8_convrot.safetensors"
        if key == PIXAL3D
        else "trellis_2_int8_convrot.safetensors"
    )
    model = _call_node("UNETLoader", unet_name=unet_name, weight_dtype="default")[0]
    check_cancel()

    emit("conditioning", 18, "Encoding model conditioning", key)
    if key == PIXAL3D:
        moge = _call_node(
            "LoadMoGeModel",
            model_name="moge_2_vitl_normal_fp16.safetensors",
        )[0]
        geometry = _call_node(
            "MoGeInference",
            moge_model=moge,
            image=prepared,
            resolution_level=9,
            fov_x_degrees=0.0,
            batch_size=4,
            force_projection=True,
            apply_mask=True,
        )[0]
        fov = _call_node(
            "MoGeGeometryToFOV",
            moge_geometry=geometry,
            axis="horizontal",
            unit="degrees",
        )[0]
        positive, negative = _call_node(
            "Pixal3DConditioning",
            clip_vision_model=clip,
            image=prepared,
            camera_angle_x=fov,
        )[:2]
    else:
        positive, negative = _call_node(
            "Trellis2Conditioning",
            clip_vision_model=clip,
            image=prepared,
        )[:2]
    check_cancel()

    structure_model = _call_node(
        "CFGOverride", model=model, cfg=1.0, start_percent=0.667, end_percent=1.0,
    )[0]
    structure_model = _call_node("RescaleCFG", model=structure_model, multiplier=0.7)[0]
    structure_model = _call_node("ModelSamplingSD3", model=structure_model, shift=5.0)[0]
    shape_model = _call_node(
        "CFGOverride", model=model, cfg=1.0, start_percent=0.769, end_percent=1.0,
    )[0]
    shape_model = _call_node("RescaleCFG", model=shape_model, multiplier=0.5)[0]

    base_seed = int(settings["seed"])
    emit("structure", 27, "Generating sparse structure", f"{settings['structure_steps']} steps")
    structure_latent = _call_node("EmptyTrellis2LatentStructure", batch_size=1)[0]
    structure_sample = _sampler(
        structure_model,
        positive,
        negative,
        structure_latent,
        seed=_seed(base_seed, 0),
        steps=settings["structure_steps"],
        cfg=7.5,
        scheduler="normal",
    )
    voxel = _call_node(
        "VaeDecodeStructureTrellis2",
        samples=structure_sample,
        vae=shape_vae,
        resolution="32",
    )[0]
    check_cancel()

    emit("shape", 43, "Generating the first shape stage", f"{settings['shape_steps']} steps")
    shape_positive, shape_negative, shape_latent = _call_node(
        "Trellis2ShapeStage",
        positive=positive,
        negative=negative,
        voxel=voxel,
    )[:3]
    shape_sample = _sampler(
        shape_model,
        shape_positive,
        shape_negative,
        shape_latent,
        seed=_seed(base_seed, 1),
        steps=settings["shape_steps"],
        cfg=7.5,
        scheduler="normal",
    )
    check_cancel()

    emit(
        "upsample",
        57,
        "Upsampling shape detail",
        f"target {settings['target_resolution']}",
    )
    up_positive, up_negative, up_latent = _call_node(
        "Trellis2UpsampleStage",
        positive=shape_positive,
        negative=shape_negative,
        shape_latent=shape_sample,
        vae=shape_vae,
        target_resolution=settings["target_resolution"],
    )[:3]
    upsampled = _sampler(
        shape_model,
        up_positive,
        up_negative,
        up_latent,
        seed=_seed(base_seed, 2),
        steps=settings["upsample_steps"],
        cfg=7.5,
        scheduler="simple",
    )
    mesh, shape_subdivides = _call_node(
        "VaeDecodeShapeTrellis",
        samples=upsampled,
        vae=shape_vae,
    )[:2]
    check_cancel()

    emit("texture", 67, "Generating material textures", f"{settings['texture_steps']} steps")
    tex_positive, tex_negative, tex_latent = _call_node(
        "Trellis2TextureStage",
        positive=up_positive,
        negative=up_negative,
        shape_latent=upsampled,
    )[:3]
    texture_sample = _sampler(
        model,
        tex_positive,
        tex_negative,
        tex_latent,
        seed=_seed(base_seed, 3),
        steps=settings["texture_steps"],
        cfg=1.0,
        scheduler="normal",
    )
    voxel_colors = _call_node(
        "VaeDecodeTextureTrellis",
        samples=texture_sample,
        vae=texture_vae,
        shape_subdivides=shape_subdivides,
    )[0]
    check_cancel()

    emit(
        "mesh",
        76,
        "Remeshing and reducing geometry",
        f"{settings['target_face_count']:,} face target",
    )
    high_poly = _call_node(
        "RemeshMesh",
        mesh=mesh,
        resolution=settings["remesh_resolution"],
        sign_mode={
            "sign_mode": "udf",
            "qef": False,
            "drop_inverted_components": False,
            "drop_enclosed_components": False,
        },
        band=1.0,
        project_back=0.0,
        fix_poles=False,
        smooth_iters=20,
        drop_small_components=0.01,
        precluster_max_verts=20_000_000,
    )[0]
    low_poly = _call_node(
        "DecimateMesh",
        mesh=high_poly,
        target_face_count=settings["target_face_count"],
        placement_mode={"placement_mode": "midpoint"},
    )[0]
    low_poly = _call_node("MeshSmoothNormals", mesh=low_poly, crease_angle=180.0)[0]
    low_poly = _call_node(
        "UnwrapMesh",
        mesh=low_poly,
        segmenter="pec",
        resolution=settings["texture_resolution"],
        padding=1,
        weld_distance=0.0002,
    )[0]
    check_cancel()

    emit(
        "bake",
        86,
        "Baking PBR textures",
        f"{settings['texture_resolution']} texture atlas",
    )
    base_color, metallic, roughness = _call_node(
        "BakeTextureFromVoxel",
        mesh=low_poly,
        voxel_colors=voxel_colors,
        reference_mesh=mesh,
        texture_size=settings["texture_resolution"],
    )[:3]
    normal_map = _call_node(
        "BakeNormalMapFromMesh",
        low_poly=low_poly,
        high_poly=high_poly,
        resolution=settings["normal_resolution"],
        cage_distance=0.05,
        ignore_backfaces=True,
    )[0]
    occlusion = _call_node(
        "BakeAmbientOcclusion",
        low_poly=low_poly,
        high_poly=high_poly,
        resolution=settings["ao_resolution"],
        samples=settings["ao_samples"],
        max_distance=0.71,
        strength=1.0,
        bias=0.01,
    )[0]
    textured = _call_node(
        "ApplyTextureToMesh",
        mesh=low_poly,
        base_color=base_color,
        metallic=metallic,
        roughness=roughness,
        occlusion=occlusion,
        normal_map=normal_map,
    )[0]
    textured = _call_node("MeshSmoothNormals", mesh=textured, crease_angle=180.0)[0]
    check_cancel()

    emit("serialize", 96, "Serializing textured GLB", key)
    file3d = _call_node("MeshToFile3D", mesh=textured)[0]
    _save_file3d(file3d, target_glb)
    file_size = target_glb.stat().st_size
    emit("validate", 98, "Validated textured GLB", f"{file_size:,} bytes")

    del file3d, textured, low_poly, high_poly, mesh, voxel_colors
    gc.collect()
    try:
        import comfy.model_management as model_management

        model_management.soft_empty_cache()
    except Exception:
        pass
    return {
        "provider": key,
        "format": "glb",
        "size": file_size,
        "prepared_width": int(prepared.shape[2]),
        "prepared_height": int(prepared.shape[1]),
    }
