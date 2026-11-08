"""Automatic sequential view generation and visibility-weighted PBR projection."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Callable

from PIL import Image

from .generation import (
    QI2_DIFFUSION_MODEL, QI2_TEXT_ENCODER, QI2_VAE, QI2_WEIGHT_FILES,
    _call_node, _image_tensor, _save_prepared_image, _seed,
    release_runtime_memory,
)
from .materials import extract_materials, refine_material_maps

VIEW_LABELS = ("front", "right", "back", "left", "top", "bottom")
VIEW_FOV_RADIANS = math.radians(40.0)
VIEW_RESOLUTION = 2048
REFINE_STEPS = 8
REFINE_CFG = 1.0
TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0"
MAX_EXTRA_VIEWS = 4


def sample_texture_view(model, positive, latent, seed):
    """Use the distilled Turbo schedule, as in StableGen's Qwen 2.1 adapter."""
    noise = _call_node("RandomNoise", noise_seed=seed)[0]
    guider = _call_node("BasicGuider", model=model, conditioning=positive)[0]
    sampler = _call_node("KSamplerSelect", sampler_name="euler")[0]
    sigmas = _call_node("ManualSigmas", sigmas=TURBO_SIGMAS)[0]
    return _call_node("SamplerCustomAdvanced", noise=noise, guider=guider,
                      sampler=sampler, sigmas=sigmas, latent_image=latent)[0]


def build_view_plan(center, radius, *, extra=False):
    """Six axis views plus diagonal candidates for surfaces still unseen."""
    distance = radius / math.sin(VIEW_FOV_RADIANS / 2.0) * 1.04
    directions = list(zip(VIEW_LABELS, (
        (0, 0, 1), (1, 0, 0), (0, 0, -1), (-1, 0, 0), (0, 1, 0), (0, -1, 0),
    )))
    if extra:
        directions = [
            (f"{'upper' if y > 0 else 'lower'} {side}", (x, y, z))
            for y in (1, -1)
            for side, x, z in (("front right", 1, 1), ("back right", 1, -1),
                               ("back left", -1, -1), ("front left", -1, 1))
        ]
    return [(label, tuple(center[i] + offset[i] * distance / math.sqrt(sum(v*v for v in offset))
                         for i in range(3)), distance) for label, offset in directions]


def build_texture_prompt(label):
    return (
        f"Edit image 1 as the canvas: the {label} view of this exact object. "
        "Preserve its exact viewpoint, framing, pose, silhouette, geometry and background. "
        "Image 2 is the appearance reference, not the camera viewpoint. "
        "Complete coherent high-quality surface details on the visible surfaces, matching "
        "the reference identity, colors and materials. Continue existing patterns across "
        "surfaces; keep already detailed regions consistent. Use neutral diffuse lighting, "
        "without cast shadows, highlights, text, extra objects or changes to geometry."
    )


def blend_projection(atlas, sampled, weight, previous_weight, *, match_color=False):
    """Prefer face-on observations, feather their overlap, retain unseen texels."""
    import torch

    if match_color:
        overlap = (weight > 0.1) & (previous_weight > 0.1)
        if int(overlap.sum()) >= 32:
            offset = (atlas[overlap].mean(0) - sampled[overlap].mean(0)).clamp(-0.08, 0.08)
            sampled = (sampled + offset).clamp(0, 1)
    total = previous_weight + weight
    result = (atlas * previous_weight[..., None] + sampled * weight[..., None]) / total.clamp_min(1e-8)[..., None]
    return torch.where((total > 1e-8)[..., None], result, atlas), total


def projection_coordinates(positions, normals, covered, eye, basis, fov):
    """Project UV texel positions into an image; visibility is checked separately."""
    import torch
    import torch.nn.functional as F

    forward, right, up = basis
    delta = positions - eye
    distance = delta.norm(dim=-1)
    along = (delta * forward).sum(-1)
    facing = (F.normalize(normals, dim=-1) * -delta).sum(-1) / distance.clamp_min(1e-8)
    scale = along.clamp_min(1e-8) * math.tan(fov / 2)
    x, y = (delta * right).sum(-1) / scale, (delta * up).sum(-1) / scale
    grid = torch.stack(((x + 1) / 2, (1 - y) / 2), dim=-1)
    valid = covered & (along > 0) & (facing > 0.1) & (x.abs() < 1) & (y.abs() < 1)
    return grid, torch.where(valid, facing.clamp(0, 1).pow(4), 0.0), distance


