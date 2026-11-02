/**
 * Pure state helpers for the Pose Studio whole-character transform gizmo.
 *
 * The gizmo edits the data Pose Studio already stores: the per-character
 * `transform.x / y / z` placement and the per-pose `modelRotation` Euler
 * angles in degrees. Nothing here keeps a second copy of either value.
 *
 * Three.js is passed in by the caller so Node tests can use the vendored
 * module without a DOM.
 */

export const CHARACTER_TRANSFORM_MODES = Object.freeze(["pose", "move", "rotate"]);
export const CHARACTER_TRANSFORM_SPACES = Object.freeze(["world", "local"]);

// modelRotation is applied as `mesh.rotation.set(x, y, z)` with the default
// Three.js Euler order, i.e. the rotation matrix is Rx * Ry * Rz.
export const MODEL_ROTATION_ORDER = "XYZ";

// Mirrors normalizeCharacterTransform() in characters.mjs.
export const CHARACTER_POSITION_LIMITS = Object.freeze({
    x: Object.freeze([-50, 50]),
    y: Object.freeze([-50, 50]),
    z: Object.freeze([-40, 40]),
});

const AXES = ["x", "y", "z"];
const DEG = Math.PI / 180;

const finite = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

export function normalizeCharacterTransformMode(mode) {
    return CHARACTER_TRANSFORM_MODES.includes(mode) ? mode : "pose";
}

export function normalizeCharacterTransformSpace(space) {
    return CHARACTER_TRANSFORM_SPACES.includes(space) ? space : "world";
}

export function clampCharacterPosition(source = {}) {
    const result = {};
    for (const axis of AXES) {
        const [minimum, maximum] = CHARACTER_POSITION_LIMITS[axis];
        result[axis] = Math.max(minimum, Math.min(maximum, finite(source[axis])));
    }
    return result;
}

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDegrees(value) {
    const wrapped = ((finite(value) + 180) % 360 + 360) % 360 - 180;
    return wrapped === -180 ? 180 : wrapped;
}

export function normalizeModelRotation(source) {
    if (Array.isArray(source)) {
        return { x: finite(source[0]), y: finite(source[1]), z: finite(source[2]) };
    }
    return { x: finite(source?.x), y: finite(source?.y), z: finite(source?.z) };
}

export function modelRotationQuaternion(THREE, rotation) {
    const value = normalizeModelRotation(rotation);
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(
        value.x * DEG,
        value.y * DEG,
        value.z * DEG,
        MODEL_ROTATION_ORDER,
    ));
}

const nearestEquivalent = (angle, reference) => angle + 360 * Math.round((reference - angle) / 360);

/**
 * Convert a mesh quaternion to modelRotation degrees.
 *
 * Every orientation has two XYZ Euler solutions: (x, y, z) and
 * (x + 180, 180 - y, z + 180). Pick the one closest to `reference`, so a
 * continuous gizmo drag (for example a full turn about Y) produces continuous
 * field values instead of flipping X and Z by 180 degrees halfway through.
 */
export function quaternionToModelRotation(THREE, quaternion, reference = { x: 0, y: 0, z: 0 }) {
    const previous = normalizeModelRotation(reference);
    const euler = new THREE.Euler().setFromQuaternion(quaternion, MODEL_ROTATION_ORDER);
    const first = { x: euler.x / DEG, y: euler.y / DEG, z: euler.z / DEG };
    const second = { x: first.x + 180, y: 180 - first.y, z: first.z + 180 };
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of [first, second]) {
        const unwrapped = {};
        let distance = 0;
        for (const axis of AXES) {
            unwrapped[axis] = nearestEquivalent(candidate[axis], previous[axis]);
            distance += Math.abs(unwrapped[axis] - previous[axis]);
        }
        if (distance < bestDistance - 1e-9) {
            best = unwrapped;
            bestDistance = distance;
        }
    }
    const clean = value => {
        const wrapped = wrapDegrees(value);
        return Math.abs(wrapped) < 1e-9 ? 0 : wrapped;
    };
    return { x: clean(best.x), y: clean(best.y), z: clean(best.z) };
}

/** Whole-character translation: the character moves by the world delta. */
export function translateCharacterPosition(start, delta) {
    const origin = clampCharacterPosition(start);
    return clampCharacterPosition({
        x: origin.x + finite(delta?.x),
        y: origin.y + finite(delta?.y),
        z: origin.z + finite(delta?.z),
    });
}

/**
 * Rotate the whole character by a world-space delta about a pivot (the
 * pelvis). The mesh origin is not the pelvis, so the stored position must
 * move with the rotation for the pelvis to stay where it is:
 *
 *   rotation' = delta * rotation
 *   position' = pivot + delta * (position - pivot)
 *
 * Bone local poses are untouched; only the mesh placement changes.
 */
export function rotateCharacterAboutPivot(THREE, {
    position,
    rotation,
    pivot,
    delta,
}) {
    const start = clampCharacterPosition(position);
    const center = new THREE.Vector3(finite(pivot?.x), finite(pivot?.y), finite(pivot?.z));
    const offset = new THREE.Vector3(start.x, start.y, start.z).sub(center).applyQuaternion(delta);
    const nextQuaternion = delta.clone().multiply(modelRotationQuaternion(THREE, rotation));
    return {
        position: clampCharacterPosition({
            x: center.x + offset.x,
            y: center.y + offset.y,
            z: center.z + offset.z,
        }),
        rotation: quaternionToModelRotation(THREE, nextQuaternion, rotation),
    };
}

/**
 * Set modelRotation to `nextRotation` (numeric fields, Reset Rotation) while
 * keeping the pivot fixed, exactly like a gizmo rotation would.
 */
export function setCharacterRotationAboutPivot(THREE, {
    position,
    rotation,
    pivot,
    nextRotation,
}) {
    const target = normalizeModelRotation(nextRotation);
    const delta = modelRotationQuaternion(THREE, target)
        .multiply(modelRotationQuaternion(THREE, rotation).invert());
    const result = rotateCharacterAboutPivot(THREE, { position, rotation, pivot, delta });
    // Keep the exact values the user typed instead of a re-decomposed twin.
    return { position: result.position, rotation: target };
}
