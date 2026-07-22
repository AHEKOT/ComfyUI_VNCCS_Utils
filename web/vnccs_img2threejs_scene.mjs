/**
 * Safe, DOM-free helpers for the VNCCS img2threejs Scene Spec v1.
 *
 * The viewer deliberately consumes a small declarative format.  This module
 * never evaluates generated source and only copies fields that the renderer
 * understands.  Keeping it free of Three.js and browser globals also makes it
 * suitable for Node based validation tests.
 */

export const SCENE_SPEC_VERSION = 1;
export const MAX_SCENE_COMPONENTS = 256;
export const MAX_SCENE_MATERIALS = 128;
export const SUPPORTED_PRIMITIVES = Object.freeze([
    "box",
    "sphere",
    "ellipsoid",
    "cylinder",
    "cone",
    "capsule",
    "torus",
    "plane",
]);

const PRIMITIVE_SET = new Set(SUPPORTED_PRIMITIVES);
const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);
const SUITABILITY_STATES = new Set(["pass", "conditional", "reject", "unknown"]);
const MATERIAL_SIDES = new Set(["front", "back", "double"]);

const isRecord = (value) => (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
);

export function clamp(value, minimum, maximum, fallback = minimum) {
    const min = Number.isFinite(Number(minimum)) ? Number(minimum) : 0;
    const maxCandidate = Number(maximum);
    const max = Number.isFinite(maxCandidate) && maxCandidate >= min ? maxCandidate : min;
    const fallbackNumber = Number(fallback);
    const number = Number(value);
    const finite = Number.isFinite(number)
        ? number
        : (Number.isFinite(fallbackNumber) ? fallbackNumber : min);
    return Math.min(max, Math.max(min, finite));
}

export function safeString(value, fallback = "", maxLength = 240) {
    if (typeof value !== "string" && typeof value !== "number") return fallback;
    const clean = String(value)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!clean) return fallback;
    return clean.slice(0, Math.max(0, maxLength));
}

export function normalizeId(value, fallback = "item") {
    let id = safeString(value, fallback, 96)
        .replace(/[^\p{L}\p{N}_.:-]+/gu, "-")
        .replace(/^-+|-+$/g, "");
    if (!id) id = fallback;
    if (RESERVED_IDS.has(id.toLowerCase())) id = `item-${id}`;
    return id.slice(0, 96);
}

function byteHex(value) {
    return clamp(Math.round(Number(value)), 0, 255, 0).toString(16).padStart(2, "0");
}

export function normalizeColor(value, fallback = "#808080") {
    if (typeof value === "number" && Number.isFinite(value)) {
        return `#${clamp(Math.trunc(value), 0, 0xffffff, 0x808080).toString(16).padStart(6, "0")}`;
    }
    if (Array.isArray(value) && value.length >= 3) {
        const normalized = value.slice(0, 3).map(Number);
        const unitRange = normalized.every((item) => Number.isFinite(item) && item >= 0 && item <= 1);
        const scale = unitRange ? 255 : 1;
        return `#${byteHex(normalized[0] * scale)}${byteHex(normalized[1] * scale)}${byteHex(normalized[2] * scale)}`;
    }
    if (typeof value === "string") {
        const color = value.trim();
        const short = /^#([0-9a-f]{3})$/i.exec(color);
        if (short) {
            const [r, g, b] = short[1].split("");
            return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
        }
        const full = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color);
        if (full) return `#${full[1].toLowerCase()}`;
        const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color);
        if (rgb) return `#${byteHex(rgb[1])}${byteHex(rgb[2])}${byteHex(rgb[3])}`;
    }
    if (fallback === value) return "#808080";
    return normalizeColor(fallback, "#808080");
}

