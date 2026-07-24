"""Dependency-free Gaussian PLY to colored triangle GLB conversion.

The Factory stores editable objects as 3D Gaussians.  GLB, however, has no
portable Gaussian primitive, so exporting a useful GLB requires reconstructing
a surface.  This module rasterizes Gaussian centres into an adaptive density
volume, filters that volume using the splat scale, extracts an isosurface with
marching tetrahedra, and writes a standards-compliant binary glTF file.

Only NumPy and the existing Factory PLY reader are required.
"""

from __future__ import annotations

import json
import logging
import math
import os
import struct
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

from .gaussian_scene import export_scene_ply, inspect_ply


LOGGER = logging.getLogger("vnccs.3d_factory.gaussian_mesh")
_C0 = np.float32(0.28209479177387814)
_DEFAULT_RESOLUTION = 192
_MAX_SAMPLES = 1_100_000
_MAX_TRIANGLES = 2_000_000
_CORNER_OFFSETS = np.asarray(
    [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
    ],
    dtype=np.int32,
)
_TETRAHEDRA = (
    (0, 5, 1, 6),
    (0, 1, 2, 6),
    (0, 2, 3, 6),
    (0, 3, 7, 6),
    (0, 7, 4, 6),
    (0, 4, 5, 6),
)


@dataclass
class TriangleMesh:
    name: str
    vertices: np.ndarray
    normals: np.ndarray
    colors: np.ndarray
    faces: np.ndarray


def _sigmoid(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values.astype(np.float32, copy=False), -60.0, 60.0)
    return 1.0 / (1.0 + np.exp(-clipped))


def _box_blur_axis(values: np.ndarray, radius: int, axis: int) -> np.ndarray:
    if radius <= 0:
        return values
    moved = np.moveaxis(values, axis, 0)
    pad = [(radius, radius)] + [(0, 0)] * (moved.ndim - 1)
    padded = np.pad(moved, pad, mode="constant")
    cumulative = np.cumsum(padded, axis=0, dtype=np.float32)
    cumulative = np.concatenate(
        (np.zeros_like(cumulative[:1]), cumulative),
        axis=0,
    )
    width = radius * 2 + 1
    blurred = (cumulative[width:] - cumulative[:-width]) / float(width)
    return np.moveaxis(blurred, 0, axis)


def _smooth_volume(values: np.ndarray, radius: int) -> np.ndarray:
    output = values.astype(np.float32, copy=False)
    for axis in range(3):
        output = _box_blur_axis(output, radius, axis)
    # A second small pass suppresses voxel stair-stepping without erasing the
    # thin features that are present in TripoSplat's dense point distribution.
    if radius > 1:
        for axis in range(3):
            output = _box_blur_axis(output, 1, axis)
    return output


def _sample_indices(weights: np.ndarray, maximum: int) -> np.ndarray:
    count = len(weights)
    if count <= maximum:
        return np.arange(count, dtype=np.int64)
    # Preserve broad surface coverage using a uniform deterministic sample and
    # reserve a quarter of the budget for the most opaque splats.
    strong_count = maximum // 4
    broad_count = maximum - strong_count
    broad = np.linspace(0, count - 1, broad_count, dtype=np.int64)
    strong = np.argpartition(weights, -strong_count)[-strong_count:]
    selected = np.unique(np.concatenate((broad, strong.astype(np.int64))))
    if len(selected) > maximum:
        selected = selected[:maximum]
    return selected


