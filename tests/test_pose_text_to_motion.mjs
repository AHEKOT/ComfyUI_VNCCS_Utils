import assert from "node:assert/strict";
import test from "node:test";

import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import {
    MOTION_API,
    buildMotionRequest,
    captureMotionStartPose,
    clampMotionSettings,
    motionLicenseWarning,
    motionModelLimits,
    retargetMotion,
    retargetMotionFrame,
    TextToMotionPanel,
} from "../web/vnccs_pose_text_to_motion.mjs";

// Motion keys -> mannequin bones, used to fabricate a "generated" motion from mannequin poses.
const MOTION_FROM_BONES = {
    Hips: "pelvis", Spine: "spine_01", Spine1: "spine_02", Spine2: "spine_03", Neck: "neck_01", Head: "head",
    LeftShoulder: "clavicle_l", LeftArm: "upperarm_l", LeftForeArm: "lowerarm_l", LeftHand: "hand_l",
    RightShoulder: "clavicle_r", RightArm: "upperarm_r", RightForeArm: "lowerarm_r", RightHand: "hand_r",
    LeftUpLeg: "thigh_l", LeftLeg: "calf_l", LeftFoot: "foot_l", LeftToeBase: "ball_l",
    RightUpLeg: "thigh_r", RightLeg: "calf_r", RightFoot: "foot_r", RightToeBase: "ball_r",
};

const KIMODO = {
    id: "kimodo-soma-rp-v1.1",
    name: "Kimodo SOMA RP v1.1",
    available: true,
    capabilities: {
        start_pose_constraint: true,
        duration: { min: 1, max: 10, default: 4 },
        steps: { min: 10, max: 200, default: 100 },
        guidance: null,
    },
    license: { name: "NVIDIA Open Model License", url: "https://example.invalid/nvidia", restricted_territories: [] },
    requirements: { vram_gb: 17, notes: "Set TEXT_ENCODER_DEVICE=cpu to save VRAM." },
};
const HY = {
    id: "hy-motion-1.0-lite",
    name: "HY-Motion 1.0 Lite",
    available: false,
    unavailable_reason: "The HY-Motion 1.0 Lite code was not found.",
    install_hint: "git clone https://github.com/Tencent-Hunyuan/HY-Motion-1.0",
    capabilities: {
        start_pose_constraint: false,
        duration: { min: 1, max: 10, default: 4 },
        steps: { min: 10, max: 100, default: 50 },
        guidance: { min: 1, max: 10, default: 5 },
    },
    license: {
        name: "Tencent HY-Motion 1.0 Community License Agreement",
        url: "https://example.invalid/hy-license",
        restricted_territories: ["European Union", "United Kingdom", "South Korea"],
        territory_notice: "THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA",
    },
    requirements: { vram_gb: 24 },
};

function sceneWithRig() {
    const scene = createScene({ skinned: true });
    scene.viewer._initIKHelpers();
    scene.w.canvasContainer = new Element();
    return scene;
}

function bonePoint(viewer, bone) {
    const point = viewer._getBoneWorldPositionForImport(bone);
    return point ? [point.x, point.y, point.z] : null;
}

function captureMotionFrame(viewer) {
    viewer.skinnedMesh.updateMatrixWorld(true);
    const joints = {};
    for (const [key, bone] of Object.entries(MOTION_FROM_BONES)) joints[key] = bonePoint(viewer, bone);
    return joints;
}

function rotateBone(viewer, bone, axis, degrees) {
    const pose = viewer.getPose();
    const rotation = pose.bones?.[bone] || [0, 0, 0];
    rotation[axis] += degrees;
    pose.bones = { ...pose.bones, [bone]: rotation };
    viewer.setPose(pose, true);
}

