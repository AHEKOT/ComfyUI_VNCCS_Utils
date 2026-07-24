"""Lossless Gaussian PLY to GLB export for VNCCS 3D Factory.

The binary layout follows PlayCanvas ``splat-transform``'s MIT-licensed GLB
writer and the Khronos ``KHR_gaussian_splatting`` extension.  No triangle
surface is reconstructed: every Gaussian keeps its center, covariance,
opacity, and spherical-harmonic color data.
"""

from __future__ import annotations

import json
import math
import os
import struct
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from .gaussian_scene import (
    _CHUNK,
    export_scene_ply,
    inspect_ply,
    validate_ply_payload,
)


_SH_C0 = np.float32(0.28209479177387814)
_FLOAT = 5126
_UNSIGNED_BYTE = 5121
_ARRAY_BUFFER = 34962
_GLB_LIMIT = (1 << 32) - 1


@dataclass(frozen=True)
class _Segment:
    name: str
    components: int
    component_type: int
    accessor_type: str
    byte_offset: int
    byte_length: int
    normalized: bool = False
    minimum: list[float] | None = None
    maximum: list[float] | None = None
    sh_degree: int = -1
    sh_coefficient: int = -1


def _align4(value: int) -> int:
    return (int(value) + 3) & ~3


def _detect_sh_degree(names: tuple[str, ...]) -> int:
    available = set(names)
    for count, degree in ((45, 3), (24, 2), (9, 1)):
        if all(f"f_rest_{index}" in available for index in range(count)):
            return degree
    return 0


def _position_bounds(data: np.memmap, count: int) -> tuple[list[float], list[float]]:
    minimum = np.asarray([np.inf, np.inf, np.inf], dtype=np.float64)
    maximum = np.asarray([-np.inf, -np.inf, -np.inf], dtype=np.float64)
    for start in range(0, count, _CHUNK):
        records = data[start : start + _CHUNK]
        chunk_min = np.asarray(
            [records["x"].min(), records["y"].min(), records["z"].min()],
            dtype=np.float64,
        )
        chunk_max = np.asarray(
            [records["x"].max(), records["y"].max(), records["z"].max()],
            dtype=np.float64,
        )
        minimum = np.minimum(minimum, chunk_min)
        maximum = np.maximum(maximum, chunk_max)
    return minimum.tolist(), maximum.tolist()


def _segments(
    count: int,
    sh_degree: int,
    minimum: list[float],
    maximum: list[float],
) -> tuple[list[_Segment], int]:
    definitions: list[dict[str, Any]] = [
        {
            "name": "POSITION",
            "components": 3,
            "component_type": _FLOAT,
            "accessor_type": "VEC3",
            "minimum": minimum,
            "maximum": maximum,
        },
        {
            "name": "COLOR_0",
            "components": 4,
            "component_type": _UNSIGNED_BYTE,
            "accessor_type": "VEC4",
            "normalized": True,
        },
        {
            "name": "KHR_gaussian_splatting:ROTATION",
            "components": 4,
            "component_type": _FLOAT,
            "accessor_type": "VEC4",
        },
        {
            "name": "KHR_gaussian_splatting:SCALE",
            "components": 3,
            "component_type": _FLOAT,
            "accessor_type": "VEC3",
        },
        {
            "name": "KHR_gaussian_splatting:OPACITY",
            "components": 1,
            "component_type": _FLOAT,
            "accessor_type": "SCALAR",
        },
        {
            "name": "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0",
            "components": 3,
            "component_type": _FLOAT,
            "accessor_type": "VEC3",
        },
    ]
    coefficients_per_degree = (0, 3, 5, 7)
    for degree in range(1, sh_degree + 1):
        for coefficient in range(coefficients_per_degree[degree]):
            definitions.append(
                {
                    "name": (
                        f"KHR_gaussian_splatting:SH_DEGREE_{degree}"
                        f"_COEF_{coefficient}"
                    ),
                    "components": 3,
                    "component_type": _FLOAT,
                    "accessor_type": "VEC3",
                    "sh_degree": degree,
                    "sh_coefficient": coefficient,
                }
            )

    output: list[_Segment] = []
    offset = 0
    for definition in definitions:
        bytes_per_component = (
            1 if definition["component_type"] == _UNSIGNED_BYTE else 4
        )
        byte_length = count * definition["components"] * bytes_per_component
        output.append(
            _Segment(
                byte_offset=offset,
                byte_length=byte_length,
                normalized=bool(definition.get("normalized", False)),
                minimum=definition.get("minimum"),
                maximum=definition.get("maximum"),
                sh_degree=int(definition.get("sh_degree", -1)),
                sh_coefficient=int(definition.get("sh_coefficient", -1)),
                **{
                    key: definition[key]
                    for key in (
                        "name",
                        "components",
                        "component_type",
                        "accessor_type",
                    )
                },
            )
        )
        offset += _align4(byte_length)
    return output, offset


