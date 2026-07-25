"""Safe Gaussian PLY transforms and scene export for VNCCS 3D Factory.

TripoSplat emits binary little-endian 3D Gaussian PLY files.  This module
applies a scene object's translation, XYZ Euler rotation, and uniform scale to
both the Gaussian centers and covariance representation, then writes one
standards-compatible PLY/SPLAT asset.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np


LOGGER = logging.getLogger("vnccs.3d_factory.gaussian_scene")
_MAX_HEADER_BYTES = 64 * 1024
_MAX_VERTICES = 64 * 1024 * 1024
_CHUNK = 65_536
_SCENE_METADATA_COMMENT = "comment vnccs_scene_metadata_base64 "
# TripoSplat's official Three.js viewer applies child yaw +90° around Y,
# followed by parent pitch 180° around X. Canonical model.ply files and their
# disposable cached SPLAT derivatives remain in TripoSplat's native export
# frame; every VNCCS scene/object export bakes this canonical orientation
# before its editable scene transform.
_CANONICAL_ORIENTATION = np.asarray(
    [
        [0.0, 0.0, 1.0],
        [0.0, -1.0, 0.0],
        [1.0, 0.0, 0.0],
    ],
    dtype=np.float32,
)
_CANONICAL_QUATERNION = np.asarray(
    [0.0, math.sqrt(0.5), 0.0, math.sqrt(0.5)],
    dtype=np.float32,
)
_TYPE_MAP = {
    "char": "i1",
    "int8": "i1",
    "uchar": "u1",
    "uint8": "u1",
    "short": "<i2",
    "int16": "<i2",
    "ushort": "<u2",
    "uint16": "<u2",
    "int": "<i4",
    "int32": "<i4",
    "uint": "<u4",
    "uint32": "<u4",
    "float": "<f4",
    "float32": "<f4",
    "double": "<f8",
    "float64": "<f8",
}
_PLY_TYPE_NAME = {
    "i1": "char",
    "u1": "uchar",
    "<i2": "short",
    "<u2": "ushort",
    "<i4": "int",
    "<u4": "uint",
    "<f4": "float",
    "<f8": "double",
}
_REQUIRED = {
    "x",
    "y",
    "z",
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    "opacity",
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
}
_CORE_FLOAT_FIELDS = tuple(sorted(_REQUIRED))


@dataclass(frozen=True)
class PlyInfo:
    path: Path
    vertex_count: int
    data_offset: int
    dtype: np.dtype


def _read_header(path: Path) -> tuple[bytes, int]:
    with path.open("rb") as handle:
        data = b""
        while len(data) <= _MAX_HEADER_BYTES:
            block = handle.read(4096)
            if not block:
                break
            data += block
            marker = data.find(b"end_header\n")
            if marker >= 0:
                return data[: marker + len(b"end_header\n")], marker + len(b"end_header\n")
    raise ValueError(f"{path.name}: missing or oversized PLY header")


def inspect_ply(path: str | os.PathLike[str]) -> PlyInfo:
    source = Path(path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    header, offset = _read_header(source)
    try:
        lines = header.decode("ascii").splitlines()
    except UnicodeDecodeError as exc:
        raise ValueError(f"{source.name}: PLY header is not ASCII") from exc
    if not lines or lines[0].strip() != "ply":
        raise ValueError(f"{source.name}: not a PLY file")
    if "format binary_little_endian 1.0" not in lines:
        raise ValueError(f"{source.name}: only binary little-endian PLY is supported")

    count: int | None = None
    fields: list[tuple[str, str]] = []
    in_vertices = False
    for line in lines[1:]:
        parts = line.strip().split()
        if not parts or parts[0] in {"comment", "obj_info"}:
            continue
        if parts[0] == "element":
            in_vertices = len(parts) == 3 and parts[1] == "vertex"
            if in_vertices:
                try:
                    count = int(parts[2])
                except ValueError as exc:
                    raise ValueError(f"{source.name}: invalid vertex count") from exc
            continue
        if parts[0] == "property" and in_vertices:
            if len(parts) != 3 or parts[1] == "list":
                raise ValueError(f"{source.name}: list PLY properties are not supported")
            scalar = _TYPE_MAP.get(parts[1])
            if scalar is None:
                raise ValueError(f"{source.name}: unsupported PLY property type {parts[1]!r}")
            name = parts[2]
            if not name.replace("_", "").isalnum() or name in {field[0] for field in fields}:
                raise ValueError(f"{source.name}: invalid or duplicate PLY property {name!r}")
            fields.append((name, scalar))

    if count is None or count < 0 or count > _MAX_VERTICES:
        raise ValueError(f"{source.name}: invalid or unsafe vertex count")
    dtype = np.dtype(fields)
    missing = sorted(_REQUIRED.difference(dtype.names or ()))
    if missing:
        raise ValueError(f"{source.name}: missing Gaussian fields: {', '.join(missing)}")
    expected = offset + count * dtype.itemsize
    actual_size = source.stat().st_size
    if expected != actual_size:
        relation = "truncated" if expected > actual_size else "contains trailing data"
        raise ValueError(f"{source.name}: {relation} in PLY vertex payload")
    return PlyInfo(source, count, offset, dtype)


def validate_ply_payload(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Read every generated record and reject non-finite or degenerate data."""
    info = inspect_ply(path)
    if info.vertex_count <= 0:
        raise ValueError(f"{info.path.name}: Gaussian PLY contains no vertices")
    data = np.memmap(
        info.path,
        mode="r",
        dtype=info.dtype,
        offset=info.data_offset,
        shape=(info.vertex_count,),
    )
    float_names = [
        name
        for name in info.dtype.names or ()
        if info.dtype.fields[name][0].kind == "f"
    ]
    invalid_values = 0
    invalid_scales = 0
    invalid_quaternions = 0
    ranges: dict[str, list[float]] = {}
    try:
        for start in range(0, info.vertex_count, _CHUNK):
            records = data[start : start + _CHUNK]
            for name in float_names:
                values = np.asarray(records[name], dtype=np.float32)
                finite = np.isfinite(values)
                invalid_values += int((~finite).sum())
                if finite.any():
                    current = [float(values[finite].min()), float(values[finite].max())]
                    previous = ranges.get(name)
                    ranges[name] = (
                        current
                        if previous is None
                        else [min(previous[0], current[0]), max(previous[1], current[1])]
                    )
            log_scales = np.column_stack(
                tuple(np.asarray(records[f"scale_{index}"], dtype=np.float64) for index in range(3))
            )
            with np.errstate(over="ignore", under="ignore", invalid="ignore"):
                decoded_scales = np.exp(log_scales)
            invalid_scales += int(
                ((~np.isfinite(decoded_scales)) | (decoded_scales <= 0)).sum()
            )
            rotation = np.column_stack(
                tuple(np.asarray(records[f"rot_{index}"], dtype=np.float32) for index in range(4))
            )
            norms = np.linalg.norm(rotation, axis=1)
            invalid_quaternions += int(((~np.isfinite(norms)) | (norms <= 1e-12)).sum())
    finally:
        del data
    if invalid_values or invalid_scales or invalid_quaternions:
        raise ValueError(
            f"{info.path.name}: invalid Gaussian payload: "
            f"{invalid_values:,} NaN/Inf value(s), "
            f"{invalid_scales:,} invalid scale(s), "
            f"{invalid_quaternions:,} degenerate quaternion(s)"
        )
    return {
        "path": str(info.path),
        "gaussians": info.vertex_count,
        "invalid_values": 0,
        "invalid_scales": 0,
        "invalid_quaternions": 0,
        "ranges": ranges,
    }


