import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_CAMERA_STATE,
    FRONT_AZIMUTH_STEPS,
    cameraStateFromRadarPoint,
    cameraStateFromPrompt,
    cameraPromptToSkydomeRotation,
    cameraStateToSkydomeRotation,
    computeRadarGeometry,
    elevationFromRatio,
    normalizeCameraState,
    parseCameraState,
    randomizeCameraState,
    serializeCameraState,
} from "../web/vnccs_camera_control_utils.mjs";

test("camera state parsing is backward compatible and normalized", () => {
    assert.deepEqual(parseCameraState("{broken"), DEFAULT_CAMERA_STATE);
    assert.deepEqual(
        parseCameraState(JSON.stringify({
            azimuth: 359,
            elevation: 47,
            distance: "invalid",
            include_trigger: false,
        })),
        {
            azimuth: 0,
            elevation: 60,
            distance: "medium shot",
            include_trigger: false,
            random: false,
            random_azimuth_mode: "full",
        },
    );

    assert.deepEqual(
        JSON.parse(serializeCameraState({
            azimuth: -90,
            elevation: -30,
            distance: "wide shot",
            include_trigger: true,
            random: true,
            random_azimuth_mode: "full",
        })),
        {
            azimuth: 270,
            elevation: -30,
            distance: "wide shot",
            include_trigger: true,
            random: true,
            random_azimuth_mode: "full",
        },
    );
});

test("random mode always selects a new camera combination", () => {
    const current = normalizeCameraState({
        azimuth: 135,
        elevation: 30,
        distance: "close-up",
        include_trigger: false,
        random: true,
        random_azimuth_mode: "full",
    });

    for (let index = 0; index < 95; index += 1) {
        const next = randomizeCameraState(current, () => index / 95);
        assert.notDeepEqual(
            [next.azimuth, next.elevation, next.distance],
            [current.azimuth, current.elevation, current.distance],
        );
        assert.equal(next.include_trigger, false);
        assert.equal(next.random, true);
        assert.equal(next.random_azimuth_mode, "full");
    }
});

test("front random mode limits azimuth but still randomizes height and distance", () => {
    const current = normalizeCameraState({
        azimuth: 0,
        elevation: 0,
        distance: "medium shot",
        random: true,
        random_azimuth_mode: "front",
    });
    const elevations = new Set();
    const distances = new Set();

    for (let index = 0; index < 35; index += 1) {
        const next = randomizeCameraState(current, () => index / 35);
        assert.ok(FRONT_AZIMUTH_STEPS.includes(next.azimuth));
        assert.notDeepEqual(
            [next.azimuth, next.elevation, next.distance],
            [current.azimuth, current.elevation, current.distance],
        );
        elevations.add(next.elevation);
        distances.add(next.distance);
    }

    assert.deepEqual([...elevations].sort((a, b) => a - b), [-30, 0, 30, 60]);
    assert.deepEqual([...distances].sort(), ["close-up", "medium shot", "wide shot"]);
});

test("legacy front-only random metadata migrates to the new mode", () => {
    assert.equal(
        normalizeCameraState({ random_front_only: true }).random_azimuth_mode,
        "front",
    );
});

test("radar geometry remains circular in non-square containers", () => {
    const wide = computeRadarGeometry(480, 220);
    const tall = computeRadarGeometry(220, 480);

    assert.equal(wide.size, 220);
    assert.equal(tall.size, 220);
    assert.equal(wide.centerX, 240);
    assert.equal(wide.centerY, 110);
    assert.equal(tall.centerX, 110);
    assert.equal(tall.centerY, 240);
    assert.equal(wide.outerRadius, tall.outerRadius);
});

test("radar pointer mapping snaps azimuth and distance", () => {
    const geometry = computeRadarGeometry(300);
    const state = { ...DEFAULT_CAMERA_STATE };
    const frontWide = cameraStateFromRadarPoint(
        state,
        {
            x: geometry.centerX,
            y: geometry.centerY + geometry.outerRadius,
        },
        geometry,
    );
    assert.equal(frontWide.azimuth, 0);
    assert.equal(frontWide.distance, "wide shot");

    const rightClose = cameraStateFromRadarPoint(
        state,
        {
            x: geometry.centerX + geometry.radii["close-up"],
            y: geometry.centerY,
        },
        geometry,
    );
    assert.equal(rightClose.azimuth, 90);
    assert.equal(rightClose.distance, "close-up");
});

test("skydome rotation follows horizontal and vertical camera direction", () => {
    assert.deepEqual(
        cameraStateToSkydomeRotation({
            azimuth: 90,
            elevation: 60,
            distance: "wide shot",
        }),
        { yawDegrees: -90, pitchDegrees: 60 },
    );
    assert.deepEqual(
        cameraStateToSkydomeRotation({
            azimuth: 270,
            elevation: -30,
            distance: "medium shot",
        }),
        { yawDegrees: -270, pitchDegrees: -30 },
    );
});

test("skydome rotation is parsed from the resolved prompt of each execution", () => {
    assert.deepEqual(
        cameraStateFromPrompt("<sks> front-left quarter view high-angle shot wide shot"),
        {
            azimuth: 315,
            elevation: 60,
            distance: "wide shot",
            include_trigger: true,
            random: false,
            random_azimuth_mode: "full",
        },
    );
    assert.deepEqual(
        cameraPromptToSkydomeRotation("left side view low-angle shot close-up"),
        { yawDegrees: -270, pitchDegrees: -30 },
    );
    assert.deepEqual(
        cameraPromptToSkydomeRotation(
            "Use a medium shot from a front-right three-quarter angle, with the camera at eye level.",
        ),
        { yawDegrees: -45, pitchDegrees: 0 },
    );
});

test("elevation selector snaps across its vertical range", () => {
    assert.equal(elevationFromRatio(0), 60);
    assert.equal(elevationFromRatio(0.34), 30);
    assert.equal(elevationFromRatio(0.67), 0);
    assert.equal(elevationFromRatio(1), -30);
});
