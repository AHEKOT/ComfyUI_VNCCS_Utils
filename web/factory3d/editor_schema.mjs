import { terrainSettings } from "./geometry/terrain_heightfield.mjs";
import { PRIMITIVE_KINDS } from "./geometry/parametric_parts.mjs";
import { EDITOR_VERSION, normalizedWorkspace } from "./core/editor_migrations.mjs";
export const FACTORY_EDITOR_SCHEMA_VERSION = EDITOR_VERSION;

export const DEFAULT_BUILDING = Object.freeze({
    name: "Building 1",
    position: Object.freeze([0, 0, 0]),
    rotation_y: 0,
    visible: true,
    locked: false,
});

export const DEFAULT_LEVEL = Object.freeze({
    name: "Level 1",
    elevation: 0,
    height: 2.8,
    slab_thickness: 0.15,
    visible: true,
});

export const DEFAULT_WALL = Object.freeze({
    name: "Wall",
    thickness: 0.12,
    height: 2.8,
    elevation_offset: 0,
    material_left: "",
    material_right: "",
    material_caps: "",
    visible: true,
    locked: false,
});

export const DEFAULT_ROOM = Object.freeze({
    name: "Room",
    floor: Object.freeze({ enabled: true, thickness: 0.02, material_id: "" }),
    ceiling: Object.freeze({ enabled: true, height: 2.8, thickness: 0.02, material_id: "" }),
    visible: true,
    locked: false,
});

export const DEFAULT_EDITOR_VIEW = Object.freeze({
    view_mode: "3d",
    plan_tool: "select",
    room_shape: "rectangle",
    opening_kind: "window",
    active_level_id: "",
    active_building_id: "",
    workspace: Object.freeze({
        left: "generate",
        right: "objects",
    }),
    plan_grid: Object.freeze({
        visible: true,
        step: 0.1,
        major_every: 10,
    }),
    snap: Object.freeze({
        enabled: true,
        grid: 0.1,
        angle: 15,
        endpoints: true,
        midpoints: true,
        orthogonal: true,
    }),
    plan_camera: Object.freeze({
        target: Object.freeze([0, 0]),
        zoom: 24,
    }),
});

export function factoryId() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        for (let index = 0; index < bytes.length; index += 1) {
            bytes[index] = Math.floor(Math.random() * 256);
        }
    }
    return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

export function finiteNumber(value, fallback = 0, minimum = -1e6, maximum = 1e6) {
    const number = Number(value);
    return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
}

export function finitePoint2(value, fallback = [0, 0]) {
    return [
        finiteNumber(value?.[0], fallback[0]),
        finiteNumber(value?.[1], fallback[1]),
    ];
}

export function finitePoint3(value, fallback = [0, 0, 0]) {
    return [
        finiteNumber(value?.[0], fallback[0]),
        finiteNumber(value?.[1], fallback[1]),
        finiteNumber(value?.[2], fallback[2]),
    ];
}

function normalizedMaterial(value = {}, index = 0) {
    const source = value && typeof value === "object" ? value : {};
    const output = {
        ...source,
        material_id: String(source.material_id || factoryId()),
        name: String(source.name || `Material ${index + 1}`).slice(0, 80),
        kind: source.kind === "glass" ? "glass" : "standard",
        color: /^#[0-9a-f]{6}$/i.test(String(source.color || ""))
            ? String(source.color).toLowerCase()
            : "#d7d2ca",
        roughness: finiteNumber(source.roughness, 0.78, 0, 1),
        metalness: finiteNumber(source.metalness, 0, 0, 1),
        opacity: finiteNumber(source.opacity, 1, 0, 1),
        transmission: finiteNumber(source.transmission, source.kind === "glass" ? 1 : 0, 0, 1),
        ior: finiteNumber(source.ior, 1.5, 1, 2.5),
        uv_scale: [
            finiteNumber(source.uv_scale?.[0], 1, 0.001, 1000),
            finiteNumber(source.uv_scale?.[1], 1, 0.001, 1000),
        ],
        uv_offset: [
            finiteNumber(source.uv_offset?.[0], 0, -10000, 10000),
            finiteNumber(source.uv_offset?.[1], 0, -10000, 10000),
        ],
        uv_rotation: finiteNumber(source.uv_rotation, 0, -36000, 36000),
        normal_strength: finiteNumber(source.normal_strength, 1, 0, 4),
    };
    for (const key of ["texture_id", "normal_texture_id", "roughness_texture_id"]) {
        const textureId = String(source[key] || "");
        if (textureId) output[key] = textureId;
        else delete output[key];
    }
    return output;
}