export function normalizeVector3(value, fallback = [0, 0, 0], limits = [-10000, 10000]) {
    const source = Array.isArray(value)
        ? value
        : (isRecord(value) ? [value.x, value.y, value.z] : []);
    const defaultVector = Array.isArray(fallback) ? fallback : [0, 0, 0];
    const min = Number.isFinite(Number(limits?.[0])) ? Number(limits[0]) : -10000;
    const max = Number.isFinite(Number(limits?.[1])) ? Number(limits[1]) : 10000;
    return [0, 1, 2].map((index) => clamp(source[index], min, max, defaultVector[index] ?? 0));
}

function scalarOrBase(value, fallback) {
    if (isRecord(value)) return value.base ?? value.value ?? value.amount ?? fallback;
    return value ?? fallback;
}

function bool(value, fallback = false) {
    return typeof value === "boolean" ? value : fallback;
}

function normalizeSuitability(value) {
    const source = isRecord(value) ? value : { status: value };
    let status = safeString(source.status ?? source.verdict ?? source.value, "unknown", 24).toLowerCase();
    if (!SUITABILITY_STATES.has(status)) status = "unknown";
    const scoresSource = isRecord(source.scores) ? source.scores : {};
    const scores = {};
    for (const [key, score] of Object.entries(scoresSource).slice(0, 32)) {
        const normalizedKey = normalizeId(key, "score");
        scores[normalizedKey] = clamp(score, 0, 1, 0);
    }
    return {
        status,
        reason: safeString(source.reason ?? source.summary ?? source.notes, "", 1200),
        confidence: clamp(source.confidence, 0, 1, status === "unknown" ? 0 : 0.5),
        scores,
    };
}

export function normalizeMaterialSpec(value, index = 0) {
    const source = isRecord(value) ? value : {};
    const id = normalizeId(source.id, `material-${index + 1}`);
    const opacity = clamp(scalarOrBase(source.opacity, 1), 0, 1, 1);
    const transmission = clamp(scalarOrBase(source.transmission, 0), 0, 1, 0);
    const roughness = clamp(scalarOrBase(source.roughness, 0.62), 0, 1, 0.62);
    const metalness = clamp(scalarOrBase(source.metalness, 0), 0, 1, 0);
    let side = safeString(source.side, "", 12).toLowerCase();
    if (!MATERIAL_SIDES.has(side)) side = bool(source.doubleSided) ? "double" : "front";
    return {
        id,
        name: safeString(source.name, id, 120),
        color: normalizeColor(source.color ?? source.baseColor ?? source.albedo?.dominant, "#8a7a5f"),
        roughness,
        metalness,
        emissive: normalizeColor(source.emissive ?? source.emissiveColor, "#000000"),
        emissiveIntensity: clamp(source.emissiveIntensity, 0, 20, 0),
        opacity,
        transparent: bool(source.transparent, opacity < 1 || transmission > 0),
        alphaTest: clamp(source.alphaTest, 0, 1, 0),
        clearcoat: clamp(scalarOrBase(source.clearcoat, 0), 0, 1, 0),
        clearcoatRoughness: clamp(source.clearcoatRoughness, 0, 1, 0),
        transmission,
        ior: clamp(source.ior, 1, 2.333, 1.5),
        thickness: clamp(source.thickness, 0, 100, 0),
        sheen: clamp(source.sheen, 0, 1, 0),
        sheenRoughness: clamp(source.sheenRoughness, 0, 1, 1),
        sheenColor: normalizeColor(source.sheenColor, "#ffffff"),
        specularIntensity: clamp(source.specularIntensity, 0, 1, 1),
        specularColor: normalizeColor(source.specularColor, "#ffffff"),
        iridescence: clamp(source.iridescence, 0, 1, 0),
        attenuationColor: normalizeColor(source.attenuationColor, "#ffffff"),
        attenuationDistance: clamp(source.attenuationDistance, 0, 10000, 0),
        flatShading: bool(source.flatShading, false),
        depthWrite: bool(source.depthWrite, !(opacity < 1 || transmission > 0)),
        side,
    };
}