def _camera_node(metadata: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any]] | None:
    if not isinstance(metadata, dict):
        return None
    camera = metadata.get("camera")
    render = metadata.get("render")
    if not isinstance(camera, dict) or not isinstance(render, dict):
        return None
    try:
        position = np.asarray(camera["position"], dtype=np.float64)
        target = np.asarray(camera["target"], dtype=np.float64)
        up = np.asarray(camera.get("up", [0.0, 1.0, 0.0]), dtype=np.float64)
        fov = float(camera["fov"])
        width = max(1, int(render["width"]))
        height = max(1, int(render["height"]))
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    if (
        position.shape != (3,)
        or target.shape != (3,)
        or up.shape != (3,)
        or not np.isfinite(position).all()
        or not np.isfinite(target).all()
        or not np.isfinite(up).all()
        or not math.isfinite(fov)
    ):
        return None

    forward = target - position
    forward_norm = float(np.linalg.norm(forward))
    if forward_norm <= 1e-9:
        return None
    backward = -forward / forward_norm
    right = np.cross(up, backward)
    right_norm = float(np.linalg.norm(right))
    if right_norm <= 1e-9:
        fallback = np.asarray([0.0, 0.0, 1.0], dtype=np.float64)
        right = np.cross(fallback, backward)
        right_norm = float(np.linalg.norm(right))
    if right_norm <= 1e-9:
        return None
    right /= right_norm
    true_up = np.cross(backward, right)

    # glTF matrices are serialized column-major. A perspective camera looks
    # down local -Z with local +Y as up.
    matrix = np.eye(4, dtype=np.float64)
    matrix[:3, 0] = right
    matrix[:3, 1] = true_up
    matrix[:3, 2] = backward
    matrix[:3, 3] = position
    camera_definition = {
        "name": "VNCCS Export Camera",
        "type": "perspective",
        "perspective": {
            "aspectRatio": width / height,
            "yfov": math.radians(max(1.0, min(179.0, fov))),
            "znear": 0.001,
        },
    }
    node = {
        "name": "VNCCS Export Camera",
        "camera": 0,
        "matrix": matrix.flatten(order="F").tolist(),
    }
    return camera_definition, node


