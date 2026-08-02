/**
 * Pure state helpers for Pose Studio multi-character scenes.
 *
 * Rendering stays in PoseViewerCore; this module deliberately contains no DOM
 * or Three.js dependencies so workflow migration can be covered by Node tests.
 */

export const MAX_POSE_STUDIO_CHARACTERS = 4;

export const DEFAULT_CHARACTER_COLORS = Object.freeze([
    // White preserves the original textured mannequin for legacy workflows.
    "#ffffff",
    "#8ec5ff",
    "#f0a6ca",
    "#a7e3a1",
]);

const cloneJSON = (value, fallback = null) => {
    if (value === undefined) return fallback;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_error) {
        return fallback;
    }
};

const finite = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function normalizeCharacterColor(value, fallback = DEFAULT_CHARACTER_COLORS[0]) {
    const text = String(value ?? "").trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) {
        return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase();
    }
    return normalizeCharacterColor(fallback, "#ffffff");
}

export function normalizeCharacterTransform(source = {}) {
    return {
        x: clamp(finite(source.x ?? source.offset_x, 0), -50, 50),
        y: clamp(finite(source.y ?? source.offset_y, 0), -50, 50),
        z: clamp(finite(source.z ?? source.depth, 0), -40, 40),
        zoom: clamp(finite(source.zoom ?? source.scale, 1), 0.1, 7),
    };
}

export function normalizeSAMProjectionFrame(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;
    const fov = Number(source.fov);
    const cameraPosition = source.cameraPosition;
    const x = Number(cameraPosition?.x);
    const y = Number(cameraPosition?.y);
    const z = Number(cameraPosition?.z);
    if (
        !Number.isFinite(fov)
        || fov <= 0
        || fov >= 179
        || ![x, y, z].every(Number.isFinite)
    ) return null;
    return { fov, cameraPosition: { x, y, z } };
}

export function cameraFramingToCharacterTransform(cameraParams, pivot) {
    const values = [
        cameraParams?.zoom,
        cameraParams?.offset_x,
        cameraParams?.offset_y,
        pivot?.x,
        pivot?.y,
        pivot?.z,
    ].map(Number);
    if (values.some(value => !Number.isFinite(value))) {
        throw new TypeError("Pose framing requires finite zoom, offsets, and model pivot.");
    }
    const [zoom, offsetX, offsetY, pivotX, pivotY, pivotZ] = values;
    const transform = {
        x: (1 - zoom) * pivotX + zoom * offsetX,
        y: (1 - zoom) * pivotY + zoom * offsetY,
        z: (1 - zoom) * pivotZ,
        zoom,
    };
    if (
        transform.x < -50 || transform.x > 50
        || transform.y < -50 || transform.y > 50
        || transform.z < -40 || transform.z > 40
        || transform.zoom < 0.1 || transform.zoom > 7
    ) {
        throw new RangeError("Pose framing is outside the supported character transform range.");
    }
    return transform;
}

export function nextCharacterId(characters = []) {
    const occupied = new Set(characters.map(character => String(character?.id || "")));
    for (let index = 1; index < 10000; index += 1) {
        const id = `character-${index}`;
        if (!occupied.has(id)) return id;
    }
    return `character-${Date.now()}`;
}

export function nextCharacterSlot(characters = [], preferredSlot = null) {
    const occupied = new Set(characters.map((character, index) => (
        clamp(Math.floor(finite(character?.slot, index)), 0, MAX_POSE_STUDIO_CHARACTERS - 1)
    )));
    const preferred = Math.floor(finite(preferredSlot, -1));
    if (preferred >= 0 && preferred < MAX_POSE_STUDIO_CHARACTERS && !occupied.has(preferred)) {
        return preferred;
    }
    for (let slot = 0; slot < MAX_POSE_STUDIO_CHARACTERS; slot += 1) {
        if (!occupied.has(slot)) return slot;
    }
    return -1;
}

export function nextCharacterColor(characters = [], slot = nextCharacterSlot(characters)) {
    const occupied = new Set(characters.map(character => normalizeCharacterColor(character?.color)));
    const preferred = DEFAULT_CHARACTER_COLORS[
        clamp(Math.floor(finite(slot, 0)), 0, DEFAULT_CHARACTER_COLORS.length - 1)
    ];
    if (!occupied.has(preferred)) return preferred;
    return DEFAULT_CHARACTER_COLORS.find(color => !occupied.has(color)) || preferred;
}

export function createPoseStudioCharacter({
    id,
    index = 0,
    slot = index,
    name,
    color,
    transform,
    mesh,
    poses,
    animation,
    poseCount = 1,
} = {}) {
    const normalizedSlot = clamp(
        Math.floor(finite(slot, index)),
        0,
        MAX_POSE_STUDIO_CHARACTERS - 1,
    );
    const normalizedPoseCount = Math.max(1, Math.floor(finite(poseCount, 1)));
    const sourcePoses = Array.isArray(poses) ? cloneJSON(poses, []) : [];
    while (sourcePoses.length < normalizedPoseCount) sourcePoses.push({});
    if (!sourcePoses.length) sourcePoses.push({});

    return {
        id: String(id || `character-${normalizedSlot + 1}`),
        slot: normalizedSlot,
        name: String(name || (normalizedSlot === 0 ? "Main Character" : `Character ${normalizedSlot + 1}`)).slice(0, 64),
        color: normalizeCharacterColor(color, DEFAULT_CHARACTER_COLORS[normalizedSlot % DEFAULT_CHARACTER_COLORS.length]),
        transform: normalizeCharacterTransform(transform),
        mesh: cloneJSON(mesh, {}),
        poses: sourcePoses,
        animation: cloneJSON(animation, null),
    };
}