function normalizeScale(value, fallback = [1, 1, 1]) {
    return normalizeVector3(value, fallback, [-1000, 1000]).map((item, index) => {
        if (!Number.isFinite(item)) return Math.abs(fallback[index] ?? 1);
        const absolute = Math.abs(item);
        return absolute < 0.0001 ? 0.0001 : absolute;
    });
}

function normalizePrimitive(value) {
    const primitive = safeString(value, "box", 32).toLowerCase();
    if (primitive === "plane-card") return "plane";
    return PRIMITIVE_SET.has(primitive) ? primitive : "box";
}

export function normalizeComponentSpec(value, index = 0) {
    const source = isRecord(value) ? value : {};
    const transform = isRecord(source.transform) ? source.transform : {};
    const dimensionsSource = isRecord(source.dimensions)
        ? [source.dimensions.width, source.dimensions.height, source.dimensions.depth]
        : source.dimensions;
    const scaleFallback = normalizeScale(dimensionsSource, [1, 1, 1]);
    let rotation = normalizeVector3(transform.rotation ?? source.rotation, [0, 0, 0], [-Math.PI * 8, Math.PI * 8]);
    const rotationDegrees = transform.rotationDegrees ?? source.rotationDegrees;
    if (rotationDegrees !== undefined) {
        rotation = normalizeVector3(rotationDegrees, [0, 0, 0], [-1440, 1440]).map((item) => item * Math.PI / 180);
    } else if (safeString(transform.rotationUnit ?? source.rotationUnit, "radians", 12).toLowerCase().startsWith("deg")) {
        rotation = rotation.map((item) => item * Math.PI / 180);
    }
    const id = normalizeId(source.id, `component-${index + 1}`);
    const parentValue = source.parentId ?? source.parent;
    const parentId = parentValue === null || parentValue === undefined || parentValue === ""
        ? null
        : normalizeId(parentValue, "");
    return {
        id,
        name: safeString(source.name, id, 160),
        primitive: normalizePrimitive(source.primitive ?? source.type),
        parentId: parentId || null,
        materialId: normalizeId(source.materialId ?? source.material, "default"),
        position: normalizeVector3(transform.position ?? source.position, [0, 0, 0], [-10000, 10000]),
        rotation,
        scale: normalizeScale(transform.scale ?? source.scale, scaleFallback),
        visible: bool(source.visible, true),
        castShadow: bool(source.castShadow, true),
        receiveShadow: bool(source.receiveShadow, true),
        level: safeString(source.level, "", 24),
        role: safeString(source.role, "", 80),
        importance: clamp(source.importance, 0, 1, 0.5),
        confidence: clamp(source.confidence, 0, 1, 0.5),
        notes: safeString(source.notes ?? source.description, "", 600),
    };
}

/**
 * Resolve invalid parents and cycles without mutating the supplied components.
 * `byId` is a plain object because it is convenient for UI serialization; ids
 * are sanitized before this function is used, and reserved prototype keys are
 * still guarded here for callers that invoke it directly.
 */