class _Projection:
    def __init__(self, mesh, core, mesh_save, device):
        import torch

        self.core, self.device = core, device
        vertices, faces, _colors, uvs, normals = mesh_save.get_mesh_batch_item(mesh, 0)
        if uvs is None or normals is None or mesh.texture is None:
            raise RuntimeError("Multiview texturing requires UVs, normals and a baked atlas")
        vertices, self.faces = vertices.to(device).float(), faces.to(device).long()
        self.uvs, normals = uvs.to(device).float(), normals.to(device).float()
        self.atlas = mesh.texture[0, ..., :3].to(device).float()
        size = self.atlas.shape[0]
        if self.atlas.shape[1] != size or size < 16:
            raise RuntimeError("Multiview texturing requires a square UV atlas")
        self.center = (vertices.min(0).values + vertices.max(0).values) / 2
        self.radius = float((vertices - self.center).norm(dim=-1).max())
        if not math.isfinite(self.radius) or self.radius <= 0:
            raise RuntimeError("Multiview texturing requires a non-empty mesh")
        self.triangles = vertices[self.faces]
        self.bvh = core._build_triangle_bvh(self.triangles)
        face, bary, self.covered = core._rasterize_uv_barycentric(
            self.faces.cpu().numpy(), self.uvs.cpu().numpy(), size,
        )
        face, bary, self.covered = face.to(device), bary.to(device), self.covered.to(device).bool()
        self.positions = core._interp_vertex_attr(vertices, self.faces, face, bary, self.covered)
        self.normals = core._interp_vertex_attr(normals, self.faces, face, bary, self.covered)
        self.weights = torch.zeros_like(self.covered, dtype=torch.float32)

    def camera(self, eye):
        import torch
        eye = torch.tensor(eye, device=self.device, dtype=torch.float32)
        return eye, self.core._camera_basis(eye, self.center, eye.new_tensor([0, 1, 0]))

    def render(self, eye, basis, atlas):
        return self.core._render_view(
            self.triangles, self.bvh, self.uvs, self.faces, atlas,
            eye, *basis, VIEW_FOV_RADIANS, VIEW_RESOLUTION, VIEW_RESOLUTION,
        )[:2]

    def project(self, eye, basis, hit, check_cancel):
        import torch
        import torch.nn.functional as F

        grid, weight, distances = projection_coordinates(
            self.positions, self.normals, self.covered, eye, basis, VIEW_FOV_RADIANS,
        )
        # Exact texel rays prevent bleeding through thin shells and hidden surfaces.
        indices = (weight > 0).flatten().nonzero().flatten()
        flat_weight = weight.flatten()
        positions, distances = self.positions.reshape(-1, 3), distances.flatten()
        for chunk in indices.split(1 << 18):
            check_cancel()
            directions = F.normalize(positions[chunk] - eye, dim=-1)
            depth, _face, visible = self.core._closest_hit_rays_bvh(
                eye[None].expand(len(chunk), 3), directions, self.triangles, self.bvh,
                tmin=1e-5, tmax=1e30,
            )
            visible &= (depth - distances[chunk]).abs() <= max(self.radius * 1e-4, 1e-6)
            flat_weight[chunk] *= visible
        # A narrow silhouette feather keeps background/edit drift out of the atlas.
        edge = hit.float()[None, None]
        edge = 1 - F.max_pool2d(1 - edge, 5, stride=1, padding=2)
        edge = F.avg_pool2d(edge, 9, stride=1, padding=4)[0, 0]
        weight *= self.sample(edge[..., None], grid)[..., 0]
        return grid, weight

    def sample(self, image, grid):
        return self.core._sample_image01(image.to(self.device).float(), grid.reshape(-1, 2).float()).reshape(
            *grid.shape[:2], image.shape[-1],
        )

    def fill(self, atlas):
        import torch
        return torch.from_numpy(self.core._jfa_fill_gpu(atlas.cpu().numpy(), self.covered.cpu().numpy())).to(self.device)