def _read_gaussian_samples(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    info = inspect_ply(path)
    records = np.memmap(
        info.path,
        mode="r",
        dtype=info.dtype,
        offset=info.data_offset,
        shape=(info.vertex_count,),
    )
    try:
        positions = np.column_stack(
            tuple(np.asarray(records[name], dtype=np.float32) for name in ("x", "y", "z"))
        )
        log_scales = np.column_stack(
            tuple(np.asarray(records[f"scale_{index}"], dtype=np.float32) for index in range(3))
        )
        scales = np.exp(np.clip(log_scales, -30.0, 30.0))
        opacity = _sigmoid(np.asarray(records["opacity"], dtype=np.float32))
        colors = np.column_stack(
            tuple(np.asarray(records[f"f_dc_{index}"], dtype=np.float32) for index in range(3))
        )
        colors = np.clip(colors * _C0 + 0.5, 0.0, 1.0)
    finally:
        del records

    finite = (
        np.isfinite(positions).all(axis=1)
        & np.isfinite(scales).all(axis=1)
        & np.isfinite(opacity)
        & np.isfinite(colors).all(axis=1)
        & (scales > 0).all(axis=1)
        & (opacity > 0.005)
    )
    positions = positions[finite]
    scales = scales[finite]
    opacity = opacity[finite]
    colors = colors[finite]
    if len(positions) < 8:
        raise ValueError(f"{path.name}: not enough usable Gaussians for mesh reconstruction")

    selected = _sample_indices(opacity, _MAX_SAMPLES)
    return positions[selected], scales[selected], opacity[selected], colors[selected]


def _density_volume(
    positions: np.ndarray,
    scales: np.ndarray,
    opacity: np.ndarray,
    colors: np.ndarray,
    resolution: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, float]:
    robust = opacity >= max(0.02, float(np.quantile(opacity, 0.08)))
    bounds_points = positions[robust] if int(robust.sum()) >= 8 else positions
    lower = np.percentile(bounds_points, 0.15, axis=0)
    upper = np.percentile(bounds_points, 99.85, axis=0)
    extent = np.maximum(upper - lower, 1e-5)
    scale_hint = float(np.median(np.max(scales, axis=1)))
    padding = np.maximum(extent * 0.025, scale_hint * 3.0)
    lower = lower - padding
    upper = upper + padding
    extent = np.maximum(upper - lower, 1e-5)

    longest = float(extent.max())
    dimensions = np.maximum(
        24,
        np.ceil((extent / longest) * max(32, int(resolution))).astype(np.int32) + 1,
    )
    dimensions = np.minimum(dimensions, max(32, int(resolution)) + 1)
    spacing = extent / np.maximum(dimensions - 1, 1)

    coordinates = (positions - lower) / spacing
    inside = ((coordinates >= 0) & (coordinates <= dimensions - 1)).all(axis=1)
    coordinates = coordinates[inside]
    opacity = opacity[inside]
    scales = scales[inside]
    colors = colors[inside]
    if len(coordinates) < 8:
        raise ValueError("Gaussian bounds contain too few samples")

    base = np.floor(coordinates).astype(np.int32)
    base = np.minimum(base, dimensions - 2)
    fraction = coordinates - base
    voxel_count = int(np.prod(dimensions, dtype=np.int64))
    density_flat = np.zeros(voxel_count, dtype=np.float32)
    color_flat = np.zeros((voxel_count, 3), dtype=np.float32)

    median_area = max(float(np.median(np.prod(np.sort(scales, axis=1)[:, -2:], axis=1))), 1e-12)
    area = np.prod(np.sort(scales, axis=1)[:, -2:], axis=1)
    sample_weight = opacity * np.clip(np.sqrt(area / median_area), 0.35, 3.5)

    for offset in _CORNER_OFFSETS:
        corner_weight = np.prod(
            np.where(offset[None, :] == 1, fraction, 1.0 - fraction),
            axis=1,
        ).astype(np.float32)
        weight = sample_weight * corner_weight
        index = base + offset
        flat_index = np.ravel_multi_index(index.T, tuple(int(v) for v in dimensions))
        density_flat += np.bincount(flat_index, weights=weight, minlength=voxel_count).astype(
            np.float32,
            copy=False,
        )
        for channel in range(3):
            color_flat[:, channel] += np.bincount(
                flat_index,
                weights=weight * colors[:, channel],
                minlength=voxel_count,
            ).astype(np.float32, copy=False)

    density = density_flat.reshape(tuple(int(v) for v in dimensions))
    color_mass = color_flat.reshape((*tuple(int(v) for v in dimensions), 3))
    del density_flat, color_flat

    voxel_size = float(np.mean(spacing))
    scale_in_voxels = scale_hint / max(voxel_size, 1e-8)
    blur_radius = int(np.clip(round(scale_in_voxels * 1.35), 1, 3))
    density = _smooth_volume(density, blur_radius)
    color_mass = _smooth_volume(color_mass, blur_radius)
    positive = density[density > 0]
    if not len(positive):
        raise ValueError("Gaussian density reconstruction produced an empty volume")
    normalized = density / max(float(np.percentile(positive, 99.5)), 1e-12)
    positive_normalized = normalized[normalized > 0]
    level = float(
        np.clip(
            np.percentile(positive_normalized, 38.0) * 0.62,
            0.025,
            0.24,
        )
    )
    color_volume = color_mass / np.maximum(density[..., None], 1e-12)
    color_volume = np.clip(color_volume, 0.0, 1.0)
    return normalized.astype(np.float32, copy=False), color_volume, lower, spacing, level


def _cube_corners(
    indices: np.ndarray,
    field: np.ndarray,
    colors: np.ndarray,
    lower: np.ndarray,
    spacing: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    grid = indices[:, None, :] + _CORNER_OFFSETS[None, :, :]
    values = field[grid[..., 0], grid[..., 1], grid[..., 2]]
    corner_colors = colors[grid[..., 0], grid[..., 1], grid[..., 2]]
    positions = lower[None, None, :] + grid.astype(np.float32) * spacing[None, None, :]
    return positions, values, corner_colors


def _interpolate_edge(
    positions: np.ndarray,
    values: np.ndarray,
    colors: np.ndarray,
    first: int,
    second: int,
    level: float,
) -> tuple[np.ndarray, np.ndarray]:
    first_value = values[:, first]
    second_value = values[:, second]
    denominator = second_value - first_value
    amount = np.divide(
        level - first_value,
        denominator,
        out=np.full_like(first_value, 0.5),
        where=np.abs(denominator) > 1e-12,
    )
    amount = np.clip(amount, 0.0, 1.0)[:, None]
    point = positions[:, first] + (positions[:, second] - positions[:, first]) * amount
    color = colors[:, first] + (colors[:, second] - colors[:, first]) * amount
    return point.astype(np.float32, copy=False), color.astype(np.float32, copy=False)


def _orient_triangles(
    points: np.ndarray,
    colors: np.ndarray,
    outward: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    normal = np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0])
    reverse = np.einsum("ij,ij->i", normal, outward) < 0
    if reverse.any():
        points[reverse, 1:3] = points[reverse, 2:0:-1]
        colors[reverse, 1:3] = colors[reverse, 2:0:-1]
    return points, colors


def _march_tetrahedra(
    field: np.ndarray,
    color_volume: np.ndarray,
    lower: np.ndarray,
    spacing: np.ndarray,
    level: float,
) -> tuple[np.ndarray, np.ndarray]:
    low = field[:-1, :-1, :-1]
    high = field[1:, 1:, 1:]
    local_min = low.copy()
    local_max = low.copy()
    for offset in _CORNER_OFFSETS[1:]:
        corner = field[
            offset[0] : offset[0] + low.shape[0],
            offset[1] : offset[1] + low.shape[1],
            offset[2] : offset[2] + low.shape[2],
        ]
        local_min = np.minimum(local_min, corner)
        local_max = np.maximum(local_max, corner)
    active = np.column_stack(np.nonzero((local_min <= level) & (local_max >= level)))
    del low, high, local_min, local_max
    if not len(active):
        raise ValueError("no isosurface was found in the reconstructed Gaussian density")

    triangle_blocks: list[np.ndarray] = []
    color_blocks: list[np.ndarray] = []
    for chunk_start in range(0, len(active), 65_536):
        indices = active[chunk_start : chunk_start + 65_536]
        cube_positions, cube_values, cube_colors = _cube_corners(
            indices,
            field,
            color_volume,
            lower,
            spacing,
        )
        for tetrahedron in _TETRAHEDRA:
            tetra = np.asarray(tetrahedron, dtype=np.int32)
            positions = cube_positions[:, tetra]
            values = cube_values[:, tetra]
            colors = cube_colors[:, tetra]
            inside = values >= level
            counts = inside.sum(axis=1)

            for inside_vertex in range(4):
                mask = (counts == 1) & inside[:, inside_vertex]
                if not mask.any():
                    continue
                outside_vertices = [value for value in range(4) if value != inside_vertex]
                points_and_colors = [
                    _interpolate_edge(
                        positions[mask],
                        values[mask],
                        colors[mask],
                        inside_vertex,
                        outside_vertex,
                        level,
                    )
                    for outside_vertex in outside_vertices
                ]
                points = np.stack([value[0] for value in points_and_colors], axis=1)
                triangle_colors = np.stack([value[1] for value in points_and_colors], axis=1)
                outward = positions[mask][:, outside_vertices].mean(axis=1) - positions[mask][:, inside_vertex]
                points, triangle_colors = _orient_triangles(points, triangle_colors, outward)
                triangle_blocks.append(points)
                color_blocks.append(triangle_colors)

            for outside_vertex in range(4):
                mask = (counts == 3) & ~inside[:, outside_vertex]
                if not mask.any():
                    continue
                inside_vertices = [value for value in range(4) if value != outside_vertex]
                points_and_colors = [
                    _interpolate_edge(
                        positions[mask],
                        values[mask],
                        colors[mask],
                        outside_vertex,
                        inside_vertex,
                        level,
                    )
                    for inside_vertex in inside_vertices
                ]
                points = np.stack([value[0] for value in points_and_colors], axis=1)
                triangle_colors = np.stack([value[1] for value in points_and_colors], axis=1)
                outward = positions[mask][:, outside_vertex] - positions[mask][:, inside_vertices].mean(axis=1)
                points, triangle_colors = _orient_triangles(points, triangle_colors, outward)
                triangle_blocks.append(points)
                color_blocks.append(triangle_colors)

            for first_inside in range(4):
                for second_inside in range(first_inside + 1, 4):
                    mask = (
                        (counts == 2)
                        & inside[:, first_inside]
                        & inside[:, second_inside]
                    )
                    if not mask.any():
                        continue
                    outside_vertices = [
                        value
                        for value in range(4)
                        if value not in {first_inside, second_inside}
                    ]
                    first_outside, second_outside = outside_vertices
                    edge_pairs = (
                        (first_inside, first_outside),
                        (first_inside, second_outside),
                        (second_inside, first_outside),
                        (second_inside, second_outside),
                    )
                    intersections = [
                        _interpolate_edge(
                            positions[mask],
                            values[mask],
                            colors[mask],
                            first,
                            second,
                            level,
                        )
                        for first, second in edge_pairs
                    ]
                    quad_points = [value[0] for value in intersections]
                    quad_colors = [value[1] for value in intersections]
                    outward = (
                        positions[mask][:, outside_vertices].mean(axis=1)
                        - positions[mask][:, [first_inside, second_inside]].mean(axis=1)
                    )
                    for order in ((0, 2, 1), (1, 2, 3)):
                        points = np.stack([quad_points[index] for index in order], axis=1)
                        triangle_colors = np.stack([quad_colors[index] for index in order], axis=1)
                        points, triangle_colors = _orient_triangles(
                            points,
                            triangle_colors,
                            outward,
                        )
                        triangle_blocks.append(points)
                        color_blocks.append(triangle_colors)

    if not triangle_blocks:
        raise ValueError("Gaussian isosurface extraction produced no triangles")
    triangles = np.concatenate(triangle_blocks, axis=0)
    triangle_colors = np.concatenate(color_blocks, axis=0)
    if len(triangles) > _MAX_TRIANGLES:
        selected = np.linspace(0, len(triangles) - 1, _MAX_TRIANGLES, dtype=np.int64)
        triangles = triangles[selected]
        triangle_colors = triangle_colors[selected]
    return triangles, triangle_colors


def _indexed_mesh(
    name: str,
    triangles: np.ndarray,
    triangle_colors: np.ndarray,
    spacing: np.ndarray,
) -> TriangleMesh:
    flat_vertices = triangles.reshape(-1, 3)
    flat_colors = triangle_colors.reshape(-1, 3)
    quantization = max(float(np.min(spacing)) * 1e-5, 1e-9)
    keys = np.rint(flat_vertices / quantization).astype(np.int64)
    _unique, first, inverse = np.unique(
        keys,
        axis=0,
        return_index=True,
        return_inverse=True,
    )
    vertices = flat_vertices[first].astype(np.float32, copy=False)
    faces = inverse.reshape(-1, 3).astype(np.uint32, copy=False)
    nondegenerate = (
        (faces[:, 0] != faces[:, 1])
        & (faces[:, 1] != faces[:, 2])
        & (faces[:, 0] != faces[:, 2])
    )
    faces = faces[nondegenerate]
    if not len(faces):
        raise ValueError("Gaussian mesh collapsed to degenerate triangles")

    color_sum = np.zeros((len(vertices), 3), dtype=np.float64)
    color_count = np.zeros(len(vertices), dtype=np.int64)
    np.add.at(color_sum, inverse, flat_colors)
    np.add.at(color_count, inverse, 1)
    colors = np.clip(
        color_sum / np.maximum(color_count[:, None], 1),
        0.0,
        1.0,
    )
    colors = np.concatenate(
        (
            np.rint(colors * 255.0).astype(np.uint8),
            np.full((len(colors), 1), 255, dtype=np.uint8),
        ),
        axis=1,
    )

    face_vectors = np.cross(
        vertices[faces[:, 1]] - vertices[faces[:, 0]],
        vertices[faces[:, 2]] - vertices[faces[:, 0]],
    )
    normals = np.zeros_like(vertices, dtype=np.float32)
    for corner in range(3):
        np.add.at(normals, faces[:, corner], face_vectors)
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals /= np.maximum(lengths, 1e-12)
    return TriangleMesh(name=name, vertices=vertices, normals=normals, colors=colors, faces=faces)


def gaussian_ply_to_mesh(
    path: str | os.PathLike[str],
    *,
    name: str = "Object",
    resolution: int = _DEFAULT_RESOLUTION,
) -> TriangleMesh:
    source = Path(path).resolve()
    positions, scales, opacity, colors = _read_gaussian_samples(source)
    LOGGER.info(
        "GLB mesh reconstruction %s: %s sampled Gaussians, target grid %s",
        source.name,
        f"{len(positions):,}",
        resolution,
    )
    field, color_volume, lower, spacing, level = _density_volume(
        positions,
        scales,
        opacity,
        colors,
        max(64, min(256, int(resolution))),
    )
    LOGGER.info(
        "GLB density volume %s: grid=%s, iso=%.6f, voxel=%s",
        source.name,
        "x".join(str(value) for value in field.shape),
        level,
        ",".join(f"{value:.6g}" for value in spacing),
    )
    triangles, triangle_colors = _march_tetrahedra(
        field,
        color_volume,
        lower,
        spacing,
        level,
    )
    mesh = _indexed_mesh(name, triangles, triangle_colors, spacing)
    LOGGER.info(
        "GLB mesh ready %s: %s vertices, %s triangles",
        name,
        f"{len(mesh.vertices):,}",
        f"{len(mesh.faces):,}",
    )
    return mesh


def _safe_mesh_name(value: Any, fallback: str) -> str:
    cleaned = "".join(character for character in str(value or "") if ord(character) >= 32)
    return cleaned.strip()[:96] or fallback


def _pad4(payload: bytes, fill: bytes = b"\0") -> bytes:
    return payload + fill * ((-len(payload)) % 4)


def write_glb(meshes: Sequence[TriangleMesh], target: str | os.PathLike[str]) -> dict[str, Any]:
    if not meshes:
        raise ValueError("cannot write a GLB without meshes")
    binary = bytearray()
    buffer_views: list[dict[str, Any]] = []
    accessors: list[dict[str, Any]] = []
    gltf_meshes: list[dict[str, Any]] = []
    nodes: list[dict[str, Any]] = []

    def add_view(payload: bytes, target_kind: int) -> int:
        while len(binary) % 4:
            binary.append(0)
        offset = len(binary)
        binary.extend(payload)
        index = len(buffer_views)
        buffer_views.append(
            {
                "buffer": 0,
                "byteOffset": offset,
                "byteLength": len(payload),
                "target": target_kind,
            }
        )
        return index

    def add_accessor(
        view: int,
        component_type: int,
        count: int,
        value_type: str,
        *,
        minimum: list[float] | None = None,
        maximum: list[float] | None = None,
        normalized: bool = False,
    ) -> int:
        item: dict[str, Any] = {
            "bufferView": view,
            "componentType": component_type,
            "count": count,
            "type": value_type,
        }
        if minimum is not None:
            item["min"] = minimum
        if maximum is not None:
            item["max"] = maximum
        if normalized:
            item["normalized"] = True
        accessors.append(item)
        return len(accessors) - 1

    total_vertices = 0
    total_triangles = 0
    for mesh_index, mesh in enumerate(meshes):
        vertices = np.asarray(mesh.vertices, dtype="<f4")
        normals = np.asarray(mesh.normals, dtype="<f4")
        colors = np.asarray(mesh.colors, dtype=np.uint8)
        indices = np.asarray(mesh.faces.reshape(-1), dtype="<u4")
        if not len(vertices) or not len(indices):
            continue
        position_accessor = add_accessor(
            add_view(vertices.tobytes(), 34962),
            5126,
            len(vertices),
            "VEC3",
            minimum=vertices.min(axis=0).astype(float).tolist(),
            maximum=vertices.max(axis=0).astype(float).tolist(),
        )
        normal_accessor = add_accessor(
            add_view(normals.tobytes(), 34962),
            5126,
            len(normals),
            "VEC3",
        )
        color_accessor = add_accessor(
            add_view(colors.tobytes(), 34962),
            5121,
            len(colors),
            "VEC4",
            normalized=True,
        )
        index_accessor = add_accessor(
            add_view(indices.tobytes(), 34963),
            5125,
            len(indices),
            "SCALAR",
            minimum=[int(indices.min())],
            maximum=[int(indices.max())],
        )
        gltf_meshes.append(
            {
                "name": mesh.name,
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": position_accessor,
                            "NORMAL": normal_accessor,
                            "COLOR_0": color_accessor,
                        },
                        "indices": index_accessor,
                        "material": 0,
                        "mode": 4,
                    }
                ],
            }
        )
        nodes.append({"name": mesh.name, "mesh": len(gltf_meshes) - 1})
        total_vertices += len(vertices)
        total_triangles += len(indices) // 3

    if not gltf_meshes:
        raise ValueError("all reconstructed GLB meshes were empty")
    document = {
        "asset": {
            "version": "2.0",
            "generator": "VNCCS 3D Factory Gaussian Mesh Exporter",
        },
        "scene": 0,
        "scenes": [{"name": "VNCCS 3D Factory Scene", "nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": gltf_meshes,
        "materials": [
            {
                "name": "Gaussian vertex colors",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.82,
                },
                "doubleSided": True,
            }
        ],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": buffer_views,
        "accessors": accessors,
        "extras": {
            "source": "VNCCS 3D Factory Gaussian surface reconstruction",
            "vertices": total_vertices,
            "triangles": total_triangles,
        },
    }
    json_chunk = _pad4(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        b" ",
    )
    binary_chunk = _pad4(bytes(binary))
    total_length = 12 + 8 + len(json_chunk) + 8 + len(binary_chunk)
    payload = (
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<I4s", len(json_chunk), b"JSON")
        + json_chunk
        + struct.pack("<I4s", len(binary_chunk), b"BIN\0")
        + binary_chunk
    )

    output = Path(target).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.",
        suffix=".tmp",
        dir=output.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
    except Exception:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    return {
        "path": str(output),
        "format": "glb",
        "objects": len(gltf_meshes),
        "vertices": total_vertices,
        "triangles": total_triangles,
    }


def export_gaussian_scene_glb(
    sources: Iterable[tuple[str | os.PathLike[str], Any]],
    target: str | os.PathLike[str],
    *,
    names: Sequence[str] | None = None,
    resolution: int = _DEFAULT_RESOLUTION,
) -> dict[str, Any]:
    entries = list(sources)
    if not entries:
        raise ValueError("the scene contains no Gaussian objects")
    meshes: list[TriangleMesh] = []
    temporary_root = Path(tempfile.mkdtemp(prefix="vnccs-glb-"))
    try:
        for index, (source, transform) in enumerate(entries):
            prepared = temporary_root / f"object-{index:04d}.ply"
            export_scene_ply([(source, transform)], prepared)
            name = _safe_mesh_name(
                names[index] if names and index < len(names) else "",
                f"Object {index + 1}",
            )
            LOGGER.info(
                "GLB export object %s/%s: %s",
                index + 1,
                len(entries),
                name,
            )
            meshes.append(
                gaussian_ply_to_mesh(
                    prepared,
                    name=name,
                    resolution=resolution,
                )
            )
        return write_glb(meshes, target)
    finally:
        for path in temporary_root.glob("*"):
            try:
                path.unlink()
            except OSError:
                pass
        try:
            temporary_root.rmdir()
        except OSError:
            pass
