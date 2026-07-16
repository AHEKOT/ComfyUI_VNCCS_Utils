export const AZIMUTH_STEPS = Object.freeze([0, 45, 90, 135, 180, 225, 270, 315]);
export const FRONT_AZIMUTH_STEPS = Object.freeze([315, 0, 45]);
export const ELEVATION_STEPS = Object.freeze([-30, 0, 30, 60]);
export const DISTANCE_OPTIONS = Object.freeze(["close-up", "medium shot", "wide shot"]);
export const RANDOM_AZIMUTH_MODES = Object.freeze(["full", "front"]);

export const DEFAULT_CAMERA_STATE = Object.freeze({
    azimuth: 0,
    elevation: 0,
    distance: "medium shot",
    include_trigger: true,
    random: false,
    random_azimuth_mode: "full",
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
    const legacyFrontOnly = typeof value?.random_front_only === "boolean"
        ? value.random_front_only
        : null;
    const randomAzimuthMode = RANDOM_AZIMUTH_MODES.includes(value?.random_azimuth_mode)
        ? value.random_azimuth_mode
        : legacyFrontOnly === true ? "front" : DEFAULT_CAMERA_STATE.random_azimuth_mode;

    return {
        azimuth,
        elevation,
        distance,
        include_trigger: typeof value?.include_trigger === "boolean"
            ? value.include_trigger
            : DEFAULT_CAMERA_STATE.include_trigger,
        random: typeof value?.random === "boolean" ? value.random : DEFAULT_CAMERA_STATE.random,
        random_azimuth_mode: randomAzimuthMode,
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

export function cameraStateToSkydomeRotation(state) {
    const normalized = normalizeCameraState(state);
    return {
        yawDegrees: -normalized.azimuth,
        pitchDegrees: normalized.elevation,
    };
}

const CAMERA_PROMPT_AZIMUTHS = Object.freeze([
    [["front-right quarter view", "front-right three-quarter angle"], 45],
    [["back-right quarter view", "back-right three-quarter angle"], 135],
    [["back-left quarter view", "back-left three-quarter angle"], 225],
    [["front-left quarter view", "front-left three-quarter angle"], 315],
    [["right side view", "from the right side"], 90],
    [["left side view", "from the left side"], 270],
    [["front view", "from the front"], 0],
    [["back view", "from the back"], 180],
]);

const CAMERA_PROMPT_ELEVATIONS = Object.freeze([
    [["low-angle shot", "low angle"], -30],
    [["eye-level shot", "eye level"], 0],
    [["elevated shot", "elevated angle"], 30],
    [["high-angle shot", "high angle"], 60],
]);

const CAMERA_PROMPT_DISTANCES = Object.freeze([
    [["close-up"], "close-up"],
    [["medium shot"], "medium shot"],
    [["wide shot"], "wide shot"],
]);

function findPromptCameraValue(text, mappings, fallback) {
    for (const [phrases, value] of mappings) {
        if (phrases.some(phrase => text.includes(phrase))) return value;
    }
    return fallback;
}

export function cameraStateFromPrompt(cameraPrompt) {
    const rawPrompt = String(cameraPrompt ?? "");
    const includeTrigger = /<\s*sks\s*>/i.test(rawPrompt);
    const text = rawPrompt
        .replace(/<\s*sks\s*>/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    return normalizeCameraState({
        ...DEFAULT_CAMERA_STATE,
        azimuth: findPromptCameraValue(
            text,
            CAMERA_PROMPT_AZIMUTHS,
            DEFAULT_CAMERA_STATE.azimuth,
        ),
        elevation: findPromptCameraValue(
            text,
            CAMERA_PROMPT_ELEVATIONS,
            DEFAULT_CAMERA_STATE.elevation,
        ),
        distance: findPromptCameraValue(
            text,
            CAMERA_PROMPT_DISTANCES,
            DEFAULT_CAMERA_STATE.distance,
        ),
        include_trigger: includeTrigger,
    });
}

export function cameraPromptToSkydomeRotation(cameraPrompt) {
    return cameraStateToSkydomeRotation(cameraStateFromPrompt(cameraPrompt));
}

export function randomizeCameraState(state, random = Math.random) {
    const current = normalizeCameraState(state);
    const azimuthSteps = current.random_azimuth_mode === "front"
        ? FRONT_AZIMUTH_STEPS
        : AZIMUTH_STEPS;
    const combinations = [];
    for (const azimuth of azimuthSteps) {
        for (const elevation of ELEVATION_STEPS) {
            for (const distance of DISTANCE_OPTIONS) {
                combinations.push({ azimuth, elevation, distance });
            }
        }
    }
    const candidates = combinations.filter(candidate => (
        candidate.azimuth !== current.azimuth
        || candidate.elevation !== current.elevation
        || candidate.distance !== current.distance
    ));

    const rawRandom = Number(random());
    const safeRandom = Number.isFinite(rawRandom) ? clamp(rawRandom, 0, 0.9999999999999999) : 0;
    const next = candidates[Math.floor(safeRandom * candidates.length)] || combinations[0];

    return {
        ...current,
        ...next,
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