export function buildHierarchyMetadata(inputComponents) {
    const components = Array.isArray(inputComponents)
        ? inputComponents.slice(0, MAX_SCENE_COMPONENTS)
        : [];
    const componentById = new Map();
    const sourceOrder = [];
    for (let index = 0; index < components.length; index += 1) {
        const component = components[index];
        if (!isRecord(component)) continue;
        let id = normalizeId(component.id, `component-${index + 1}`);
        if (componentById.has(id)) {
            let suffix = 2;
            const base = id;
            while (componentById.has(`${base}-${suffix}`)) suffix += 1;
            id = `${base}-${suffix}`;
        }
        const entry = { ...component, id };
        componentById.set(id, entry);
        sourceOrder.push(id);
    }

    const issues = [];
    const parentById = new Map();
    for (const id of sourceOrder) {
        const component = componentById.get(id);
        const requested = component.parentId ?? component.parent ?? null;
        const parentId = requested ? normalizeId(requested, "") : null;
        if (!parentId) {
            parentById.set(id, null);
        } else if (parentId === id) {
            parentById.set(id, null);
            issues.push({ code: "self-parent", id, parentId, message: `${id} cannot parent itself` });
        } else if (!componentById.has(parentId)) {
            parentById.set(id, null);
            issues.push({ code: "missing-parent", id, parentId, message: `${id} references missing parent ${parentId}` });
        } else {
            parentById.set(id, parentId);
        }
    }

    // Every node has at most one parent, so walking each parent chain is enough
    // to detect all cycles.  Break one edge and keep the remainder usable.
    for (const startId of sourceOrder) {
        const local = new Set();
        let currentId = startId;
        while (currentId && parentById.has(currentId)) {
            if (local.has(currentId)) {
                const oldParent = parentById.get(currentId);
                parentById.set(currentId, null);
                issues.push({ code: "parent-cycle", id: currentId, parentId: oldParent, message: `Parent cycle was broken at ${currentId}` });
                break;
            }
            local.add(currentId);
            currentId = parentById.get(currentId);
        }
    }

    const childrenById = new Map(sourceOrder.map((id) => [id, []]));
    const roots = [];
    for (const id of sourceOrder) {
        const parentId = parentById.get(id);
        if (parentId && childrenById.has(parentId)) childrenById.get(parentId).push(id);
        else roots.push(id);
    }

    const byId = {};
    const order = [];
    const visit = (id, depth, parentPath, parentNamePath) => {
        const component = componentById.get(id);
        const path = [...parentPath, id];
        const namePath = [...parentNamePath, component.name || id];
        const childrenIds = [...(childrenById.get(id) || [])];
        byId[id] = {
            id,
            name: safeString(component.name, id, 160),
            parentId: parentById.get(id) || null,
            childrenIds,
            depth,
            path,
            namePath,
            index: sourceOrder.indexOf(id),
            primitive: normalizePrimitive(component.primitive),
        };
        order.push(id);
        for (const childId of childrenIds) visit(childId, depth + 1, path, namePath);
    };
    for (const rootId of roots) visit(rootId, 0, [], []);

    return { roots, order, sourceOrder, byId, issues };
}

function normalizeCamera(value) {
    const source = isRecord(value) ? value : {};
    const target = normalizeVector3(source.target ?? source.lookAt, [0, 0, 0], [-10000, 10000]);
    let position = normalizeVector3(source.position, [4.5, 3.2, 6.5], [-10000, 10000]);
    const sameAsTarget = position.every((item, index) => Math.abs(item - target[index]) < 0.0001);
    if (sameAsTarget) position = [target[0] + 4.5, target[1] + 3.2, target[2] + 6.5];
    const near = clamp(source.near, 0.001, 1000, 0.01);
    const far = clamp(source.far, near + 1, 100000, 5000);
    return {
        fov: clamp(source.fov ?? source.fovDegrees, 10, 100, 42),
        near,
        far,
        position,
        target,
        // The bundled OrbitControls instance is Y-up. Constraining this avoids
        // a camera/state mismatch because OrbitControls caches its up-axis
        // quaternion when it is constructed.
        up: [0, 1, 0],
    };
}

function normalizeLight(value, fallback) {
    const source = isRecord(value) ? value : {};
    return {
        enabled: bool(source.enabled, fallback.enabled),
        color: normalizeColor(source.color, fallback.color),
        intensity: clamp(source.intensity, 0, 20, fallback.intensity),
        position: normalizeVector3(source.position, fallback.position, [-1000, 1000]),
    };
}