def _document(
    segments: list[_Segment],
    binary_length: int,
    count: int,
    name: str,
    metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    buffer_views = []
    accessors = []
    attributes: dict[str, int] = {}
    for index, segment in enumerate(segments):
        buffer_views.append(
            {
                "buffer": 0,
                "byteOffset": segment.byte_offset,
                "byteLength": segment.byte_length,
                "target": _ARRAY_BUFFER,
            }
        )
        accessor: dict[str, Any] = {
            "bufferView": index,
            "byteOffset": 0,
            "componentType": segment.component_type,
            "count": count,
            "type": segment.accessor_type,
        }
        if segment.normalized:
            accessor["normalized"] = True
        if segment.minimum is not None:
            accessor["min"] = segment.minimum
            accessor["max"] = segment.maximum
        accessors.append(accessor)
        attributes[segment.name] = index

    document: dict[str, Any] = {
        "asset": {
            "version": "2.0",
            "generator": (
                "VNCCS 3D Factory; Gaussian GLB layout derived from "
                "PlayCanvas splat-transform"
            ),
        },
        "extensionsUsed": ["KHR_gaussian_splatting"],
        "scene": 0,
        "scenes": [{"name": name, "nodes": [0]}],
        "nodes": [{"name": name, "mesh": 0}],
        "buffers": [{"byteLength": binary_length}],
        "bufferViews": buffer_views,
        "accessors": accessors,
        "meshes": [
            {
                "name": name,
                "primitives": [
                    {
                        "attributes": attributes,
                        "mode": 0,
                        "extensions": {
                            "KHR_gaussian_splatting": {
                                "kernel": "ellipse",
                                "colorSpace": "srgb_rec709_display",
                                "sortingMethod": "cameraDistance",
                                "projection": "perspective",
                            }
                        },
                    }
                ],
            }
        ],
        "extras": {
            "vnccsRepresentation": "gaussian-splatting",
            "gaussians": count,
        },
    }
    camera = _camera_node(metadata)
    if camera is not None:
        camera_definition, camera_node = camera
        document["cameras"] = [camera_definition]
        document["nodes"].append(camera_node)
        document["scenes"][0]["nodes"].append(1)
    if isinstance(metadata, dict):
        document["extras"]["vnccsScene"] = metadata
    return document


def _sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(values, -60.0, 60.0)))


def _segment_chunk(
    records: np.ndarray,
    segment: _Segment,
    sh_degree: int,
) -> bytes:
    count = len(records)
    if segment.name == "POSITION":
        return np.column_stack(
            (records["x"], records["y"], records["z"])
        ).astype("<f4", copy=False).tobytes()
    if segment.name == "COLOR_0":
        dc = np.column_stack(
            tuple(
                np.asarray(records[f"f_dc_{index}"], dtype=np.float32)
                for index in range(3)
            )
        )
        rgb = np.clip(np.rint((dc * _SH_C0 + 0.5) * 255.0), 0, 255).astype(
            np.uint8
        )
        alpha = np.clip(
            np.rint(
                _sigmoid(
                    np.asarray(records["opacity"], dtype=np.float32)
                )[:, None]
                * 255.0
            ),
            0,
            255,
        ).astype(np.uint8)
        return np.concatenate((rgb, alpha), axis=1).tobytes()
    if segment.name == "KHR_gaussian_splatting:ROTATION":
        # PLY is wxyz; KHR_gaussian_splatting is xyzw.
        return np.column_stack(
            (
                records["rot_1"],
                records["rot_2"],
                records["rot_3"],
                records["rot_0"],
            )
        ).astype("<f4", copy=False).tobytes()
    if segment.name == "KHR_gaussian_splatting:SCALE":
        log_scale = np.column_stack(
            tuple(
                np.asarray(records[f"scale_{index}"], dtype=np.float32)
                for index in range(3)
            )
        )
        return np.exp(log_scale).astype("<f4", copy=False).tobytes()
    if segment.name == "KHR_gaussian_splatting:OPACITY":
        return _sigmoid(
            np.asarray(records["opacity"], dtype=np.float32)
        ).astype("<f4", copy=False).tobytes()
    if segment.name == "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0":
        return np.column_stack(
            tuple(
                np.asarray(records[f"f_dc_{index}"], dtype=np.float32)
                for index in range(3)
            )
        ).astype("<f4", copy=False).tobytes()

    coefficients_per_channel = (0, 3, 8, 15)[sh_degree]
    coefficient_offset = sum((3, 5, 7)[index] for index in range(segment.sh_degree - 1))
    coefficient = coefficient_offset + segment.sh_coefficient
    values = np.column_stack(
        tuple(
            np.asarray(
                records[
                    f"f_rest_{coefficient + channel * coefficients_per_channel}"
                ],
                dtype=np.float32,
            )
            for channel in range(3)
        )
    )
    if values.shape != (count, 3):
        raise ValueError(f"invalid SH attribute shape for {segment.name}")
    return values.astype("<f4", copy=False).tobytes()


