export const AZIMUTH_STEPS = Object.freeze([0, 45, 90, 135, 180, 225, 270, 315]);
export const ELEVATION_STEPS = Object.freeze([-30, 0, 30, 60]);
export const DISTANCE_OPTIONS = Object.freeze(["close-up", "medium shot", "wide shot"]);

export const DEFAULT_CAMERA_STATE = Object.freeze({
    azimuth: 0,
    elevation: 0,
    distance: "medium shot",
    include_trigger: true,
    random: false,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function closestValue(values, value) {
    return values.reduce((closest, candidate) => (
        Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest
    ));
}

export function normalizeCameraState(value = {}) {
    const rawAzimuth = Number(value?.azimuth);
    const normalizedAzimuth = Number.isFinite(rawAzimuth)
        ? ((rawAzimuth % 360) + 360) % 360
        : DEFAULT_CAMERA_STATE.azimuth;
    const azimuth = closestValue(
        AZIMUTH_STEPS,
        normalizedAzimuth > 337.5 ? 0 : normalizedAzimuth,
    );

    const rawElevation = Number(value?.elevation);
    const elevation = closestValue(
        ELEVATION_STEPS,
        Number.isFinite(rawElevation) ? rawElevation : DEFAULT_CAMERA_STATE.elevation,
    );

    const distance = DISTANCE_OPTIONS.includes(value?.distance)
        ? value.distance
        : DEFAULT_CAMERA_STATE.distance;

    return {
        azimuth,
        elevation,
        distance,
        include_trigger: typeof value?.include_trigger === "boolean"
            ? value.include_trigger
            : DEFAULT_CAMERA_STATE.include_trigger,
        random: typeof value?.random === "boolean" ? value.random : DEFAULT_CAMERA_STATE.random,
    };
}

export function parseCameraState(rawValue) {
    if (typeof rawValue !== "string" || !rawValue.trim()) {
        return { ...DEFAULT_CAMERA_STATE };
    }

    try {
        return normalizeCameraState(JSON.parse(rawValue));
    } catch (_) {
        return { ...DEFAULT_CAMERA_STATE };
    }
}

export function serializeCameraState(state) {
    return JSON.stringify(normalizeCameraState(state));
}

export function randomizeCameraState(state, random = Math.random) {
    const current = normalizeCameraState(state);
    const combinationCount = AZIMUTH_STEPS.length * ELEVATION_STEPS.length * DISTANCE_OPTIONS.length;
    const currentIndex = (
        AZIMUTH_STEPS.indexOf(current.azimuth) * ELEVATION_STEPS.length
        + ELEVATION_STEPS.indexOf(current.elevation)
    ) * DISTANCE_OPTIONS.length + DISTANCE_OPTIONS.indexOf(current.distance);

    const rawRandom = Number(random());
    const safeRandom = Number.isFinite(rawRandom) ? clamp(rawRandom, 0, 0.9999999999999999) : 0;
    let nextIndex = Math.floor(safeRandom * (combinationCount - 1));

    // Pick from every combination except the current one, so "random" always
    // produces a visibly new set even when the RNG lands on the same slot.
    if (nextIndex >= currentIndex) nextIndex += 1;

    const distanceIndex = nextIndex % DISTANCE_OPTIONS.length;
    nextIndex = Math.floor(nextIndex / DISTANCE_OPTIONS.length);
    const elevationIndex = nextIndex % ELEVATION_STEPS.length;
    const azimuthIndex = Math.floor(nextIndex / ELEVATION_STEPS.length);

    return {
        ...current,
        azimuth: AZIMUTH_STEPS[azimuthIndex],
        elevation: ELEVATION_STEPS[elevationIndex],
        distance: DISTANCE_OPTIONS[distanceIndex],
    };
}

export function computeRadarGeometry(width, height = width) {
    const canvasWidth = Math.max(1, Number(width) || 1);
    const canvasHeight = Math.max(1, Number(height) || 1);
    const size = Math.min(canvasWidth, canvasHeight);
    const padding = clamp(size * 0.075, 10, 22);
    const outerRadius = Math.max(1, (size / 2) - padding);

    return {
        width: canvasWidth,
        height: canvasHeight,
        size,
        centerX: canvasWidth / 2,
        centerY: canvasHeight / 2,
        outerRadius,
        radii: {
            "close-up": outerRadius * 0.36,
            "medium shot": outerRadius * 0.66,
            "wide shot": outerRadius,
        },
    };
}

export function cameraStateFromRadarPoint(state, point, geometry) {
    const current = normalizeCameraState(state);
    const dx = point.x - geometry.centerX;
    const dy = point.y - geometry.centerY;
    const angleRad = Math.atan2(dy, dx);
    let degrees = (Math.PI / 2 - angleRad) * (180 / Math.PI);
    degrees = ((degrees % 360) + 360) % 360;
    const azimuth = AZIMUTH_STEPS[
        Math.round(degrees / 45) % AZIMUTH_STEPS.length
    ];

    const radius = Math.hypot(dx, dy);
    const distance = DISTANCE_OPTIONS.reduce((closest, candidate) => (
        Math.abs(geometry.radii[candidate] - radius)
            < Math.abs(geometry.radii[closest] - radius)
            ? candidate
            : closest
    ));

    return { ...current, azimuth, distance };
}

export function elevationFromRatio(ratio) {
    const degrees = 60 - (clamp(Number(ratio) || 0, 0, 1) * 90);
    return closestValue(ELEVATION_STEPS, degrees);
}