export function normalizeEnvironmentSpec(value) {
    const source = typeof value === "string" ? { preset: value } : (isRecord(value) ? value : {});
    const groundSource = isRecord(source.ground) ? source.ground : {};
    const gridSource = isRecord(source.grid) ? source.grid : {};
    return {
        preset: safeString(source.preset ?? source.name, "studio", 32).toLowerCase(),
        visible: bool(source.visible, true),
        transparent: bool(source.transparent, false),
        background: normalizeColor(source.background ?? source.backgroundColor, "#171b25"),
        ambientColor: normalizeColor(source.ambientColor, "#dce7ff"),
        ambientIntensity: clamp(source.ambientIntensity, 0, 10, 0.55),
        hemisphereSkyColor: normalizeColor(source.hemisphereSkyColor, "#dce7ff"),
        hemisphereGroundColor: normalizeColor(source.hemisphereGroundColor, "#352c26"),
        hemisphereIntensity: clamp(source.hemisphereIntensity, 0, 10, 0.75),
        key: normalizeLight(source.key ?? source.keyLight, {
            enabled: true, color: "#fff3de", intensity: 3.2, position: [4, 7, 5],
        }),
        fill: normalizeLight(source.fill ?? source.fillLight, {
            enabled: true, color: "#9dbdff", intensity: 1.25, position: [-5, 3, 2],
        }),
        rim: normalizeLight(source.rim ?? source.rimLight, {
            enabled: true, color: "#b9d2ff", intensity: 2.1, position: [1, 5, -6],
        }),
        ground: {
            visible: typeof source.ground === "boolean" ? source.ground : bool(groundSource.visible, true),
            color: normalizeColor(groundSource.color, "#202633"),
            roughness: clamp(groundSource.roughness, 0, 1, 0.9),
            metalness: clamp(groundSource.metalness, 0, 1, 0),
            size: clamp(groundSource.size, 1, 10000, 40),
            height: clamp(groundSource.height ?? groundSource.y, -10000, 10000, -0.001),
            opacity: clamp(groundSource.opacity, 0, 1, 1),
        },
        grid: {
            visible: typeof source.grid === "boolean" ? source.grid : bool(gridSource.visible, true),
            size: clamp(gridSource.size, 1, 10000, 40),
            divisions: Math.round(clamp(gridSource.divisions, 2, 200, 40)),
            centerColor: normalizeColor(gridSource.centerColor, "#59657a"),
            gridColor: normalizeColor(gridSource.color ?? gridSource.gridColor, "#343d4d"),
            opacity: clamp(gridSource.opacity, 0, 1, 0.58),
        },
    };
}

function normalizeSubject(value) {
    const source = isRecord(value) ? value : {};
    return {
        name: safeString(source.name ?? source.label, "", 160),
        category: safeString(source.category ?? source.type ?? source.primaryDomain, "object", 80),
        description: safeString(source.description ?? source.summary, "", 1200),
        sourceImage: safeString(source.sourceImage ?? source.image, "", 2048),
        scale: safeString(source.scale ?? source.units, "relative", 32),
    };
}

function normalizeReview(value) {
    const source = isRecord(value) ? value : {};
    const notes = Array.isArray(source.notes)
        ? source.notes.slice(0, 64).map((item) => safeString(item, "", 600)).filter(Boolean)
        : (safeString(source.notes ?? source.summary, "", 600) ? [safeString(source.notes ?? source.summary, "", 600)] : []);
    return {
        status: safeString(source.status ?? source.action, "unreviewed", 32),
        score: clamp(source.score ?? source.fidelity, 0, 1, 0),
        notes,
    };
}