export function isSimpleRoomPolygon(points = []) {
    if (!Array.isArray(points) || points.length < 3) return false;
    const polygon = points.map(point => finitePoint2(point));
    const distance = (left, right) => Math.hypot(left[0] - right[0], left[1] - right[1]);
    if (polygon.some((point, index) => distance(point, polygon[(index + 1) % polygon.length]) < 0.001)) {
        return false;
    }
    const area = polygon.reduce((total, point, index) => {
        const next = polygon[(index + 1) % polygon.length];
        return total + point[0] * next[1] - next[0] * point[1];
    }, 0) * 0.5;
    if (Math.abs(area) < 1e-6) return false;
    const orientation = (a, b, c) => (
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    );
    const onSegment = (a, b, point) => (
        point[0] >= Math.min(a[0], b[0]) - 1e-9
        && point[0] <= Math.max(a[0], b[0]) + 1e-9
        && point[1] >= Math.min(a[1], b[1]) - 1e-9
        && point[1] <= Math.max(a[1], b[1]) + 1e-9
    );
    const intersects = (a, b, c, d) => {
        const values = [
            orientation(a, b, c),
            orientation(a, b, d),
            orientation(c, d, a),
            orientation(c, d, b),
        ];
        if (values[0] * values[1] < 0 && values[2] * values[3] < 0) return true;
        return (Math.abs(values[0]) <= 1e-9 && onSegment(a, b, c))
            || (Math.abs(values[1]) <= 1e-9 && onSegment(a, b, d))
            || (Math.abs(values[2]) <= 1e-9 && onSegment(c, d, a))
            || (Math.abs(values[3]) <= 1e-9 && onSegment(c, d, b));
    };
    for (let left = 0; left < polygon.length; left += 1) {
        const a = polygon[left];
        const b = polygon[(left + 1) % polygon.length];
        for (let right = left + 1; right < polygon.length; right += 1) {
            if (right === left || right === (left + 1) % polygon.length || (right + 1) % polygon.length === left) {
                continue;
            }
            if (intersects(a, b, polygon[right], polygon[(right + 1) % polygon.length])) return false;
        }
    }
    return true;
}

export function normalizedEditorView(value = {}, activeLevelId = "") {
    const source = value && typeof value === "object" ? value : {};
    const snap = source.snap && typeof source.snap === "object" ? source.snap : {};
    const planGrid = source.plan_grid && typeof source.plan_grid === "object"
        ? source.plan_grid
        : {};
    // `snap.grid` was the original Plan Mode spacing field. Keep emitting it
    // as a compatibility alias while making the visible grid the canonical
    // owner of the shared step.
    const gridStep = finiteNumber(planGrid.step ?? snap.grid, 0.1, 0.001, 1000);
    const planCamera = source.plan_camera && typeof source.plan_camera === "object"
        ? source.plan_camera
        : {};
    const workspace = source.workspace && typeof source.workspace === "object"
        ? source.workspace
        : {};
    const cutawaySource = source.interior_cutaway && typeof source.interior_cutaway === "object"
        ? source.interior_cutaway
        : {};
    const legacyCutaway = typeof source.interior_cutaway === "boolean"
        ? source.interior_cutaway
        : null;
    return {
        view_mode: source.view_mode === "plan" ? "plan" : "3d",
        room_shape: source.room_shape === "polygon" ? "polygon" : "rectangle",
        plan_tool: ["select", "wall", "room", "opening", "camera"].includes(source.plan_tool)
            ? source.plan_tool
            : "select",
        opening_kind: ["window", "door", "empty"].includes(source.opening_kind)
            ? source.opening_kind
            : "window",
        active_level_id: String(source.active_level_id || activeLevelId || ""),
        active_building_id: String(source.active_building_id || ""),
        workspace: normalizedWorkspace(workspace),
        interior_cutaway: {
            // Plan has historically hidden ceilings. Preserve that behavior,
            // while keeping the 3D viewport opt-in for existing workflows.
            plan: legacyCutaway ?? (cutawaySource.plan !== false),
            three_d: legacyCutaway ?? (cutawaySource.three_d === true),
        },
        plan_grid: {
            visible: planGrid.visible !== false,
            step: gridStep,
            major_every: Math.round(finiteNumber(planGrid.major_every, 10, 2, 100)),
        },
        snap: {
            enabled: snap.enabled !== false,
            grid: gridStep,
            angle: finiteNumber(snap.angle, 15, 0.01, 180),
            endpoints: snap.endpoints !== false,
            midpoints: snap.midpoints !== false,
            orthogonal: snap.orthogonal !== false,
        },
        plan_camera: {
            target: finitePoint2(planCamera.target),
            zoom: finiteNumber(planCamera.zoom, 24, 0.01, 100000),
        },
    };
}