def validate_splat_payload(
    path: str | os.PathLike[str],
    expected_gaussians: int | None = None,
) -> dict[str, Any]:
    source = Path(path).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    size = source.stat().st_size
    if size % 32:
        raise ValueError(f"{source.name}: SPLAT payload is not aligned to 32-byte records")
    count = size // 32
    if count <= 0:
        raise ValueError(f"{source.name}: SPLAT payload contains no records")
    if expected_gaussians is not None and count != int(expected_gaussians):
        raise ValueError(
            f"{source.name}: contains {count:,} records; expected {int(expected_gaussians):,}"
        )
    raw = np.memmap(source, mode="r", dtype=np.uint8, shape=(count, 32))
    invalid_values = 0
    invalid_scales = 0
    invalid_rotations = 0
    try:
        for start in range(0, count, _CHUNK):
            records = np.ascontiguousarray(raw[start : start + _CHUNK])
            xyz = records[:, 0:12].reshape(-1).view("<f4").reshape(-1, 3)
            scales = records[:, 12:24].reshape(-1).view("<f4").reshape(-1, 3)
            invalid_values += int((~np.isfinite(xyz)).sum() + (~np.isfinite(scales)).sum())
            invalid_scales += int((scales <= 0).sum())
            rotations = (records[:, 28:32].astype(np.float32) - 128.0) / 128.0
            rotation_norms = np.linalg.norm(rotations, axis=1)
            invalid_rotations += int(
                ((~np.isfinite(rotation_norms)) | (rotation_norms <= 1e-12)).sum()
            )
    finally:
        del raw
    if invalid_values or invalid_scales or invalid_rotations:
        raise ValueError(
            f"{source.name}: invalid SPLAT payload: "
            f"{invalid_values:,} NaN/Inf value(s), "
            f"{invalid_scales:,} non-positive scale(s), "
            f"{invalid_rotations:,} degenerate rotation(s)"
        )
    return {
        "path": str(source),
        "gaussians": count,
        "bytes": size,
        "invalid_values": 0,
        "invalid_scales": 0,
        "invalid_rotations": 0,
    }