/** Normalize untrusted data into the only format accepted by the viewer. */
export function normalizeSceneSpec(value) {
    const source = isRecord(value) ? value : {};
    const warnings = [];
    const rawMaterials = Array.isArray(source.materials) ? source.materials : [];
    const materials = [];
    const materialIds = new Set();
    const rawMaterialIdToNormalized = new Map();
    for (let index = 0; index < Math.min(rawMaterials.length, MAX_SCENE_MATERIALS); index += 1) {
        const material = normalizeMaterialSpec(rawMaterials[index], index);
        let id = material.id;
        if (materialIds.has(id)) {
            let suffix = 2;
            while (materialIds.has(`${id}-${suffix}`)) suffix += 1;
            warnings.push(`Duplicate material id ${id} was renamed`);
            id = `${id}-${suffix}`;
        }
        materialIds.add(id);
        materials.push({ ...material, id });
        const rawId = isRecord(rawMaterials[index]) ? safeString(rawMaterials[index].id, "", 96) : "";
        if (rawId && !rawMaterialIdToNormalized.has(rawId)) rawMaterialIdToNormalized.set(rawId, id);
    }
    if (rawMaterials.length > MAX_SCENE_MATERIALS) warnings.push(`Materials were limited to ${MAX_SCENE_MATERIALS}`);
    if (!materials.length) {
        materials.push(normalizeMaterialSpec({ id: "default", name: "Default", color: "#8a7a5f" }, 0));
        materialIds.add("default");
    }

    const rawComponents = Array.isArray(source.components)
        ? source.components
        : (Array.isArray(source.componentTree) ? source.componentTree : []);
    const components = [];
    const componentIds = new Set();
    const rawIdToNormalized = new Map();
    const rawParentRefs = [];
    const rawMaterialRefs = [];
    for (let index = 0; index < Math.min(rawComponents.length, MAX_SCENE_COMPONENTS); index += 1) {
        const raw = rawComponents[index];
        const component = normalizeComponentSpec(raw, index);
        let id = component.id;
        if (componentIds.has(id)) {
            let suffix = 2;
            while (componentIds.has(`${id}-${suffix}`)) suffix += 1;
            warnings.push(`Duplicate component id ${id} was renamed`);
            id = `${id}-${suffix}`;
        }
        componentIds.add(id);
        const rawId = isRecord(raw) ? safeString(raw.id, "", 96) : "";
        if (rawId && !rawIdToNormalized.has(rawId)) rawIdToNormalized.set(rawId, id);
        rawParentRefs.push(isRecord(raw) ? safeString(raw.parentId ?? raw.parent, "", 96) : "");
        rawMaterialRefs.push(isRecord(raw) ? safeString(raw.materialId ?? raw.material, "", 96) : "");
        components.push({ ...component, id });
    }
    if (rawComponents.length > MAX_SCENE_COMPONENTS) warnings.push(`Components were limited to ${MAX_SCENE_COMPONENTS}`);

    for (let index = 0; index < components.length; index += 1) {
        const component = components[index];
        const rawParent = rawParentRefs[index];
        if (rawParent) {
            component.parentId = rawIdToNormalized.get(rawParent) ?? normalizeId(rawParent, "");
        }
        const rawMaterial = rawMaterialRefs[index];
        if (rawMaterial) {
            component.materialId = rawMaterialIdToNormalized.get(rawMaterial) ?? normalizeId(rawMaterial, "default");
        }
        if (!materialIds.has(component.materialId)) {
            warnings.push(`Component ${component.id} referenced missing material ${component.materialId}`);
            component.materialId = materials[0].id;
        }
    }

    const hierarchy = buildHierarchyMetadata(components);
    for (const component of components) component.parentId = hierarchy.byId[component.id]?.parentId ?? null;
    warnings.push(...hierarchy.issues.map((issue) => issue.message));

    const declaredVersion = Number(source.version ?? source.schemaVersion ?? SCENE_SPEC_VERSION);
    if (declaredVersion !== SCENE_SPEC_VERSION) warnings.push(`Scene Spec version ${declaredVersion} was normalized as v${SCENE_SPEC_VERSION}`);

    return {
        version: SCENE_SPEC_VERSION,
        name: safeString(source.name ?? source.targetName, "Untitled 3D asset", 160),
        summary: safeString(source.summary ?? source.description, "", 1600),
        suitability: normalizeSuitability(source.suitability),
        subject: normalizeSubject(source.subject ?? {
            name: source.targetName,
            category: source.objectClass?.primaryDomain,
            sourceImage: source.sourceImage,
        }),
        materials,
        components,
        camera: normalizeCamera(source.camera ?? source.referenceCamera),
        environment: normalizeEnvironmentSpec(source.environment),
        review: normalizeReview(source.review ?? source.selfCorrectLoop?.latestReview),
        hierarchy: buildHierarchyMetadata(components),
        warnings,
    };
}