export function normalizedCollisionProxy(value = {}) {
    const source = value && typeof value === "object" ? value : {};
    const mode = ["auto_box", "box", "off"].includes(source.mode)
        ? source.mode
        : "auto_box";
    return {
        mode,
        center: finitePoint3(source.center),
        size: finitePoint3(source.size, [1, 1, 1]).map(item => Math.max(0.001, item)),
        supports_objects: source.supports_objects !== false,
    };
}

export function normalizedObjectEditorProperties(value = {}) {
    const lightTransport = ["opaque", "cutout", "transmissive"].includes(value.light_transport)
        ? value.light_transport
        : "opaque";
    const emissionSource = value.emission && typeof value.emission === "object"
        ? value.emission
        : {};
    const result = {
        building_id: String(value.building_id || ""),
        collision_proxy: normalizedCollisionProxy(value.collision_proxy),
        light_transport: lightTransport,
        transmission: finiteNumber(
            value.transmission,
            lightTransport === "transmissive" ? 1 : 0,
            0,
            1,
        ),
        locked: value.locked === true,
        emission: {
            enabled: emissionSource.enabled === true,
            intensity: finiteNumber(emissionSource.intensity, 4, 0, 1000),
            quality: ["low", "medium", "high"].includes(emissionSource.quality)
                ? emissionSource.quality
                : "medium",
            two_sided: emissionSource.two_sided !== false,
        },
    };
    if (value.primitive && typeof value.primitive === "object") {
        const source = value.primitive;
        const kind = PRIMITIVE_KINDS.includes(source.kind)
            ? source.kind
            : "plane";
        const segments = Array.isArray(source.segments) ? source.segments : [1, 1];
        result.primitive = {
            kind,
            width: finiteNumber(source.width, 2, 0.001, 100000),
            height: finiteNumber(source.height, 2, 0.001, 100000),
            depth: finiteNumber(source.depth, 2, 0.001, 100000),
            extrusion: finiteNumber(source.extrusion, 0, 0, 100000),
            segments: [0, 1].map(index => Math.trunc(finiteNumber(segments[index], 1, 1, 128))),
            height_amplitude: terrainSettings(source).amplitude,
            noise_frequency: terrainSettings(source).frequency,
            noise_seed: terrainSettings(source).seed,
            noise_octaves: terrainSettings(source).octaves,
            steps: Math.trunc(finiteNumber(source.steps, 12, 1, 256)),
            radial_segments: Math.trunc(finiteNumber(source.radial_segments, 32, 8, 128)),
            texture_id: String(source.texture_id || ""),
            color: /^#[0-9a-f]{6}$/i.test(String(source.color || ""))
                ? String(source.color).toLowerCase()
                : "#ffffff",
            opacity: finiteNumber(source.opacity, 1, 0, 1),
            double_sided: source.double_sided !== false,
            uv_scale: finitePoint2(source.uv_scale, [1, 1]).map(item => Math.max(0.001, Math.min(1000, item))),
            uv_offset: finitePoint2(source.uv_offset).map(item => Math.max(-1000, Math.min(1000, item))),
            uv_rotation: finiteNumber(source.uv_rotation, 0, -36000, 36000),
        };
    }
    return result;
}