def normalize_transform(value: Any) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}

    def vector(key: str, default: tuple[float, float, float]) -> list[float]:
        raw = data.get(key, default)
        if not isinstance(raw, (list, tuple)) or len(raw) != 3:
            raw = default
        output = []
        for index, fallback in enumerate(default):
            try:
                number = float(raw[index])
            except (TypeError, ValueError, OverflowError):
                number = fallback
            output.append(number if math.isfinite(number) else fallback)
        return output

    position = [max(-100_000.0, min(100_000.0, item)) for item in vector("position", (0.0, 0.0, 0.0))]
    rotation = [((item + 180.0) % 360.0) - 180.0 for item in vector("rotation", (0.0, 0.0, 0.0))]
    try:
        scale = float(data.get("scale", 1.0))
    except (TypeError, ValueError, OverflowError):
        scale = 1.0
    if not math.isfinite(scale):
        scale = 1.0
    return {
        "position": position,
        "rotation": rotation,
        "scale": max(0.001, min(1000.0, scale)),
    }


def _rotation_matrix_xyz(degrees: Iterable[float]) -> np.ndarray:
    x, y, z = (math.radians(float(item)) for item in degrees)
    sx, cx = math.sin(x), math.cos(x)
    sy, cy = math.sin(y), math.cos(y)
    sz, cz = math.sin(z), math.cos(z)
    # Three.js Euler order XYZ: R = Rz * Ry * Rx for column vectors.
    return np.asarray(
        [
            [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz],
            [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz],
            [-sy, sx * cy, cx * cy],
        ],
        dtype=np.float32,
    )


def _rotation_quaternion_xyz(degrees: Iterable[float]) -> np.ndarray:
    x, y, z = (math.radians(float(item)) * 0.5 for item in degrees)
    s1, c1 = math.sin(x), math.cos(x)
    s2, c2 = math.sin(y), math.cos(y)
    s3, c3 = math.sin(z), math.cos(z)
    # w, x, y, z to match TripoSplat's PLY representation.
    return np.asarray(
        [
            c1 * c2 * c3 - s1 * s2 * s3,
            s1 * c2 * c3 + c1 * s2 * s3,
            c1 * s2 * c3 - s1 * c2 * s3,
            c1 * c2 * s3 + s1 * s2 * c3,
        ],
        dtype=np.float32,
    )


