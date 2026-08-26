"""Versioned scene primitives for VNCCS 3D Factory interior editing.

The Factory backend keeps binary Gaussian assets separate from lightweight
editor state.  This module owns normalization for the latter so room-layout
data can evolve without coupling it to generation or PLY export code.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any


ID_RE = re.compile(r"^[a-f0-9]{32}$")
HEX_COLOR_RE = re.compile(r"^#[0-9a-f]{6}$", re.IGNORECASE)

MAX_LEVELS = 64
MAX_BUILDINGS = 64
MAX_MATERIALS = 512
MAX_WALLS = 4096
MAX_ROOMS = 1024
MAX_OPENINGS = 4096
MAX_CAMERA_TRACKS = 16
MAX_CAMERA_KEYFRAMES = 1000

DEFAULT_LEVEL_HEIGHT = 2.8
DEFAULT_SLAB_THICKNESS = 0.15
DEFAULT_WALL_HEIGHT = 2.8
DEFAULT_WALL_THICKNESS = 0.12


def _finite(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def _bounded(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    return max(minimum, min(maximum, _finite(value, fallback)))


def _clean_text(value: Any, fallback: str, maximum: int = 96) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]+", "", str(value or "")).strip()
    return text[:maximum] or fallback


def _id(value: Any) -> str:
    text = str(value or "").lower()
    return text if ID_RE.fullmatch(text) else ""


def _required_id(value: Any, label: str, *, strict: bool) -> str:
    normalized = _id(value)
    if normalized:
        return normalized
    if strict:
        raise ValueError(f"{label} is invalid")
    return ""


def _stable_id(scene_id: str, namespace: str) -> str:
    return hashlib.sha256(f"{scene_id}:{namespace}".encode("utf-8")).hexdigest()[:32]


def _point2(value: Any, fallback: tuple[float, float] = (0.0, 0.0)) -> list[float]:
    source = value if isinstance(value, (list, tuple)) else fallback
    return [
        _finite(source[index] if index < len(source) else fallback[index], fallback[index])
        for index in range(2)
    ]


def _point3(
    value: Any,
    fallback: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> list[float]:
    source = value if isinstance(value, (list, tuple)) else fallback
    return [
        _finite(source[index] if index < len(source) else fallback[index], fallback[index])
        for index in range(3)
    ]


def _simple_polygon(points: list[list[float]]) -> bool:
    if any(
        math.dist(points[index], points[(index + 1) % len(points)]) < 0.001
        for index in range(len(points))
    ):
        return False
    area = sum(
        points[index][0] * points[(index + 1) % len(points)][1]
        - points[(index + 1) % len(points)][0] * points[index][1]
        for index in range(len(points))
    ) * 0.5
    if abs(area) < 1e-6:
        return False

    def orientation(a: list[float], b: list[float], c: list[float]) -> float:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    def on_segment(a: list[float], b: list[float], point: list[float]) -> bool:
        return (
            min(a[0], b[0]) - 1e-9 <= point[0] <= max(a[0], b[0]) + 1e-9
            and min(a[1], b[1]) - 1e-9 <= point[1] <= max(a[1], b[1]) + 1e-9
        )

    def intersects(
        a: list[float], b: list[float], c: list[float], d: list[float],
    ) -> bool:
        values = (
            orientation(a, b, c),
            orientation(a, b, d),
            orientation(c, d, a),
            orientation(c, d, b),
        )
        if values[0] * values[1] < 0 and values[2] * values[3] < 0:
            return True
        return (
            (abs(values[0]) <= 1e-9 and on_segment(a, b, c))
            or (abs(values[1]) <= 1e-9 and on_segment(a, b, d))
            or (abs(values[2]) <= 1e-9 and on_segment(c, d, a))
            or (abs(values[3]) <= 1e-9 and on_segment(c, d, b))
        )

    count = len(points)
    for left in range(count):
        a = points[left]
        b = points[(left + 1) % count]
        for right in range(left + 1, count):
            if right in {left, (left + 1) % count} or (right + 1) % count == left:
                continue
            c = points[right]
            d = points[(right + 1) % count]
            if intersects(a, b, c, d):
                return False
    return True


def _quaternion(value: Any) -> list[float]:
    source = _point3(value, (0.0, 0.0, 0.0))
    try:
        w = _finite(value[3], 1.0) if isinstance(value, (list, tuple)) else 1.0
    except IndexError:
        w = 1.0
    length = math.sqrt(sum(component * component for component in (*source, w)))
    if length < 1e-12:
        return [0.0, 0.0, 0.0, 1.0]
    return [source[0] / length, source[1] / length, source[2] / length, w / length]


def default_level(scene_id: str) -> dict[str, Any]:
    return {
        "level_id": _stable_id(scene_id, "level:0"),
        "name": "Level 1",
        "elevation": 0.0,
        "height": DEFAULT_LEVEL_HEIGHT,
        "slab_thickness": DEFAULT_SLAB_THICKNESS,
        "visible": True,
    }


def normalize_levels(scene_id: str, value: Any, *, strict: bool = False) -> list[dict[str, Any]]:
    source = value if isinstance(value, list) else []
    if strict and (not isinstance(value, list) or len(source) > MAX_LEVELS):
        raise ValueError("scene levels are invalid")
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(source[:MAX_LEVELS]):
        if not isinstance(raw, dict):
            if strict:
                raise ValueError("scene levels must be objects")
            continue
        level_id = _required_id(raw.get("level_id"), "level id", strict=strict)
        if not level_id or level_id in seen:
            if strict and level_id in seen:
                raise ValueError("scene level ids must be unique")
            continue
        output.append({
            "level_id": level_id,
            "name": _clean_text(raw.get("name"), f"Level {index + 1}", 80),
            "elevation": _bounded(raw.get("elevation"), -10000.0, 10000.0, 0.0),
            "height": _bounded(raw.get("height"), 0.1, 1000.0, DEFAULT_LEVEL_HEIGHT),
            "slab_thickness": _bounded(
                raw.get("slab_thickness"), 0.0, 100.0, DEFAULT_SLAB_THICKNESS,
            ),
            "visible": raw.get("visible") is not False,
        })
        seen.add(level_id)
    if not output:
        output.append(default_level(scene_id))
    output.sort(key=lambda item: (item["elevation"], item["level_id"]))
    return output


def _normalize_texture_slot(value: Any) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}
    texture_id = _id(data.get("texture_id"))
    output = {
        "color": (
            str(data.get("color")).lower()
            if HEX_COLOR_RE.fullmatch(str(data.get("color") or ""))
            else "#d7d2ca"
        ),
        "roughness": _bounded(data.get("roughness"), 0.0, 1.0, 0.78),
        "metalness": _bounded(data.get("metalness"), 0.0, 1.0, 0.0),
        "opacity": _bounded(data.get("opacity"), 0.0, 1.0, 1.0),
        "uv_scale": [
            _bounded(_point2(data.get("uv_scale"), (1.0, 1.0))[0], 0.001, 1000.0, 1.0),
            _bounded(_point2(data.get("uv_scale"), (1.0, 1.0))[1], 0.001, 1000.0, 1.0),
        ],
        "uv_rotation": _bounded(data.get("uv_rotation"), -36000.0, 36000.0, 0.0),
    }
    if texture_id:
        output["texture_id"] = texture_id
    return output


def normalize_materials(value: Any, *, strict: bool = False) -> list[dict[str, Any]]:
    source = value if isinstance(value, list) else []
    if strict and (not isinstance(value, list) or len(source) > MAX_MATERIALS):
        raise ValueError("scene materials are invalid")
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in source[:MAX_MATERIALS]:
        if not isinstance(raw, dict):
            if strict:
                raise ValueError("scene materials must be objects")
            continue
        material_id = _required_id(raw.get("material_id"), "material id", strict=strict)
        if not material_id or material_id in seen:
            if strict and material_id in seen:
                raise ValueError("scene material ids must be unique")
            continue
        kind = str(raw.get("kind") or "standard").lower()
        if kind not in {"standard", "glass"}:
            if strict:
                raise ValueError("scene material kind is invalid")
            kind = "standard"
        material = {
            "material_id": material_id,
            "name": _clean_text(raw.get("name"), "Material", 80),
            "kind": kind,
            **_normalize_texture_slot(raw),
        }
        material["transmission"] = _bounded(
            raw.get("transmission"), 0.0, 1.0, 1.0 if kind == "glass" else 0.0,
        )
        material["ior"] = _bounded(raw.get("ior"), 1.0, 2.5, 1.5)
        output.append(material)
        seen.add(material_id)
    return output


def normalize_architecture(
    scene_id: str,
    levels: list[dict[str, Any]],
    value: Any,
    *,
    strict: bool = False,
) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}
    if strict and not isinstance(value, dict):
        raise ValueError("scene architecture must be an object")
    level_ids = {item["level_id"] for item in levels}
    default_level_id = levels[0]["level_id"]
    materials = normalize_materials(data.get("materials", []), strict=strict)
    material_ids = {item["material_id"] for item in materials}

    has_building_schema = isinstance(data.get("buildings"), list)
    raw_buildings = data.get("buildings", [])
    raw_walls = data.get("walls", [])
    raw_rooms = data.get("rooms", [])
    if strict and (not isinstance(raw_buildings, list) or len(raw_buildings) > MAX_BUILDINGS):
        raise ValueError("scene buildings are invalid")
    buildings: list[dict[str, Any]] = []
    building_ids: set[str] = set()
    for index, raw in enumerate(
        (raw_buildings if isinstance(raw_buildings, list) else [])[:MAX_BUILDINGS]
    ):
        if not isinstance(raw, dict):
            if strict:
                raise ValueError("scene buildings must be objects")
            continue
        building_id = _required_id(raw.get("building_id"), "building id", strict=strict)
        if not building_id or building_id in building_ids:
            if strict and building_id in building_ids:
                raise ValueError("scene building ids must be unique")
            continue
        buildings.append({
            "building_id": building_id,
            "name": _clean_text(raw.get("name"), f"Building {index + 1}", 80),
            "position": _point3(raw.get("position")),
            "rotation_y": _bounded(raw.get("rotation_y"), -36000.0, 36000.0, 0.0),
            "visible": raw.get("visible") is not False,
            "locked": raw.get("locked") is True,
        })
        building_ids.add(building_id)
    # Preserve architecture created before Building ownership existed, but
    # treat an explicit empty list as intentional. New scenes and users who
    # delete their final Building must remain building-free.
    if (
        not buildings
        and not has_building_schema
        and (
            isinstance(raw_walls, list) and raw_walls
            or isinstance(raw_rooms, list) and raw_rooms
        )
    ):
        building_id = _stable_id(scene_id, "building:0")
        buildings.append({
            "building_id": building_id,
            "name": "Building 1",
            "position": [0.0, 0.0, 0.0],
            "rotation_y": 0.0,
            "visible": True,
            "locked": False,
        })
        building_ids.add(building_id)
    default_building_id = buildings[0]["building_id"] if buildings else ""

    def material_id(raw: Any) -> str:
        result = _id(raw)
        if result and result not in material_ids:
            if strict:
                raise ValueError("architecture references an unknown material")
            return ""
        return result

    def architecture_building_id(raw: dict[str, Any], label: str) -> str:
        requested = raw.get("building_id")
        result = _id(requested)
        if requested not in (None, "") and not result:
            if strict:
                raise ValueError(f"{label} building id is invalid")
            return ""
        if result and result not in building_ids:
            if strict:
                raise ValueError(f"{label} references an unknown building")
            return ""
        # Missing ownership belongs to the first Building only for legacy
        # architecture that never serialized this field. An explicit empty
        # value is a valid scene-root room or wall, even when Buildings exist.
        if not result and "building_id" not in raw:
            return default_building_id
        return result

    if strict and (not isinstance(raw_walls, list) or len(raw_walls) > MAX_WALLS):
        raise ValueError("scene walls are invalid")
    walls: list[dict[str, Any]] = []
    wall_ids: set[str] = set()
    for raw in (raw_walls if isinstance(raw_walls, list) else [])[:MAX_WALLS]:
        if not isinstance(raw, dict):
            if strict:
                raise ValueError("scene walls must be objects")
            continue
        wall_id = _required_id(raw.get("wall_id"), "wall id", strict=strict)
        if not wall_id or wall_id in wall_ids:
            if strict and wall_id in wall_ids:
                raise ValueError("scene wall ids must be unique")
            continue
        level_id = _id(raw.get("level_id")) or default_level_id
        if level_id not in level_ids:
            if strict:
                raise ValueError("wall references an unknown level")
            level_id = default_level_id
        building_id = architecture_building_id(raw, "wall")
        start = _point2(raw.get("start"))
        end = _point2(raw.get("end"), (1.0, 0.0))
        if math.dist(start, end) < 0.001:
            if strict:
                raise ValueError("wall length is too small")
            continue
        walls.append({
            "wall_id": wall_id,
            "name": _clean_text(raw.get("name"), "Wall", 80),
            "level_id": level_id,
            "building_id": building_id,
            "start": start,
            "end": end,
            "thickness": _bounded(
                raw.get("thickness"), 0.01, 10.0, DEFAULT_WALL_THICKNESS,
            ),
            "height": _bounded(raw.get("height"), 0.05, 1000.0, DEFAULT_WALL_HEIGHT),
            "elevation_offset": _bounded(raw.get("elevation_offset"), -1000.0, 1000.0, 0.0),
            "material_left": material_id(raw.get("material_left")),
            "material_right": material_id(raw.get("material_right")),
            "material_caps": material_id(raw.get("material_caps")),
            "visible": raw.get("visible") is not False,
            "locked": raw.get("locked") is True,
        })
        wall_ids.add(wall_id)

    if strict and (not isinstance(raw_rooms, list) or len(raw_rooms) > MAX_ROOMS):
        raise ValueError("scene rooms are invalid")
    rooms: list[dict[str, Any]] = []
    room_ids: set[str] = set()
    for raw in (raw_rooms if isinstance(raw_rooms, list) else [])[:MAX_ROOMS]:
        if not isinstance(raw, dict):
            if strict:
                raise ValueError("scene rooms must be objects")
            continue
        room_id = _required_id(raw.get("room_id"), "room id", strict=strict)
        if not room_id or room_id in room_ids:
            if strict and room_id in room_ids:
                raise ValueError("scene room ids must be unique")
            continue
        level_id = _id(raw.get("level_id")) or default_level_id
        if level_id not in level_ids:
            if strict:
                raise ValueError("room references an unknown level")
            level_id = default_level_id
        building_id = architecture_building_id(raw, "room")
        raw_polygon = raw.get("polygon", [])
        if not isinstance(raw_polygon, list) or not 3 <= len(raw_polygon) <= 512:
            if strict:
                raise ValueError("room polygon is invalid")
            continue
        polygon = [_point2(point) for point in raw_polygon]
        if not _simple_polygon(polygon):
            if strict:
                raise ValueError("room polygon must be simple and have non-zero area")
            continue
        floor = raw.get("floor") if isinstance(raw.get("floor"), dict) else {}
        ceiling = raw.get("ceiling") if isinstance(raw.get("ceiling"), dict) else {}
        raw_wall_ids = raw.get("wall_ids") if isinstance(raw.get("wall_ids"), list) else []
        normalized_wall_ids = [_id(value) for value in raw_wall_ids]
        linked_walls = {item["wall_id"]: item for item in walls}
        if strict and any(wall_id not in wall_ids for wall_id in normalized_wall_ids):
            raise ValueError("room references an unknown wall")
        if strict and len(set(normalized_wall_ids)) != len(normalized_wall_ids):
            raise ValueError("room perimeter wall ids must be unique")
        normalized_wall_ids = [wall_id for wall_id in normalized_wall_ids if wall_id in wall_ids]
        normalized_wall_ids = list(dict.fromkeys(normalized_wall_ids))
        if normalized_wall_ids:
            perimeter_valid = len(normalized_wall_ids) == len(polygon)
            if strict and not perimeter_valid:
                raise ValueError("room perimeter wall count does not match its polygon")
            for index, wall_id in enumerate(normalized_wall_ids if perimeter_valid else []):
                linked = linked_walls.get(wall_id)
                if (
                    linked is None
                    or linked["level_id"] != level_id
                    or linked["building_id"] != building_id
                ):
                    perimeter_valid = False
                    if not strict:
                        break
                    raise ValueError("room perimeter wall belongs to another floor or building")
                if (
                    math.dist(linked["start"], polygon[index]) > 1e-4
                    or math.dist(linked["end"], polygon[(index + 1) % len(polygon)]) > 1e-4
                ):
                    perimeter_valid = False
                    if not strict:
                        break
                    raise ValueError("room perimeter walls do not match its polygon")
            if not perimeter_valid:
                normalized_wall_ids = []
        rooms.append({
            "room_id": room_id,
            "name": _clean_text(raw.get("name"), "Room", 80),
            "level_id": level_id,
            "building_id": building_id,
            "polygon": polygon,
            "wall_ids": normalized_wall_ids,
            "floor": {
                "enabled": floor.get("enabled") is not False,
                "thickness": _bounded(floor.get("thickness"), 0.0, 10.0, 0.02),
                "material_id": material_id(floor.get("material_id")),
            },
            "ceiling": {
                "enabled": ceiling.get("enabled") is not False,
                "height": _bounded(ceiling.get("height"), 0.05, 1000.0, DEFAULT_LEVEL_HEIGHT),
                "thickness": _bounded(ceiling.get("thickness"), 0.0, 10.0, 0.02),
                "material_id": material_id(ceiling.get("material_id")),
            },
            "visible": raw.get("visible") is not False,
            "locked": raw.get("locked") is True,
        })
        room_ids.add(room_id)

    raw_openings = data.get("openings", [])
    if strict and (not isinstance(raw_openings, list) or len(raw_openings) > MAX_OPENINGS):
        raise ValueError("scene openings are invalid")
    openings: list[dict[str, Any]] = []
    opening_ids: set[str] = set()
    walls_by_id = {item["wall_id"]: item for item in walls}
    occupied_by_wall: dict[str, list[tuple[float, float]]] = {}
    for raw in (raw_openings if isinstance(raw_openings, list) else [])[:MAX_OPENINGS]:
        if not isinstance(raw, dict):
            if strict:
                raise ValueError("scene openings must be objects")
            continue
        opening_id = _required_id(raw.get("opening_id"), "opening id", strict=strict)
        wall_id = _required_id(raw.get("wall_id"), "opening wall id", strict=strict)
        if not opening_id or opening_id in opening_ids or wall_id not in wall_ids:
            if strict:
                raise ValueError("opening references an unknown wall or duplicate id")
            continue
        kind = str(raw.get("kind") or "empty").lower()
        if kind not in {"empty", "door", "window"}:
            if strict:
                raise ValueError("opening kind is invalid")
            kind = "empty"
        wall = walls_by_id[wall_id]
        wall_length = math.dist(wall["start"], wall["end"])
        requested_offset = _bounded(raw.get("offset"), 0.0, 1.0, 0.5)
        requested_width = _bounded(raw.get("width"), 0.05, 100.0, 0.9)
        requested_height = _bounded(
            raw.get("height"), 0.05, 100.0, 2.0 if kind == "door" else 1.2,
        )
        requested_sill = _bounded(
            raw.get("sill_height"), 0.0, 100.0, 0.0 if kind == "door" else 0.9,
        )
        width = min(requested_width, wall_length)
        height = min(requested_height, wall["height"])
        sill_height = min(requested_sill, max(0.0, wall["height"] - height))
        half = width / 2.0
        requested_center = requested_offset * wall_length
        occupied = occupied_by_wall.setdefault(wall_id, [])
        free_intervals: list[tuple[float, float]] = []
        cursor = 0.0
        for start, end in sorted(occupied):
            if start > cursor:
                free_intervals.append((cursor, start))
            cursor = max(cursor, end)
        if cursor < wall_length:
            free_intervals.append((cursor, wall_length))
        candidates: list[tuple[float, float]] = []
        for start, end in free_intervals:
            minimum = start + half
            maximum = end - half
            if minimum <= maximum + 1e-9:
                center = min(max(requested_center, minimum), maximum)
                candidates.append((abs(center - requested_center), center))
        if strict and (
            requested_width > wall_length + 1e-9
            or requested_center - half < -1e-9
            or requested_center + half > wall_length + 1e-9
            or requested_height + requested_sill > wall["height"] + 1e-9
            or not candidates
            or min(candidates)[0] > 1e-9
        ):
            raise ValueError("opening is outside its wall or overlaps another opening")
        if not candidates:
            continue
        _, center = min(candidates)
        offset = center / wall_length
        occupied.append((center - half, center + half))
        openings.append({
            "opening_id": opening_id,
            "wall_id": wall_id,
            "name": _clean_text(raw.get("name"), kind.title(), 80),
            "kind": kind,
            "offset": offset,
            "width": width,
            "height": height,
            "sill_height": sill_height,
            "material_id": material_id(raw.get("material_id")),
            "visible": raw.get("visible") is not False,
            "locked": raw.get("locked") is True,
        })
        opening_ids.add(opening_id)

    return {
        "units": "m",
        "materials": materials,
        "buildings": buildings,
        "walls": walls,
        "rooms": rooms,
        "openings": openings,
    }


def normalize_object_editor_properties(value: Any) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}
    collision = data.get("collision_proxy") if isinstance(data.get("collision_proxy"), dict) else {}
    mode = str(collision.get("mode") or "auto_box").lower()
    if mode not in {"auto_box", "box", "off"}:
        mode = "auto_box"
    light_transport = str(data.get("light_transport") or "opaque").lower()
    if light_transport not in {"opaque", "cutout", "transmissive"}:
        light_transport = "opaque"
    return {
        "collision_proxy": {
            "mode": mode,
            "center": _point3(collision.get("center")),
            "size": [
                _bounded(component, 0.001, 1000000.0, 1.0)
                for component in _point3(collision.get("size"), (1.0, 1.0, 1.0))
            ],
            "supports_objects": collision.get("supports_objects") is not False,
        },
        "light_transport": light_transport,
        "transmission": _bounded(data.get("transmission"), 0.0, 1.0, 1.0 if light_transport == "transmissive" else 0.0),
        "locked": data.get("locked") is True,
    }


def normalize_camera_tracks(value: Any, *, strict: bool = False) -> list[dict[str, Any]]:
    source = value if isinstance(value, list) else []
    if strict and (not isinstance(value, list) or len(source) > MAX_CAMERA_TRACKS):
        raise ValueError("camera tracks are invalid")
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    seen_keyframes: set[str] = set()
    total_keyframes = 0
    for raw in source[:MAX_CAMERA_TRACKS]:
        if not isinstance(raw, dict):
            if strict:
                raise ValueError("camera tracks must be objects")
            continue
        track_id = _required_id(raw.get("track_id"), "camera track id", strict=strict)
        if not track_id or track_id in seen:
            if strict and track_id in seen:
                raise ValueError("camera track ids must be unique")
            continue
        raw_keyframes = raw.get("keyframes", [])
        if not isinstance(raw_keyframes, list):
            if strict:
                raise ValueError("camera track keyframes are invalid")
            raw_keyframes = []
        keyframes: list[dict[str, Any]] = []
        keyframe_ids: set[str] = set()
        for frame in raw_keyframes:
            if total_keyframes >= MAX_CAMERA_KEYFRAMES:
                if strict:
                    raise ValueError("camera track keyframe limit was exceeded")
                break
            if not isinstance(frame, dict):
                if strict:
                    raise ValueError("camera keyframes must be objects")
                continue
            keyframe_id = _required_id(frame.get("keyframe_id"), "camera keyframe id", strict=strict)
            if (
                not keyframe_id
                or keyframe_id in keyframe_ids
                or keyframe_id in seen_keyframes
            ):
                if strict:
                    raise ValueError("camera keyframe ids must be unique within the scene")
                continue
            easing = str(frame.get("easing") or "smooth").lower()
            if easing not in {"linear", "smooth", "ease_in", "ease_out", "ease_in_out"}:
                easing = "smooth"
            keyframes.append({
                "keyframe_id": keyframe_id,
                "time": _bounded(frame.get("time"), 0.0, 86400.0, 0.0),
                "position": _point3(frame.get("position")),
                "quaternion": _quaternion(frame.get("quaternion")),
                "fov": _bounded(frame.get("fov"), 5.0, 120.0, 42.0),
                "focus_distance": _bounded(frame.get("focus_distance"), 0.001, 1000000.0, 1.0),
                "easing": easing,
            })
            keyframe_ids.add(keyframe_id)
            seen_keyframes.add(keyframe_id)
            total_keyframes += 1
        keyframes.sort(key=lambda item: (item["time"], item["keyframe_id"]))
        interpolation = str(raw.get("interpolation") or "catmullrom").lower()
        if interpolation not in {"linear", "catmullrom"}:
            interpolation = "catmullrom"
        duration = max(
            _bounded(raw.get("duration"), 0.1, 86400.0, 5.0),
            keyframes[-1]["time"] if keyframes else 0.1,
        )
        output.append({
            "track_id": track_id,
            "name": _clean_text(raw.get("name"), "Camera track", 80),
            "building_id": _id(raw.get("building_id")),
            "duration": duration,
            "fps": int(_bounded(raw.get("fps"), 1.0, 120.0, 30.0)),
            "interpolation": interpolation,
            "constant_speed": raw.get("constant_speed") is not False,
            "loop": raw.get("loop") is True,
            "keyframes": keyframes,
        })
        seen.add(track_id)
    return output


def normalize_lighting_extensions(value: Any) -> dict[str, Any]:
    data = value if isinstance(value, dict) else {}
    shadows = data.get("shadows") if isinstance(data.get("shadows"), dict) else {}
    quality = str(shadows.get("quality") or "medium").lower()
    if quality not in {"off", "low", "medium", "high", "ultra"}:
        quality = "medium"
    raw_lights = data.get("lights", [])
    lights = []
    seen: set[str] = set()
    for raw in (raw_lights if isinstance(raw_lights, list) else [])[:32]:
        if not isinstance(raw, dict):
            continue
        light_id = _id(raw.get("light_id"))
        if not light_id or light_id in seen:
            continue
        kind = str(raw.get("kind") or "point").lower()
        if kind not in {"point", "spot", "directional"}:
            kind = "point"
        color = str(raw.get("color") or "#ffffff").lower()
        if not HEX_COLOR_RE.fullmatch(color):
            color = "#ffffff"
        lights.append({
            "light_id": light_id,
            "name": _clean_text(raw.get("name"), kind.title(), 80),
            "level_id": _id(raw.get("level_id")),
            "building_id": _id(raw.get("building_id")),
            "kind": kind,
            "position": _point3(raw.get("position"), (0.0, 2.0, 0.0)),
            "target": _point3(raw.get("target"), (0.0, 0.0, -1.0)),
            "color": color,
            "intensity": _bounded(raw.get("intensity"), 0.0, 100000.0, 1.0),
            "distance": _bounded(raw.get("distance"), 0.0, 1000000.0, 0.0),
            "angle": _bounded(raw.get("angle"), 1.0, 179.0, 45.0),
            "penumbra": _bounded(raw.get("penumbra"), 0.0, 1.0, 0.2),
            "cast_shadow": raw.get("cast_shadow") is not False,
            "visible": raw.get("visible") is not False,
        })
        seen.add(light_id)
    return {
        "shadows": {
            "enabled": shadows.get("enabled") is not False and quality != "off",
            "quality": quality,
            "bias": _bounded(shadows.get("bias"), -0.1, 0.1, -0.0005),
            "normal_bias": _bounded(shadows.get("normal_bias"), 0.0, 10.0, 0.02),
        },
        "lights": lights,
    }
