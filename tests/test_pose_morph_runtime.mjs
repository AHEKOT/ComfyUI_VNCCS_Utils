import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
    buildModelIndices,
    calculateMorphFactors,
    parseMorphPack,
    solveMorph,
} from "../web/vnccs_pose_morph_runtime.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_PATH = path.resolve(TEST_DIR, "../web/assets/pose_studio_makehuman.v2.bin.gz");
let cachedData = null;

function loadData() {
    if (cachedData) return cachedData;
    const raw = gunzipSync(fs.readFileSync(ASSET_PATH));
    const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    cachedData = parseMorphPack(buffer);
    return cachedData;
}

test("static MakeHuman asset contains complete Pose Studio model data", () => {
    const data = loadData();
    assert.equal(data.vertexCount, 19158);
    assert.equal(data.baseVertices.length, data.vertexCount * 3);
    assert.equal(data.uvs.length, data.vertexCount * 2);
    assert.equal(data.skinIndices.length, data.vertexCount * 4);
    assert.equal(data.skinWeights.length, data.vertexCount * 4);
    assert.equal(data.targets.length, 562);
    assert.equal(data.bones.length, 53);
    assert.ok(data.baseIndices.length > 80000);
    assert.ok(data.genitalIndices.length > 0);
});

test("JS factor calculation retains MakeHuman interpolation semantics", () => {
    const factors = calculateMorphFactors({
        age: 25,
        gender: 0.25,
        weight: 0.75,
        muscle: 0.1,
        height: 0.5,
        breast_size: 1,
        firmness: 0,
    });
    assert.equal(factors.male, 0.25);
    assert.equal(factors.female, 0.75);
    assert.equal(factors.maxweight, 0.5);
    assert.equal(factors.minweight, 0);
    assert.equal(factors.averageweight, 0.5);
    assert.equal(factors.minmuscle, 0.8);
    assert.equal(factors.averageheight, 1);
    assert.equal(factors.maxcup, 1);
    assert.equal(factors.minfirmness, 1);
});

test("worker-side morph solve updates vertices, bones, and face landmarks", () => {
    const data = loadData();
    const neutral = solveMorph(data, {
        age: 25,
        gender: 0.5,
        weight: 0.5,
        muscle: 0.5,
        height: 0.5,
        breast_size: 0.5,
        firmness: 0.5,
    });
    const changed = solveMorph(data, {
        age: 70,
        gender: 1,
        weight: 0.9,
        muscle: 0.8,
        height: 1,
        breast_size: 0.5,
        firmness: 0.5,
    });
    assert.equal(neutral.vertices.length, data.vertexCount * 3);
    assert.equal(neutral.bonePositions.length, data.bones.length * 6);
    assert.deepEqual(Object.keys(neutral.landmarks).sort(), [
        "head", "jaw", "left_eye", "left_eye_front", "mouth", "nose",
        "right_eye", "right_eye_front",
    ]);
    assert.equal(neutral.landmarkIndices.nose.length, 12);
    assert.ok(neutral.vertices.every(Number.isFinite));
    assert.ok(changed.bonePositions.every(Number.isFinite));
    assert.notDeepEqual(
        Array.from(neutral.vertices.subarray(0, 300)),
        Array.from(changed.vertices.subarray(0, 300)),
    );
});

test("gender topology and precomputed skin weights are valid", () => {
    const data = loadData();
    assert.equal(buildModelIndices(data, false).length, data.baseIndices.length);
    assert.equal(
        buildModelIndices(data, true).length,
        data.baseIndices.length + data.genitalIndices.length,
    );
    for (let vertex = 0; vertex < data.vertexCount; vertex += 113) {
        let total = 0;
        for (let slot = 0; slot < 4; slot++) {
            const offset = vertex * 4 + slot;
            assert.ok(data.skinIndices[offset] < data.bones.length);
            total += data.skinWeights[offset];
        }
        assert.ok(Math.abs(total - 1) < 1e-5, `skin weights are not normalized at vertex ${vertex}`);
    }
});