def run_texture_pass(
    mesh: Any, output_dir: Path, prepared_path: Path, seed: int, *,
    material_model_directory: Path,
    emit: Callable[[str, float, str, str], None],
    check_cancel: Callable[[], None],
    publish: Callable[[dict[str, Any]], None],
) -> tuple[Any, Any, Any]:
    import torch
    import torch.nn.functional as F
    import comfy.model_management as model_management
    import comfy_extras.nodes_mesh_postprocess as core
    import comfy_extras.nodes_save_3d as mesh_save

    output_dir.mkdir(parents=True, exist_ok=True)
    projection = _Projection(mesh, core, mesh_save, model_management.get_torch_device())
    plan = build_view_plan(projection.center.tolist(), projection.radius)
    candidates = build_view_plan(projection.center.tolist(), projection.radius, extra=True)
    views = [{"label": label, "state": "pending"} for label, _eye, _distance in plan]
    snapshots = {"preview": "preview.glb", "views": views, "phase": "views"}
    records = []

    def publish_state():
        snapshots["coverage"] = float(((projection.weights > 0.05) & projection.covered).sum()) / max(1, int(projection.covered.sum()))
        publish(snapshots)

    def save_atlas(index, maps):
        names = {}
        for key, value in maps.items():
            name = f"atlas_{index}_{key}.png"
            _save_prepared_image(value[None].expand(-1, -1, -1, 3), output_dir / name)
            names[key] = name
        snapshots["atlas"] = names

    check_cancel()
    publish_state()
    emit("texture_models", 87, "Loading view generation models", "Qwen Image 2.1 Turbo · 8 steps · CFG 1")
    model = _call_node("UNETLoader", unet_name=QI2_DIFFUSION_MODEL, weight_dtype="default")[0].clone()

    def cancellable_step(model_function, arguments):
        check_cancel()
        return model_function(arguments["input"], arguments["timestep"], **arguments["c"])

    model.set_model_unet_function_wrapper(cancellable_step)
    clip = _call_node("CLIPLoader", clip_name=QI2_TEXT_ENCODER, type="qwen_image", device="default")[0]
    vae = _call_node("VAELoader", vae_name=QI2_VAE)[0]
    with Image.open(prepared_path) as image:
        reference = _image_tensor(image)[0]

    for index in range(len(VIEW_LABELS) + MAX_EXTRA_VIEWS):
        check_cancel()
        if index >= len(plan):
            missing = projection.covered & (projection.weights < 0.05)
            if float(missing.sum()) / max(1, int(projection.covered.sum())) < 0.005 or not candidates:
                break
            # Rank diagonal cameras by uncovered, face-on surface area; ray-test the winner.
            def score(candidate):
                eye, basis = projection.camera(candidate[1])
                _grid, weight, _distance = projection_coordinates(
                    projection.positions, projection.normals, missing, eye, basis, VIEW_FOV_RADIANS,
                )
                return float(weight.sum())
            candidate = max(candidates, key=score)
            candidates.remove(candidate)
            plan.append(candidate)
            views.append({"label": candidate[0], "state": "pending"})
        label, position, _distance = plan[index]
        views[index]["state"] = "rendering"
        snapshots["active_view"] = index
        publish_state()
        emit("texture_views", 88 + index * 0.45, f"Generating the {label} view", f"View {index + 1} · Qwen Image 2.1 Turbo")
        eye, basis = projection.camera(position)
        rendered, hit = projection.render(eye, basis, projection.atlas)
        grid, weight = projection.project(eye, basis, hit, check_cancel)
        if not bool((weight > 0).any()):
            views[index]["state"] = "occluded"
            publish_state()
            continue
        confidence, _hit = projection.render(eye, basis, projection.weights.clamp(0, 1)[..., None].expand(-1, -1, 3))
        # Keep the silhouette/background fixed and protect already well-observed detail.
        edit_mask = hit.float() * (1 - confidence[..., 0].clamp(0, 1) * 0.9)
        rendered = torch.where(hit[..., None], rendered, rendered.new_full((), 0.5))
        base_name, refined_name = f"view_{index}_base.png", f"view_{index}_refined.png"
        _save_prepared_image(rendered[None], output_dir / base_name)
        views[index].update(base=base_name, state="generating")
        publish_state()
        positive, negative, _empty = _call_node(
            "TextEncodeQwenImage21", clip=clip, vae=vae, prompt=build_texture_prompt(label),
            negative_prompt="", resolution=VIEW_RESOLUTION,
            images={"image_1": rendered[None], "image_2": reference},
        )
        latent = _call_node("VAEEncode", pixels=rendered[None], vae=vae)[0]
        latent = _call_node("SetLatentNoiseMask", samples=latent, mask=edit_mask[None])[0]
        samples = sample_texture_view(model, positive, latent, _seed(seed, index))
        check_cancel()
        refined = _call_node("VAEDecode", vae=vae, samples=samples)[0][0, ..., :3].to(projection.device).float()
        if not bool(torch.isfinite(refined).all()):
            raise RuntimeError("Qwen returned a non-finite texture view")
        if refined.shape[:2] != rendered.shape[:2]:
            refined = F.interpolate(refined.permute(2, 0, 1)[None], size=rendered.shape[:2], mode="bilinear", align_corners=False)[0].permute(1, 2, 0)
        refined = refined * edit_mask[..., None] + rendered * (1 - edit_mask[..., None])
        _save_prepared_image(refined[None], output_dir / refined_name)
        sampled = projection.sample(refined, grid)
        projection.atlas, projection.weights = blend_projection(
            projection.atlas, sampled, weight, projection.weights, match_color=True,
        )
        projection.atlas = projection.fill(projection.atlas)
        views[index].update(refined=refined_name, state="projected")
        records.append({"index": index, "refined": refined_name, "grid": grid.cpu(), "weight": weight.cpu()})
        save_atlas(index, {"base_color": projection.atlas})
        publish_state()
        del positive, negative, latent, samples, refined, sampled, _empty

    del model, clip, vae, reference
    release_runtime_memory()
    if not records:
        raise RuntimeError("No mesh surfaces were visible to the automatic cameras")
    # Geometry is no longer needed while Marigold occupies the GPU.
    del projection.triangles, projection.bvh, projection.positions, projection.normals
    snapshots["phase"] = "materials"
    material_weight = torch.zeros_like(projection.weights)
    orm = getattr(mesh, "metallic_roughness", None)
    maps = {"base_color": projection.atlas,
            "roughness": orm[0, ..., 1:2].to(projection.device) if orm is not None else torch.ones_like(projection.weights)[..., None],
            "metallic": orm[0, ..., 2:3].to(projection.device) if orm is not None else torch.zeros_like(projection.weights)[..., None]}
    source_roughness, source_metallic = maps["roughness"], maps["metallic"]
    estimates = {key: maps[key] for key in ("roughness", "metallic")}
    emit("texture_materials", 93, "Refining PBR materials", "Marigold · roughness and metallic · preserving generated color")

    def apply_materials(record_index, predicted):
        nonlocal material_weight
        check_cancel()
        record = records[record_index]
        index = record["index"]
        grid, weight = record["grid"].to(projection.device), record["weight"].to(projection.device)
        # IID albedo erases drawn facial features; the Qwen color atlas stays authoritative.
        for key, value in zip(("roughness", "metallic"), predicted[1:]):
            sampled = projection.sample(value, grid)
            estimates[key], _total = blend_projection(estimates[key], sampled, weight, material_weight)
            estimates[key] = projection.fill(estimates[key])
        material_weight += weight
        maps["roughness"], maps["metallic"] = refine_material_maps(
            source_roughness, source_metallic, estimates["roughness"], estimates["metallic"],
        )
        views[index]["state"] = "complete"
        snapshots["active_view"] = index
        save_atlas(len(VIEW_LABELS) + MAX_EXTRA_VIEWS + record_index, maps)
        publish_state()
        emit("texture_materials", 93 + 2 * (record_index + 1) / len(records),
             f"Applying {views[index]['label']} materials", f"{record_index + 1}/{len(records)} views")

    extract_materials(material_model_directory, records, output_dir, seed,
                      check_cancel=check_cancel, on_view=apply_materials)
    snapshots["phase"] = "complete"
    snapshots.pop("active_view", None)
    publish_state()
    return tuple(maps[key][None].clamp(0, 1).cpu() for key in ("base_color", "roughness", "metallic"))