def _compose_quaternion(parent: np.ndarray, child: np.ndarray) -> np.ndarray:
    pw, px, py, pz = parent
    cw, cx, cy, cz = (child[:, index] for index in range(4))
    result = np.empty_like(child, dtype=np.float32)
    result[:, 0] = pw * cw - px * cx - py * cy - pz * cz
    result[:, 1] = pw * cx + px * cw + py * cz - pz * cy
    result[:, 2] = pw * cy - px * cz + py * cw + pz * cx
    result[:, 3] = pw * cz + px * cy - py * cx + pz * cw
    norm = np.linalg.norm(result, axis=1, keepdims=True)
    return result / np.maximum(norm, 1e-12)


def _transform_records(records: np.ndarray, transform: Any) -> np.ndarray:
    normalized = normalize_transform(transform)
    result = records.copy()
    xyz = np.column_stack((records["x"], records["y"], records["z"])).astype(np.float32, copy=False)
    rotation = _rotation_matrix_xyz(normalized["rotation"])
    position = np.asarray(normalized["position"], dtype=np.float32)
    xyz = xyz @ _CANONICAL_ORIENTATION.T
    xyz = (xyz @ rotation.T) * np.float32(normalized["scale"]) + position
    result["x"], result["y"], result["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]

    if {"nx", "ny", "nz"}.issubset(records.dtype.names or ()):
        normals = np.column_stack((records["nx"], records["ny"], records["nz"])).astype(np.float32, copy=False)
        normals = normals @ _CANONICAL_ORIENTATION.T
        normals = normals @ rotation.T
        result["nx"], result["ny"], result["nz"] = normals[:, 0], normals[:, 1], normals[:, 2]

    log_scale = np.float32(math.log(normalized["scale"]))
    for name in ("scale_0", "scale_1", "scale_2"):
        result[name] = records[name] + log_scale

    quaternions = np.column_stack(tuple(records[f"rot_{index}"] for index in range(4))).astype(
        np.float32, copy=False
    )
    quaternions = _compose_quaternion(_CANONICAL_QUATERNION, quaternions)
    quaternions = _compose_quaternion(_rotation_quaternion_xyz(normalized["rotation"]), quaternions)
    for index in range(4):
        result[f"rot_{index}"] = quaternions[:, index]
    return result


def _core_record_mask(records: np.ndarray) -> tuple[np.ndarray, dict[str, int]]:
    """Return records that can safely represent a rendered Gaussian.

    TripoSplat PLY files may contain optional normal/SH fields in addition to
    the fields consumed by the compact SPLAT renderer.  A bad optional
    coefficient can be neutralized, but a bad center, color, opacity, scale,
    or quaternion makes the complete Gaussian unusable and must remove that
    record from an exported scene.
    """
    count = len(records)
    valid = np.ones(count, dtype=bool)
    invalid_core_values = 0
    with np.errstate(over="ignore", under="ignore", invalid="ignore"):
        for name in _CORE_FLOAT_FIELDS:
            values = np.asarray(records[name], dtype=np.float32)
            finite = np.isfinite(values)
            invalid_core_values += int((~finite).sum())
            valid &= finite

        log_scales = np.column_stack(
            tuple(np.asarray(records[f"scale_{index}"], dtype=np.float64) for index in range(3))
        )
        decoded_scales = np.exp(log_scales)
        valid_scale_values = np.isfinite(decoded_scales) & (decoded_scales > 0)
        invalid_scales = int((~valid_scale_values).sum())
        valid &= valid_scale_values.all(axis=1)

        rotation = np.column_stack(
            tuple(np.asarray(records[f"rot_{index}"], dtype=np.float32) for index in range(4))
        )
        norms = np.linalg.norm(rotation, axis=1)
        valid_quaternions = np.isfinite(norms) & (norms > 1e-12)
        invalid_quaternions = int((~valid_quaternions).sum())
        valid &= valid_quaternions

    return valid, {
        "invalid_core_values": invalid_core_values,
        "invalid_scales": invalid_scales,
        "invalid_quaternions": invalid_quaternions,
    }


def _prepare_export_records(
    records: np.ndarray,
    transform: Any,
) -> tuple[np.ndarray, dict[str, int]]:
    """Sanitize one source chunk and return only strictly valid output rows."""
    source_count = len(records)
    source_mask, source_diagnostics = _core_record_mask(records)
    prepared = records[source_mask].copy()

    repaired_values = 0
    optional_fields = [
        name
        for name in records.dtype.names or ()
        if records.dtype.fields[name][0].kind == "f" and name not in _REQUIRED
    ]
    with np.errstate(over="ignore", invalid="ignore"):
        for name in optional_fields:
            values = np.asarray(prepared[name], dtype=np.float32)
            invalid = ~np.isfinite(values)
            repaired_values += int(invalid.sum())
            if invalid.any():
                prepared[name][invalid] = 0

        transformed = _transform_records(prepared, transform)

    output_mask, output_diagnostics = _core_record_mask(transformed)
    output = transformed[output_mask]
    return output, {
        "source_records": source_count,
        "valid_records": len(output),
        "dropped_records": source_count - len(output),
        "repaired_optional_values": repaired_values,
        "invalid_core_values": (
            source_diagnostics["invalid_core_values"]
            + output_diagnostics["invalid_core_values"]
        ),
        "invalid_scales": (
            source_diagnostics["invalid_scales"]
            + output_diagnostics["invalid_scales"]
        ),
        "invalid_quaternions": (
            source_diagnostics["invalid_quaternions"]
            + output_diagnostics["invalid_quaternions"]
        ),
    }


def _scan_export_source(info: PlyInfo, transform: Any) -> dict[str, Any]:
    data = np.memmap(
        info.path,
        mode="r",
        dtype=info.dtype,
        offset=info.data_offset,
        shape=(info.vertex_count,),
    )
    diagnostics: dict[str, Any] = {
        "path": str(info.path),
        "source_records": 0,
        "valid_records": 0,
        "dropped_records": 0,
        "repaired_optional_values": 0,
        "invalid_core_values": 0,
        "invalid_scales": 0,
        "invalid_quaternions": 0,
    }
    try:
        for start in range(0, info.vertex_count, _CHUNK):
            _prepared, chunk = _prepare_export_records(
                data[start : start + _CHUNK],
                transform,
            )
            for key in (
                "source_records",
                "valid_records",
                "dropped_records",
                "repaired_optional_values",
                "invalid_core_values",
                "invalid_scales",
                "invalid_quaternions",
            ):
                diagnostics[key] += int(chunk[key])
    finally:
        del data
    if diagnostics["valid_records"] <= 0:
        raise ValueError(
            f"{info.path.name}: no valid Gaussian records remain after sanitization "
            f"({diagnostics['source_records']:,} source records)"
        )
    return diagnostics


def _encode_scene_metadata_comment(metadata: Any) -> str | None:
    if metadata is None:
        return None
    if not isinstance(metadata, dict):
        raise ValueError("Gaussian scene metadata must be an object")
    encoded = json.dumps(
        metadata,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("ascii")
    token = base64.urlsafe_b64encode(encoded).decode("ascii")
    line = f"{_SCENE_METADATA_COMMENT}{token}"
    if len(line.encode("ascii")) > _MAX_HEADER_BYTES // 2:
        raise ValueError("Gaussian scene metadata is too large for a PLY header")
    return line


def read_ply_scene_metadata(path: str | os.PathLike[str]) -> dict[str, Any] | None:
    """Return VNCCS camera/frame metadata embedded in a Gaussian PLY header."""
    source = Path(path).resolve()
    header, _offset = _read_header(source)
    try:
        lines = header.decode("ascii").splitlines()
    except UnicodeDecodeError as exc:
        raise ValueError(f"{source.name}: PLY header is not ASCII") from exc
    matches = [
        line[len(_SCENE_METADATA_COMMENT) :].strip()
        for line in lines
        if line.startswith(_SCENE_METADATA_COMMENT)
    ]
    if not matches:
        return None
    if len(matches) != 1 or not matches[0]:
        raise ValueError(f"{source.name}: invalid VNCCS scene metadata comment")
    try:
        decoded = base64.b64decode(matches[0], altchars=b"-_", validate=True)
        value = json.loads(decoded.decode("ascii"))
    except (ValueError, binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{source.name}: invalid VNCCS scene metadata payload") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{source.name}: VNCCS scene metadata is not an object")
    return value


def _ply_header(count: int, dtype: np.dtype, metadata: Any = None) -> bytes:
    lines = [
        "ply",
        "format binary_little_endian 1.0",
        "comment VNCCS 3D Factory Gaussian scene",
    ]
    metadata_comment = _encode_scene_metadata_comment(metadata)
    if metadata_comment:
        lines.append(metadata_comment)
    lines.append(f"element vertex {count}")
    for name in dtype.names or ():
        scalar = dtype.fields[name][0].str
        scalar = scalar[1:] if scalar.startswith("|") else scalar
        type_name = _PLY_TYPE_NAME.get(scalar)
        if type_name is None:
            raise ValueError(f"cannot write PLY field {name!r} with dtype {scalar!r}")
        lines.append(f"property {type_name} {name}")
    lines.append("end_header")
    return ("\n".join(lines) + "\n").encode("ascii")


def _atomic_target(target: Path) -> tuple[Path, int]:
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, raw = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    return Path(raw), handle


def export_scene_ply(
    sources: Iterable[tuple[str | os.PathLike[str], Any]],
    target: str | os.PathLike[str],
    *,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    entries = []
    for path, transform in sources:
        info = inspect_ply(path)
        normalized_transform = normalize_transform(transform)
        diagnostics = _scan_export_source(info, normalized_transform)
        entries.append((info, normalized_transform, diagnostics))
    if not entries:
        raise ValueError("the scene contains no Gaussian objects")
    names = entries[0][0].dtype.names
    descriptor = entries[0][0].dtype.descr
    for info, _transform, _diagnostics in entries[1:]:
        if info.dtype.names != names or info.dtype.descr != descriptor:
            raise ValueError("scene objects use incompatible Gaussian PLY layouts")

    total = sum(diagnostics["valid_records"] for _info, _transform, diagnostics in entries)
    output = Path(target).resolve()
    temporary, descriptor_handle = _atomic_target(output)
    try:
        with os.fdopen(descriptor_handle, "wb") as handle:
            handle.write(_ply_header(total, entries[0][0].dtype, metadata))
            for info, transform, _diagnostics in entries:
                data = np.memmap(
                    info.path,
                    mode="r",
                    dtype=info.dtype,
                    offset=info.data_offset,
                    shape=(info.vertex_count,),
                )
                for start in range(0, info.vertex_count, _CHUNK):
                    transformed, _chunk_diagnostics = _prepare_export_records(
                        data[start : start + _CHUNK],
                        transform,
                    )
                    handle.write(transformed.tobytes())
                del data
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
    except Exception:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    validation = validate_ply_payload(output)
    diagnostics = [entry[2] for entry in entries]
    dropped = sum(item["dropped_records"] for item in diagnostics)
    repaired = sum(item["repaired_optional_values"] for item in diagnostics)
    if dropped or repaired:
        LOGGER.warning(
            "Sanitized Gaussian scene export %s: %s optional NaN/Inf value(s) "
            "neutralized, %s unusable Gaussian record(s) removed",
            output,
            f"{repaired:,}",
            f"{dropped:,}",
        )
        for item in diagnostics:
            if item["dropped_records"] or item["repaired_optional_values"]:
                LOGGER.warning(
                    "Gaussian source %s: %s/%s records exported, "
                    "%s optional value(s) repaired, %s record(s) removed",
                    item["path"],
                    f"{item['valid_records']:,}",
                    f"{item['source_records']:,}",
                    f"{item['repaired_optional_values']:,}",
                    f"{item['dropped_records']:,}",
                )
    return {
        "path": str(output),
        "gaussians": total,
        "source_gaussians": sum(item["source_records"] for item in diagnostics),
        "dropped_gaussians": dropped,
        "repaired_values": repaired,
        "objects": len(entries),
        "format": "ply",
        "validation": validation,
        "sources": diagnostics,
    }


def ply_to_splat(source: str | os.PathLike[str], target: str | os.PathLike[str]) -> dict[str, Any]:
    validate_ply_payload(source)
    info = inspect_ply(source)
    data = np.memmap(
        info.path,
        mode="r",
        dtype=info.dtype,
        offset=info.data_offset,
        shape=(info.vertex_count,),
    )
    opacity = 1.0 / (1.0 + np.exp(-np.clip(np.asarray(data["opacity"], dtype=np.float32), -60.0, 60.0)))
    log_scales = np.column_stack(
        tuple(np.asarray(data[f"scale_{index}"], dtype=np.float32) for index in range(3))
    )
    # A malformed Gaussian must not overflow the sort weights or the packed
    # SPLAT payload. The bounds are deliberately much wider than useful scene
    # scales while still remaining finite in float32.
    scales = np.exp(np.clip(log_scales, -30.0, 30.0))
    weights = opacity * np.prod(scales, axis=1)
    order = np.argsort(-weights, kind="stable")

    output = Path(target).resolve()
    temporary, descriptor_handle = _atomic_target(output)
    c0 = np.float32(0.28209479177387814)
    try:
        with os.fdopen(descriptor_handle, "wb") as handle:
            for start in range(0, info.vertex_count, _CHUNK):
                indices = order[start : start + _CHUNK]
                xyz = np.column_stack((data["x"][indices], data["y"][indices], data["z"][indices])).astype(
                    "<f4", copy=False
                )
                chunk_scales = scales[indices].astype("<f4", copy=False)
                rgb = np.column_stack(
                    tuple(np.asarray(data[f"f_dc_{index}"][indices], dtype=np.float32) for index in range(3))
                )
                rgb = np.clip((rgb * c0 + 0.5) * 255.0, 0, 255).astype(np.uint8)
                alpha = np.clip(opacity[indices, None] * 255.0, 0, 255).astype(np.uint8)
                rgba = np.concatenate((rgb, alpha), axis=1)
                rotation = np.column_stack(
                    tuple(np.asarray(data[f"rot_{index}"][indices], dtype=np.float32) for index in range(4))
                )
                rotation /= np.maximum(np.linalg.norm(rotation, axis=1, keepdims=True), 1e-12)
                rotation = np.clip(rotation * 128.0 + 128.0, 0, 255).astype(np.uint8)
                packed = np.empty((len(indices), 32), dtype=np.uint8)
                packed[:, 0:12] = xyz.view(np.uint8).reshape(-1, 12)
                packed[:, 12:24] = chunk_scales.view(np.uint8).reshape(-1, 12)
                packed[:, 24:28] = rgba
                packed[:, 28:32] = rotation
                handle.write(packed.tobytes())
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output)
    except Exception:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    finally:
        del data
    return {"path": str(output), "gaussians": info.vertex_count, "format": "splat"}


def export_gaussian_scene(
    sources: Iterable[tuple[str | os.PathLike[str], Any]],
    ply_target: str | os.PathLike[str],
    splat_target: str | os.PathLike[str] | None = None,
    *,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ply_result = export_scene_ply(sources, ply_target, metadata=metadata)
    result = {"ply": ply_result}
    if splat_target is not None:
        result["splat"] = ply_to_splat(ply_target, splat_target)
    return result