export function normalizedArchitecture(value = {}, levels = []) {
    const source = value && typeof value === "object" ? value : {};
    const defaultLevelId = String(levels[0]?.level_id || "");
    const levelIds = new Set(levels.map(level => String(level.level_id || "")));
    const hasBuildingSchema = Array.isArray(source.buildings);
    const rawBuildings = Array.isArray(source.buildings) ? source.buildings : [];
    const rawWalls = Array.isArray(source.walls) ? source.walls : [];
    const rawRooms = Array.isArray(source.rooms) ? source.rooms : [];
    const buildings = rawBuildings.map((item, index) => ({
        ...DEFAULT_BUILDING,
        ...item,
        building_id: String(item?.building_id || factoryId()),
        name: String(item?.name || `Building ${index + 1}`),
        position: finitePoint3(item?.position),
        rotation_y: finiteNumber(item?.rotation_y, 0, -36000, 36000),
        visible: item?.visible !== false,
        locked: item?.locked === true,
    }));
    // Architecture saved before Buildings existed is migrated once so its
    // walls and rooms retain an owner. An explicit empty `buildings` array is
    // authoritative: new and intentionally cleared scenes remain building-free.
    if (!buildings.length && !hasBuildingSchema && (rawWalls.length || rawRooms.length)) {
        buildings.push({ ...DEFAULT_BUILDING, position: [0, 0, 0], building_id: factoryId() });
    }
    const buildingIds = new Set(buildings.map(item => item.building_id));
    const defaultBuildingId = buildings[0]?.building_id || "";
    const architectureBuildingId = item => {
        const sourceItem = item && typeof item === "object" ? item : {};
        const requested = String(sourceItem.building_id || "");
        if (buildingIds.has(requested)) return requested;
        return Object.prototype.hasOwnProperty.call(sourceItem, "building_id")
            ? ""
            : defaultBuildingId;
    };
    const walls = rawWalls.map(item => ({
        ...DEFAULT_WALL,
        ...item,
        wall_id: String(item?.wall_id || factoryId()),
        level_id: levelIds.has(String(item?.level_id || ""))
            ? String(item.level_id)
            : defaultLevelId,
        building_id: architectureBuildingId(item),
        start: finitePoint2(item?.start),
        end: finitePoint2(item?.end, [1, 0]),
        thickness: finiteNumber(item?.thickness, DEFAULT_WALL.thickness, 0.01, 10),
        height: finiteNumber(item?.height, DEFAULT_WALL.height, 0.05, 1000),
        elevation_offset: finiteNumber(item?.elevation_offset, 0, -1000, 1000),
        visible: item?.visible !== false,
        locked: item?.locked === true,
    })).filter(item => (
        (!item.building_id || buildingIds.has(item.building_id))
        && Math.hypot(item.end[0] - item.start[0], item.end[1] - item.start[1]) >= 0.001
    ));
    const wallIds = new Set(walls.map(item => item.wall_id));
    const rooms = rawRooms.map(item => ({
        ...DEFAULT_ROOM,
        ...item,
        room_id: String(item?.room_id || factoryId()),
        level_id: levelIds.has(String(item?.level_id || ""))
            ? String(item.level_id)
            : defaultLevelId,
        building_id: architectureBuildingId(item),
        polygon: (Array.isArray(item?.polygon) ? item.polygon : []).map(point => finitePoint2(point)),
        wall_ids: Array.isArray(item?.wall_ids)
            ? item.wall_ids.map(String).filter(wallId => wallIds.has(wallId))
            : [],
        floor: { ...DEFAULT_ROOM.floor, ...(item?.floor || {}) },
        ceiling: { ...DEFAULT_ROOM.ceiling, ...(item?.ceiling || {}) },
        visible: item?.visible !== false,
        locked: item?.locked === true,
    })).filter(item => (
        (!item.building_id || buildingIds.has(item.building_id))
        && isSimpleRoomPolygon(item.polygon)
    ));
    const wallsById = new Map(walls.map(wall => [wall.wall_id, wall]));
    for (const room of rooms) {
        room.wall_ids = [...new Set(room.wall_ids)];
        const perimeterValid = room.wall_ids.length === room.polygon.length
            && room.wall_ids.every((wallId, index) => {
                const wall = wallsById.get(wallId);
                const start = room.polygon[index];
                const end = room.polygon[(index + 1) % room.polygon.length];
                return wall
                    && wall.level_id === room.level_id
                    && wall.building_id === room.building_id
                    && Math.hypot(wall.start[0] - start[0], wall.start[1] - start[1]) <= 1e-4
                    && Math.hypot(wall.end[0] - end[0], wall.end[1] - end[1]) <= 1e-4;
            });
        if (!perimeterValid) room.wall_ids = [];
    }
    const openingCandidates = (Array.isArray(source.openings) ? source.openings : [])
        .filter(item => wallIds.has(String(item?.wall_id || "")))
        .map(item => ({
            opening_id: String(item?.opening_id || factoryId()),
            wall_id: String(item.wall_id),
            name: String(item?.name || "Opening"),
            kind: ["empty", "door", "window"].includes(item?.kind) ? item.kind : "empty",
            offset: finiteNumber(item?.offset, 0.5, 0, 1),
            width: finiteNumber(item?.width, 0.9, 0.05, 100),
            height: finiteNumber(item?.height, 1.2, 0.05, 100),
            sill_height: finiteNumber(item?.sill_height, 0.9, 0, 100),
            material_id: String(item?.material_id || ""),
            visible: item?.visible !== false,
            locked: item?.locked === true,
        }));
    const occupiedByWall = new Map();
    const openings = [];
    for (const opening of openingCandidates) {
        const wall = wallsById.get(opening.wall_id);
        const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
        if (length < 0.05) continue;
        const width = Math.min(length, opening.width);
        const half = width / 2;
        const occupied = occupiedByWall.get(wall.wall_id) || [];
        const free = [];
        let cursor = 0;
        for (const [start, end] of occupied.sort((left, right) => left[0] - right[0])) {
            if (start > cursor) free.push([cursor, start]);
            cursor = Math.max(cursor, end);
        }
        if (cursor < length) free.push([cursor, length]);
        const requested = opening.offset * length;
        const candidates = free.map(([start, end]) => {
            const minimum = start + half;
            const maximum = end - half;
            if (minimum > maximum + 1e-9) return null;
            const center = Math.max(minimum, Math.min(maximum, requested));
            return { center, distance: Math.abs(center - requested) };
        }).filter(Boolean).sort((left, right) => left.distance - right.distance);
        if (!candidates.length) continue;
        const center = candidates[0].center;
        occupied.push([center - half, center + half]);
        occupiedByWall.set(wall.wall_id, occupied);
        const height = Math.min(opening.height, wall.height);
        openings.push({
            ...opening,
            offset: center / length,
            width,
            height,
            sill_height: Math.min(opening.sill_height, Math.max(0, wall.height - height)),
        });
    }
    return {
        units: "m",
        materials: (Array.isArray(source.materials) ? source.materials : [])
            .map((material, index) => normalizedMaterial(material, index)),
        buildings,
        walls,
        rooms,
        openings,
    };
}

export function normalizedLevels(value = [], fallbackId = "") {
    const levels = (Array.isArray(value) ? value : []).map((item, index) => ({
        ...DEFAULT_LEVEL,
        ...item,
        level_id: String(item?.level_id || factoryId()),
        name: String(item?.name || `Level ${index + 1}`),
        elevation: finiteNumber(item?.elevation, 0, -10000, 10000),
        height: finiteNumber(item?.height, DEFAULT_LEVEL.height, 0.1, 1000),
        slab_thickness: finiteNumber(
            item?.slab_thickness,
            DEFAULT_LEVEL.slab_thickness,
            0,
            100,
        ),
        visible: item?.visible !== false,
    }));
    if (!levels.length) {
        levels.push({ ...DEFAULT_LEVEL, level_id: fallbackId || factoryId() });
    }
    return levels.sort((left, right) => left.elevation - right.elevation);
}