/**
 * Newer Pose Studio versions wrap saved poses in the v3 character-scene
 * schema. `characters[]` and each character's runtime `poses[]` do not make the
 * library item a pose set; only the explicit `type: "pose_set"` format does.
 * Resolve the pose selected when the item was saved without mutating the
 * cached library response.
 */
function activeCharacterFromSceneAsset(data = {}) {
    if (!data || typeof data !== "object" || !Array.isArray(data.characters)) return null;
    if (data.type === "pose_set" || !data.characters.length) return null;
    const requestedCharacterId = String(data.active_character_id || data.activeCharacterId || "");
    return data.characters.find(character => (
        String(character?.id || "") === requestedCharacterId
    )) || data.characters[0];
}

export function extractActiveCharacterTransformFromSceneAsset(data = {}) {
    const sourceCharacter = activeCharacterFromSceneAsset(data);
    if (
        !sourceCharacter?.transform
        || typeof sourceCharacter.transform !== "object"
        || Array.isArray(sourceCharacter.transform)
    ) return null;
    return normalizeCharacterTransform(sourceCharacter.transform);
}

export function extractActivePoseFromSceneAsset(data = {}) {
    const sourceCharacter = activeCharacterFromSceneAsset(data);
    if (!sourceCharacter) return null;
    const sourcePoses = sourceCharacter?.poses;
    if (!Array.isArray(sourcePoses) || !sourcePoses.length) return null;
    const requestedPoseIndex = Math.max(0, Math.floor(finite(data.activeTab, 0)));
    const sourcePose = sourcePoses[requestedPoseIndex] || sourcePoses[0];
    if (!sourcePose || typeof sourcePose !== "object" || Array.isArray(sourcePose)) return null;

    const pose = cloneJSON(sourcePose, null);
    if (!pose) return null;
    // Early v3 exports also mirrored the active pose at the top level. Keep
    // those values as compatibility fallbacks for partially wrapped assets.
    for (const key of [
        "bones",
        "hipBonePosition",
        "ikEffectorPositions",
        "poleTargetPositions",
        "modelRotation",
        "cameraParams",
        "prompt",
    ]) {
        if (pose[key] === undefined && data[key] !== undefined) {
            pose[key] = cloneJSON(data[key], data[key]);
        }
    }
    return pose;
}

/**
 * Normalize v3 character data, or migrate the legacy singleton state.
 */
export function normalizePoseStudioCharacters(data = {}, defaults = {}) {
    const legacyPoses = Array.isArray(data.poses) && data.poses.length
        ? data.poses
        : Array.isArray(data.image_poses) && data.image_poses.length
            ? data.image_poses
            : [{}];
    const rawCharacters = Array.isArray(data.characters) && data.characters.length
        ? data.characters.slice(0, MAX_POSE_STUDIO_CHARACTERS)
        : [{
            id: "character-1",
            name: "Main Character",
            color: defaults.color,
            transform: {
                x: data.export?.cam_offset_x ?? 0,
                y: data.export?.cam_offset_y ?? 0,
                z: 0,
                zoom: data.export?.cam_zoom ?? 1,
            },
            mesh: data.mesh ?? defaults.mesh ?? {},
            poses: legacyPoses,
            animation: data.animation ?? null,
        }];

    const characters = [];
    for (let index = 0; index < rawCharacters.length; index += 1) {
        const source = rawCharacters[index] || {};
        const slot = nextCharacterSlot(characters, source.slot ?? source.slot_index ?? index);
        if (slot < 0) break;
        let id = String(source.id || `character-${index + 1}`);
        if (characters.some(character => character.id === id)) {
            id = nextCharacterId(characters);
        }
        characters.push(createPoseStudioCharacter({
            ...source,
            id,
            index: slot,
            slot,
            mesh: source.mesh ?? defaults.mesh ?? {},
            poses: source.poses ?? legacyPoses,
            poseCount: legacyPoses.length,
        }));
    }

    if (!characters.length) {
        characters.push(createPoseStudioCharacter({ index: 0, mesh: defaults.mesh, poses: legacyPoses }));
    }
    characters.sort((left, right) => left.slot - right.slot);

    const requestedActiveId = String(data.active_character_id || data.activeCharacterId || "");
    const activeCharacterId = characters.some(character => character.id === requestedActiveId)
        ? requestedActiveId
        : characters[clamp(Math.floor(finite(data.active_character_index, 0)), 0, characters.length - 1)].id;

    return { characters, activeCharacterId };
}

export function serializePoseStudioCharacter(character, animation = character?.animation) {
    return {
        id: String(character?.id || ""),
        slot: clamp(
            Math.floor(finite(character?.slot, 0)),
            0,
            MAX_POSE_STUDIO_CHARACTERS - 1,
        ),
        name: String(character?.name || "Character").slice(0, 64),
        color: normalizeCharacterColor(character?.color),
        transform: normalizeCharacterTransform(character?.transform),
        mesh: cloneJSON(character?.mesh, {}),
        poses: cloneJSON(character?.poses, [{}]),
        animation: cloneJSON(animation, null),
    };
}
