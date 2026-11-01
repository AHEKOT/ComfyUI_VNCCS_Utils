"""Camera-based PBR texture refinement for the 3D Factory mesh pipeline.

TRELLIS.2 and Pixal3D bake voxel colors into a UV atlas, which leaves seams and
invents detail on surfaces the reference image never showed. When the optional
texture pass is enabled, this module ray-renders the textured mesh from four
orbit cameras, refines every view with the installed Qwen Image 2.1 stack (the
same comfy-core sequence the main VNCCS Control Center uses), and projects the
refined views back into the atlas. No Blender is involved and no extra prompts
are invented: the single master prompt describes the character, and the prepared
reference image anchors its appearance across views.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Callable

from PIL import Image

from .generation import _call_node, _image_tensor, _save_prepared_image, _seed, _sampler

QI2_DIFFUSION_MODEL = "qwen_image_2.1_int8_convrot.safetensors"
QI2_TEXT_ENCODER = "qwen3vl_8b_int8_convrot.safetensors"
QI2_VAE = "qwen_image_2.1_vae_bf16.safetensors"

QI2_WEIGHT_FILES = (
    f"diffusion_models/{QI2_DIFFUSION_MODEL}",
    f"text_encoders/{QI2_TEXT_ENCODER}",
    f"vae/{QI2_VAE}",
)

VIEW_LABELS = ("front", "right", "back", "left")
VIEW_AZIMUTHS = (0.0, 90.0, 180.0, 270.0)
VIEW_ELEVATION_DEGREES = 12.0
VIEW_FOV_RADIANS = math.radians(40.0)
VIEW_RESOLUTION = 1024
REFINE_STEPS = 20
REFINE_CFG = 1.0

TEXTURE_DEFAULTS: dict[str, Any] = {
    "texture_pass": False,
    "texture_prompt": "",
    "texture_strength": 0.6,
}

PROMPT_TEMPLATE = (
    "Edit image 1 as the canvas. Preserve its exact camera viewpoint, "
    "framing, subject orientation, pose, silhouette, proportions, and "
    "background. Apply this instruction: {master_prompt} "
    "Transfer the identity, styling, colors, materials, and surface details "
    "from image 2, fitting them to the visible surfaces of image 1."
)


def normalize_texture_settings(values: Any) -> dict[str, Any]:
    data = values if hasattr(values, "get") else {}
    enabled = str(data.get("texture_pass", "0")).strip().lower() in {
        "1", "true", "yes", "on",
    }
    prompt = str(data.get("texture_prompt", TEXTURE_DEFAULTS["texture_prompt"]))[:2000]
    if enabled and not prompt.strip():
        raise ValueError("texture_pass requires a master prompt")
    strength = float(data.get("texture_strength", TEXTURE_DEFAULTS["texture_strength"]))
    if not math.isfinite(strength):
        strength = TEXTURE_DEFAULTS["texture_strength"]
    return {
        "texture_pass": enabled,
        "texture_prompt": prompt,
        "texture_strength": max(0.1, min(1.0, strength)),
    }


def build_view_plan(
    center: tuple[float, float, float],
    radius: float,
) -> list[tuple[str, tuple[float, float, float], float]]:
    """Orbit camera positions matching RenderMesh framing (Y-up, fov 40, 1.04 margin)."""
    distance = radius / math.tan(VIEW_FOV_RADIANS / 2.0) * 1.04
    elevation = math.radians(VIEW_ELEVATION_DEGREES)
    plan = []
    for label, azimuth_degrees in zip(VIEW_LABELS, VIEW_AZIMUTHS):
        azimuth = math.radians(azimuth_degrees)
        offset = (
            math.cos(elevation) * math.sin(azimuth),
            math.sin(elevation),
            math.cos(elevation) * math.cos(azimuth),
        )
        plan.append((label, tuple(center[axis] + offset[axis] * distance for axis in range(3)), distance))
    return plan


def build_texture_prompt(master_prompt: str) -> str:
    return PROMPT_TEMPLATE.format(master_prompt=master_prompt.strip())



def run_texture_pass(
    mesh: Any,
    settings: dict[str, Any],
    output_dir: Path,
    prepared_path: Path,
    seed: int,
    *,
    emit: Callable[[str, float, str, str], None],
    check_cancel: Callable[[], None],
) -> tuple[Any, list[dict[str, str]]]:
    """Refine the mesh base color atlas from four orbit views.

    Returns a [1, H, W, 3] CPU tensor and per-view records with the saved PNG
    file names so the editor can show the construction process.
    """
    import torch

    try:
        import comfy_extras.nodes_mesh_postprocess as mesh_post
        import comfy_extras.nodes_save_3d as mesh_save
        import comfy.model_management as model_management
    except ImportError:
        raise RuntimeError(
            "Texture refinement requires the comfy-core mesh nodes. Update ComfyUI and restart it."
        ) from None

    atlas = getattr(mesh, "texture", None)
    if atlas is None:
        raise RuntimeError("Texture refinement needs the baked texture atlas")
    atlas = atlas[0]
    texture_size = int(atlas.shape[0])
    if int(atlas.shape[1]) != texture_size or texture_size < 16:
        raise RuntimeError("Texture refinement expects a square texture atlas")

    vertices, faces, _colors, uvs, normals = mesh_save.get_mesh_batch_item(mesh, 0)
    if normals is None:
        raise RuntimeError("Texture refinement needs mesh normals")
    device = model_management.get_torch_device()
    vertices_d = vertices.to(device).float()
    faces_d = faces.to(device).long()
    uvs_d = uvs.to(device).float()
    normals_d = normals.to(device).float()
    triangles = vertices_d[faces_d]
    atlas_d = atlas.to(device).float()

    center = (vertices_d.min(dim=0).values + vertices_d.max(dim=0).values) * 0.5
    radius = float((vertices_d - center).norm(dim=-1).max().item())
    if radius <= 0.0:
        raise RuntimeError("Texture refinement needs a non-empty mesh")
    bvh = mesh_post._build_triangle_bvh(triangles)
    face_index, barycentric, coverage = mesh_post._rasterize_uv_barycentric(
        faces_d.detach().cpu().numpy(),
        uvs_d.detach().cpu().numpy(),
        texture_size,
    )
    face_index = face_index.to(device)
    barycentric = barycentric.to(device)
    covered = coverage.to(device) > 0
    texel_positions = mesh_post._interp_vertex_attr(vertices_d, faces_d, face_index, barycentric, covered)
    texel_normals = mesh_post._interp_vertex_attr(normals_d, faces_d, face_index, barycentric, covered)

    reference = _image_tensor(Image.open(prepared_path))[0].to(device)
    up_hint = torch.tensor([0.0, 1.0, 0.0], device=device)
    tn = math.tan(VIEW_FOV_RADIANS / 2.0)
    occlusion_epsilon = 1e-3 * max(radius, 1.0)

    emit("texture_models", 87, "Loading texture refinement models", "Qwen Image 2.1")
    model = _call_node("UNETLoader", unet_name=QI2_DIFFUSION_MODEL, weight_dtype="default")[0]
    clip = _call_node("CLIPLoader", clip_name=QI2_TEXT_ENCODER, type="qwen_image", device="default")[0]
    vae = _call_node("VAELoader", vae_name=QI2_VAE)[0]
    check_cancel()

    color_sum = torch.zeros((texture_size, texture_size, 3), device=device)
    weight_sum = torch.zeros((texture_size, texture_size), device=device)
    views: list[dict[str, str]] = []
    prompt = build_texture_prompt(settings["texture_prompt"])
    strength = float(settings["texture_strength"])

    for index, (label, eye, _distance) in enumerate(build_view_plan(center.tolist(), radius)):
        check_cancel()
        base_name = f"view_{index}_base.png"
        refined_name = f"view_{index}_refined.png"
        emit(
            f"texture_view_{index}",
            88 + index * 1.5,
            f"Rendering the {label} view",
            f"View {index + 1}/{len(VIEW_LABELS)} · {label}",
        )
        eye_d = torch.tensor(eye, device=device)
        forward, right, up = mesh_post._camera_basis(eye_d, center, up_hint)
        image, _hit, depth = mesh_post._render_view(
            triangles,
            bvh,
            uvs_d,
            faces_d,
            atlas_d,
            eye_d,
            forward,
            right,
            up,
            VIEW_FOV_RADIANS,
            VIEW_RESOLUTION,
            VIEW_RESOLUTION,
        )
        _save_prepared_image(image[None], output_dir / base_name)

        emit(
            f"texture_refined_{index}",
            89 + index * 1.5,
            f"Refining the {label} view",
            f"View {index + 1}/{len(VIEW_LABELS)} · {label}",
        )
        positive, negative, latent = _call_node(
            "TextEncodeQwenImage21",
            clip=clip,
            vae=vae,
            prompt=prompt,
            negative_prompt="",
            resolution=VIEW_RESOLUTION,
            images={"image_1": image[None], "image_2": reference},
        )
        samples = _sampler(
            model,
            positive,
            negative,
            latent,
            seed=_seed(seed, index),
            steps=REFINE_STEPS,
            cfg=REFINE_CFG,
            scheduler="simple",
        )
        refined = _call_node("VAEDecode", vae=vae, samples=samples)[0]
        _save_prepared_image(refined, output_dir / refined_name)
        views.append({"label": label, "base": base_name, "refined": refined_name})

        delta = texel_positions - eye_d
        along = (delta * forward).sum(dim=-1)
        distance_to_eye = delta.norm(dim=-1)
        facing = (texel_normals * (eye_d - texel_positions)).sum(dim=-1) / distance_to_eye.clamp_min(1e-6)
        grid_x = (delta * right).sum(dim=-1) / (along * tn).clamp_min(1e-6)
        grid_y = (delta * up).sum(dim=-1) / (along * tn).clamp_min(1e-6)
        column = (grid_x + 1.0) * 0.5 * VIEW_RESOLUTION
        row = (1.0 - grid_y) * 0.5 * VIEW_RESOLUTION
        visible = (
            covered
            & (along > 1e-4)
            & (facing > 0.05)
            & (column >= 0.0)
            & (column < VIEW_RESOLUTION)
            & (row >= 0.0)
            & (row < VIEW_RESOLUTION)
        )
        column_index = column.clamp(0, VIEW_RESOLUTION - 1).long()
        row_index = row.clamp(0, VIEW_RESOLUTION - 1).long()
        visible &= distance_to_eye <= depth[row_index, column_index] + occlusion_epsilon
        uv01 = torch.stack(
            (
                ((column + 0.5) / VIEW_RESOLUTION).reshape(-1),
                ((row + 0.5) / VIEW_RESOLUTION).reshape(-1),
            ),
            dim=-1,
        )
        sampled = mesh_post._sample_image01(refined[0].float(), uv01).reshape(texture_size, texture_size, 3)
        weight = torch.where(visible, facing.clamp_min(0.0), torch.zeros_like(facing))
        color_sum += sampled * weight[..., None]
        weight_sum += weight

    del model, clip, vae, reference
    blended = color_sum / weight_sum.clamp_min(1e-6)[..., None]
    # shortcut: hard per-view weights without cross-view feathering or color matching,
    # upgrade to seam feathering if view borders become visible on the atlas.
    refined_atlas = torch.where(
        (weight_sum > 1e-6)[..., None],
        atlas_d * (1.0 - strength) + blended * strength,
        atlas_d,
    )
    return refined_atlas[None].clamp(0.0, 1.0).cpu(), views