def export_gaussian_ply_glb(
    source: str | os.PathLike[str],
    target: str | os.PathLike[str],
    *,
    name: str = "Gaussian scene",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write one transformed Gaussian PLY as a lossless splat GLB."""
    validation = validate_ply_payload(source)
    info = inspect_ply(source)
    count = info.vertex_count
    sh_degree = _detect_sh_degree(info.dtype.names or ())
    data = np.memmap(
        info.path,
        mode="r",
        dtype=info.dtype,
        offset=info.data_offset,
        shape=(count,),
    )
    output = Path(target).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_descriptor, temporary_raw = tempfile.mkstemp(
        prefix=f".{output.name}.",
        suffix=".tmp",
        dir=output.parent,
    )
    temporary = Path(temporary_raw)
    try:
        minimum, maximum = _position_bounds(data, count)
        segments, binary_length = _segments(count, sh_degree, minimum, maximum)
        document = _document(
            segments,
            binary_length,
            count,
            str(name or "Gaussian scene"),
            metadata,
        )
        json_bytes = json.dumps(
            document,
            ensure_ascii=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        json_length = _align4(len(json_bytes))
        binary_padded_length = _align4(binary_length)
        total_length = 12 + 8 + json_length + 8 + binary_padded_length
        if total_length > _GLB_LIMIT:
            raise ValueError(
                "Gaussian GLB exceeds the 4 GiB limit of the GLB 2.0 container"
            )

        with os.fdopen(temporary_descriptor, "wb") as handle:
            handle.write(struct.pack("<4sII", b"glTF", 2, total_length))
            handle.write(struct.pack("<I4s", json_length, b"JSON"))
            handle.write(json_bytes)
            handle.write(b" " * (json_length - len(json_bytes)))
            handle.write(struct.pack("<I4s", binary_padded_length, b"BIN\x00"))
            for segment in segments:
                written = 0
                for start in range(0, count, _CHUNK):
                    payload = _segment_chunk(
                        data[start : start + _CHUNK],
                        segment,
                        sh_degree,
                    )
                    handle.write(payload)
                    written += len(payload)
                if written != segment.byte_length:
                    raise RuntimeError(
                        f"short Gaussian GLB attribute {segment.name}: "
                        f"{written} != {segment.byte_length}"
                    )
                padding = _align4(written) - written
                if padding:
                    handle.write(b"\x00" * padding)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
    except Exception:
        try:
            os.close(temporary_descriptor)
        except OSError:
            pass
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    finally:
        del data

    return {
        "path": str(output),
        "format": "glb",
        "representation": "gaussian-splatting",
        "extension": "KHR_gaussian_splatting",
        "gaussians": count,
        "objects": int(validation.get("objects", 1)),
        "sh_degree": sh_degree,
        "bytes": output.stat().st_size,
        "camera": _camera_node(metadata) is not None,
    }


def export_gaussian_scene_glb(
    sources: Iterable[tuple[str | os.PathLike[str], Any]],
    target: str | os.PathLike[str],
    *,
    names: Iterable[str] | None = None,
    metadata: dict[str, Any] | None = None,
    **_legacy_mesh_options: Any,
) -> dict[str, Any]:
    """Compatibility wrapper that combines transformed objects before GLB export."""
    source_entries = list(sources)
    if not source_entries:
        raise ValueError("the scene contains no Gaussian objects")
    output = Path(target).resolve()
    with tempfile.TemporaryDirectory(prefix="vnccs-gaussian-glb-") as temporary:
        combined = Path(temporary) / "scene.ply"
        ply_result = export_scene_ply(source_entries, combined, metadata=metadata)
        provided_names = list(names or ())
        name = provided_names[0] if len(provided_names) == 1 else "Gaussian scene"
        result = export_gaussian_ply_glb(
            combined,
            output,
            name=name,
            metadata=metadata,
        )
        result["objects"] = ply_result["objects"]
        result["source_gaussians"] = ply_result.get(
            "source_gaussians",
            ply_result["gaussians"],
        )
        result["dropped_gaussians"] = ply_result.get("dropped_gaussians", 0)
        return result