export const normalizeImg2ThreeJSSceneSpec = normalizeSceneSpec;

/**
 * Camera fitting math expressed entirely as numbers, useful both in the viewer
 * and in unit tests. `bounds` accepts `{min:[x,y,z], max:[x,y,z]}`.
 */
export function computeFitCamera(bounds, options = {}) {
    const min = normalizeVector3(bounds?.min, [-0.5, -0.5, -0.5], [-1e12, 1e12]);
    const max = normalizeVector3(bounds?.max, [0.5, 0.5, 0.5], [-1e12, 1e12]);
    const center = min.map((item, index) => (item + max[index]) / 2);
    const size = min.map((item, index) => Math.max(0.0001, Math.abs(max[index] - item)));
    const fov = clamp(options.fov, 10, 100, 42) * Math.PI / 180;
    const aspect = clamp(options.aspect, 0.01, 100, 1);
    const padding = clamp(options.padding, 1, 5, 1.25);
    const horizontalFov = 2 * Math.atan(Math.tan(fov * 0.5) * aspect);
    const radius = Math.max(0.0001, Math.hypot(...size) * 0.5);
    // A bounding sphere is orientation-independent, unlike world-space X/Y
    // extents. This guarantees that arbitrary camera directions fit too.
    const limitingHalfFov = Math.max(0.001, Math.min(fov * 0.5, horizontalFov * 0.5));
    const distance = Math.max(0.01, radius / Math.sin(limitingHalfFov)) * padding;
    const direction = normalizeVector3(options.direction, [0.65, 0.38, 1], [-1, 1]);
    const magnitude = Math.hypot(...direction) || 1;
    const unitDirection = direction.map((item) => item / magnitude);
    const position = center.map((item, index) => item + unitDirection[index] * distance);
    return {
        center,
        size,
        radius,
        distance,
        position,
        near: Math.max(0.001, distance - radius * 1.5),
        far: Math.max(10, distance + radius * 3),
    };
}

/** Dispose a Three-like object tree once per shared resource. */
export function disposeObject3D(root, { removeFromParent = true } = {}) {
    if (!root || typeof root !== "object") return { geometries: 0, materials: 0, textures: 0 };
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    const visitTextureValue = (value, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 2) return;
        if (value.isTexture && typeof value.dispose === "function") {
            textures.add(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) visitTextureValue(item, depth + 1);
        } else if (isRecord(value) && depth < 2) {
            for (const item of Object.values(value)) visitTextureValue(item, depth + 1);
        }
    };
    const visit = (object) => {
        if (object?.geometry && typeof object.geometry.dispose === "function") geometries.add(object.geometry);
        if (object?.isLight && typeof object.dispose === "function") object.dispose();
        const materialList = Array.isArray(object?.material) ? object.material : [object?.material];
        for (const material of materialList) {
            if (!material || typeof material !== "object") continue;
            materials.add(material);
            for (const value of Object.values(material)) visitTextureValue(value);
        }
    };
    if (typeof root.traverse === "function") root.traverse(visit);
    else {
        const stack = [root];
        const visited = new Set();
        while (stack.length) {
            const object = stack.pop();
            if (!object || visited.has(object)) continue;
            visited.add(object);
            visit(object);
            if (Array.isArray(object.children)) stack.push(...object.children);
        }
    }
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose?.();
    for (const geometry of geometries) geometry.dispose();
    if (removeFromParent && root.parent?.remove) root.parent.remove(root);
    return { geometries: geometries.size, materials: materials.size, textures: textures.size };
}
