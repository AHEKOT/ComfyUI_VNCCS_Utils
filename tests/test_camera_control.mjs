import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_CAMERA_STATE,
    cameraStateFromRadarPoint,
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
        },
    );

    assert.deepEqual(
        JSON.parse(serializeCameraState({
            azimuth: -90,
            elevation: -30,
            distance: "wide shot",
            include_trigger: true,
            random: true,
        })),
        {
            azimuth: 270,
            elevation: -30,
            distance: "wide shot",
            include_trigger: true,
            random: true,
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
    });

    for (let index = 0; index < 95; index += 1) {
        const next = randomizeCameraState(current, () => index / 95);
        assert.notDeepEqual(
            [next.azimuth, next.elevation, next.distance],
            [current.azimuth, current.elevation, current.distance],
        );
        assert.equal(next.include_trigger, false);
        assert.equal(next.random, true);
    }
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

test("elevation selector snaps across its vertical range", () => {
    assert.equal(elevationFromRatio(0), 60);
    assert.equal(elevationFromRatio(0.34), 30);
    assert.equal(elevationFromRatio(0.67), 0);
    assert.equal(elevationFromRatio(1), -30);
});