/** A two-frame motion: the start pose, then the mannequin with a raised left arm and bent knee (pose angles are degrees). */
function fabricateMotion(viewer, start, { lift = 0 } = {}) {
    const first = captureMotionFrame(viewer);
    rotateBone(viewer, "upperarm_l", 2, 50);
    rotateBone(viewer, "calf_r", 0, 45);
    const second = captureMotionFrame(viewer);
    const target = { hand_l: bonePoint(viewer, "hand_l"), foot_r: bonePoint(viewer, "foot_r") };
    viewer.setPose(start.pose, true);
    const joints = {};
    for (const key of Object.keys(first)) {
        joints[key] = [first[key], second[key].map((value, axis) => value + (axis === 1 ? lift : 0))];
    }
    return { motion: { fps: 30, frame_count: 2, joints, rotations: {}, use_start_pose: true, seed: 3 }, target };
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("model limits, clamping and requests follow the selected model", () => {
    assert.deepEqual(motionModelLimits(KIMODO).steps, { min: 10, max: 200, default: 100 });
    assert.equal(motionModelLimits(KIMODO).guidance, null);
    assert.equal(motionModelLimits(HY).startPoseConstraint, false);

    const clean = clampMotionSettings({ prompt: "  walk   forward ", duration: 99, steps: 1, guidance: 50, seed: "12" }, HY);
    assert.equal(clean.prompt, "walk forward");
    assert.equal(clean.duration, 10);
    assert.equal(clean.steps, 10);
    assert.equal(clean.guidance, 10);
    assert.equal(clean.seed, 12);
    assert.equal(clampMotionSettings({ seed: "12", randomSeed: true }, HY).seed, null);

    const start = { keypoints: { pelvis: [0, 1, 0] }, restKeypoints: {}, headAxes: null };
    const kimodo = buildMotionRequest({ prompt: "jump", steps: 40, guidance: 3 }, start, "t1", KIMODO);
    assert.equal(kimodo.model, KIMODO.id);
    assert.equal(kimodo.steps, 40);
    assert.equal("guidance" in kimodo, false);
    const hy = buildMotionRequest({ prompt: "jump", guidance: 3 }, start, "t2", HY);
    assert.equal(hy.guidance, 3);
    assert.equal(hy.steps, 50);
});

test("license warning names the excluded territories", () => {
    assert.equal(motionLicenseWarning(KIMODO), "");
    const warning = motionLicenseWarning(HY);
    assert.match(warning, /does not apply in the European Union, United Kingdom and South Korea/);
    assert.match(warning, /HY-Motion 1\.0 Lite/);
});

test("start pose capture keeps the pose and history", () => {
    const { viewer } = sceneWithRig();
    rotateBone(viewer, "upperarm_r", 2, -30);
    viewer.recordState?.();
    const before = JSON.stringify(viewer.getPose());
    const history = viewer.history?.length;
    const start = captureMotionStartPose(viewer);
    assert.equal(JSON.stringify(viewer.getPose()), before);
    assert.equal(viewer.history?.length, history);
    for (const name of ["pelvis", "neck_01", "head", "hand_l", "foot_r", "index_01_l"]) {
        assert.ok(start.keypoints[name], name);
        assert.ok(start.restKeypoints[name], name);
    }
    assert.ok(start.headAxes?.up && start.headAxes?.forward);
    assert.ok(start.worldRotations.hand_l);
});

test("relative retarget reproduces the start pose and follows the motion", () => {
    const { viewer } = sceneWithRig();
    rotateBone(viewer, "spine_02", 0, 15);
    const start = captureMotionStartPose(viewer);
    const { motion, target } = fabricateMotion(viewer, start);

    const frame0 = retargetMotionFrame(viewer, motion, 0, start);
    assert.ok(frame0);
    viewer.setPose(frame0, true);
    viewer.skinnedMesh.updateMatrixWorld(true);
    for (const bone of ["hand_l", "hand_r", "foot_l", "foot_r", "head"]) {
        assert.ok(distance(bonePoint(viewer, bone), start.keypoints[bone]) < 0.1, bone);
    }

    const frame1 = retargetMotionFrame(viewer, motion, 1, start);
    viewer.setPose(frame1, true);
    viewer.skinnedMesh.updateMatrixWorld(true);
    // The hand and foot travel about 2.5 scene units; the retarget lands within a few percent.
    assert.ok(distance(start.keypoints.hand_l, target.hand_l) > 1.5);
    assert.ok(distance(bonePoint(viewer, "hand_l"), target.hand_l) < 0.2, "left hand follows the raised arm");
    assert.ok(distance(bonePoint(viewer, "foot_r"), target.foot_r) < 0.2, "right foot follows the bent knee");
    // Fingers are not part of the motion, so they keep the start pose's shape.
    const fingerSpan = (keypoints) => distance(keypoints.index_03_r, keypoints.hand_r);
    const now = Object.fromEntries(["index_03_r", "hand_r"].map((bone) => [bone, bonePoint(viewer, bone)]));
    assert.ok(Math.abs(fingerSpan(now) - fingerSpan(start.keypoints)) < 1e-3);
});

test("the pelvis follows vertical root motion and keep-in-place drops travel", async () => {
    const { viewer } = sceneWithRig();
    const start = captureMotionStartPose(viewer);
    const { motion } = fabricateMotion(viewer, start, { lift: 1.5 });
    for (const joint of Object.values(motion.joints)) joint[1] = [joint[1][0] + 2, joint[1][1], joint[1][2]];

    const poses = await retargetMotion(viewer, motion, start, { keepInPlace: true });
    assert.equal(poses.length, 2);
    assert.equal(JSON.stringify(viewer.getPose()), JSON.stringify(start.pose), "retarget restores the start pose");
    viewer.setPose(poses[1], true);
    viewer.skinnedMesh.updateMatrixWorld(true);
    const pelvis = bonePoint(viewer, "pelvis");
    assert.ok(Math.abs(pelvis[1] - start.keypoints.pelvis[1] - 1.5) < 0.05);
    assert.ok(Math.abs(pelvis[0] - start.keypoints.pelvis[0]) < 0.05);

    const moving = await retargetMotion(viewer, motion, start, { keepInPlace: false });
    viewer.setPose(moving[1], true);
    viewer.skinnedMesh.updateMatrixWorld(true);
    assert.ok(Math.abs(bonePoint(viewer, "pelvis")[0] - start.keypoints.pelvis[0] - 2) < 0.05);
});

test("a model without some joints keeps the start pose there", () => {
    const { viewer } = sceneWithRig();
    const start = captureMotionStartPose(viewer);
    const { motion } = fabricateMotion(viewer, start);
    for (const key of ["LeftToeBase", "RightToeBase", "Spine", "Spine1", "LeftShoulder", "RightShoulder"]) delete motion.joints[key];
    assert.ok(retargetMotionFrame(viewer, motion, 1, start));

    // Absolute mode needs the full body; missing joints fall back to the relative path.
    delete motion.joints.LeftHand;
    motion.use_start_pose = false;
    assert.ok(retargetMotionFrame(viewer, motion, 1, start));
});

function fakeApi(models, onGenerate) {
    const calls = [];
    const fetchApi = async (route, options = {}) => {
        calls.push({ route, options });
        const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
        if (route === `${MOTION_API}/models`) return json({ models, default: models[0].id });
        if (route.startsWith(`${MOTION_API}/status/`)) return json({ status: "running", progress: 50, message: "..." });
        if (route === `${MOTION_API}/generate`) return onGenerate(JSON.parse(options.body), json);
        return json({ error: "unknown" }, 404);
    };
    return { fetchApi, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("panel lists models, warns about license territories, generates and applies a frame", async () => {
    const { w, viewer, document } = sceneWithRig();
    const start = captureMotionStartPose(viewer);
    const { motion } = fabricateMotion(viewer, start);
    let requestBody = null;
    const { fetchApi } = fakeApi([KIMODO, { ...HY, available: true }], (body, json) => {
        requestBody = body;
        return json({ status: "success", motion: { ...motion, seed: 99, model: body.model } });
    });
    const panel = new TextToMotionPanel(w, { fetchApi, document });

    panel.open();
    await settle();
    await settle();
    const { modelSelect, license, guidanceLabel } = panel.controls;
    assert.equal(modelSelect.children.length, 2);
    assert.equal(panel.settings.model, KIMODO.id);
    assert.equal(license.children.length, 0);
    assert.equal(guidanceLabel.style.display, "none");

    modelSelect.value = HY.id;
    modelSelect.emit("change");
    assert.match(license.children[0].textContent, /European Union, United Kingdom and South Korea/);
    assert.equal(license.children[1].href, HY.license.url);
    assert.equal(guidanceLabel.style.display, "");
    assert.equal(panel.controls.steps.value, "50", "steps reset to the new model's default");

    panel.settings.prompt = "wave with the left hand";
    panel.updateButtons();
    assert.equal(panel.controls.generate.disabled, false);
    await panel.generate();
    assert.equal(requestBody.model, HY.id);
    assert.equal(requestBody.guidance, 5);
    assert.equal(panel.poses.length, 2);
    assert.equal(panel.settings.seed, "99");

    panel.controls.scrub.value = "1";
    panel.controls.scrub.emit("input");
    assert.equal(panel.frame, 1);
    const chosen = JSON.stringify(viewer.getPose());
    panel.accept();
    assert.equal(panel.isOpen(), false);
    assert.equal(JSON.stringify(viewer.getPose()), chosen);
});

test("panel blocks generation for a model that is not installed and shows its install hint", async () => {
    const { w, viewer, document } = sceneWithRig();
    const { fetchApi, calls } = fakeApi([HY], (_body, json) => json({ error: "should not run" }, 500));
    const panel = new TextToMotionPanel(w, { fetchApi, document });
    const before = JSON.stringify(viewer.getPose());
    panel.open();
    await settle();
    await settle();
    panel.settings.prompt = "run";
    panel.updateButtons();
    assert.equal(panel.controls.generate.disabled, true);
    assert.match(panel.controls.hint.textContent, /git clone/);
    await panel.generate();
    assert.equal(calls.filter((call) => call.route.endsWith("/generate")).length, 0);
    panel.cancel();
    assert.equal(JSON.stringify(viewer.getPose()), before);
});
