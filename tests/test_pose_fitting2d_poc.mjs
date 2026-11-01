// Phase 1 PoC regression: one arm with the shoulder fixed. Guards the solver
// choice (Levenberg-Marquardt) against DLS, Jacobian transpose and the existing IK.
import assert from "node:assert/strict";
import test from "node:test";
import { POC_CONFIGS, POC_DRAGS, createPoCScene, runDrag, runExistingIKDrag, runStaticFits } from "./helpers/pose_fitting2d_poc.mjs";

const scene = createPoCScene();

test("static one-arm fits reach sub-pixel error; LM converges in few iterations", () => {
    const rows = runStaticFits(scene, { maxIterations: 100 });
    assert.equal(rows.length, POC_CONFIGS.length * 3);
    for (const config of POC_CONFIGS) {
        const lm = rows.find(row => row.config === config.name && row.method === "lm");
        const jt = rows.find(row => row.config === config.name && row.method === "jt");
        assert.ok(lm.maxErrorPx < 0.6, `${config.name}: ${lm.maxErrorPx}`);
        assert.ok(lm.iterations <= 30, `${config.name}: ${lm.iterations} iterations`);
        assert.ok(lm.iterationsTo05px !== null && lm.iterationsTo05px <= 15, `${config.name}: ${lm.iterationsTo05px}`);
        assert.ok(jt.iterationsTo05px === null || jt.iterationsTo05px >= lm.iterationsTo05px, `${config.name}: JT ${jt.iterationsTo05px}`);
        assert.equal(lm.maxLimitViolationDeg, 0);
        assert.ok(lm.elbowFlexDeg >= 0 && lm.elbowFlexDeg <= 150);
    }
});

test("reachable drags follow every frame without jumps and keep the other targets", () => {
    for (const scenario of POC_DRAGS.filter(item => item.name.includes("reachable") && !item.name.includes("un"))) {
        const lm = runDrag(scene, { ...scenario, method: "lm" });
        assert.ok(lm.perFrame.every(frame => frame.draggedErrorPx < 0.5), `${scenario.name}: dragged ${lm.meanDraggedErrorPx}`);
        assert.ok(lm.maxFixedErrorPx < 0.5, `${scenario.name}: fixed ${lm.maxFixedErrorPx}`);
        assert.ok(lm.maxJumpPx <= lm.targetStepPx * 1.5 + 0.5, `${scenario.name}: jump ${lm.maxJumpPx}`);
        assert.equal(lm.maxViolationDeg, 0);
        assert.ok(lm.final.maxErrorPx < 0.5);
        const existing = runExistingIKDrag(scene, scenario);
        assert.ok(existing.maxFixedErrorPx > lm.maxFixedErrorPx, `${scenario.name}: the existing IK ignores the other marker`);
    }
});

test("unreachable drags stay stable, respect limits and report the residual", () => {
    const scenario = POC_DRAGS.find(item => item.name === "elbow, unreachable");
    const lm = runDrag(scene, { ...scenario, method: "lm" });
    const dls = runDrag(scene, { ...scenario, method: "dls" });
    assert.ok(lm.maxJumpPx <= lm.targetStepPx * 1.5 + 0.5, `jump ${lm.maxJumpPx}`);
    assert.equal(lm.maxViolationDeg, 0);
    assert.ok(lm.final.unreached.includes("l_elbow"));
    assert.ok(lm.maxFixedErrorPx < dls.maxFixedErrorPx, "LM keeps the pinned and fixed targets better than DLS");
    const far = runDrag(scene, { ...POC_DRAGS.find(item => item.name === "wrist, far reach"), method: "lm" });
    assert.ok(far.minFlexDeg >= -0.5, `elbow never hyperextends (${far.minFlexDeg})`);
    assert.ok(far.maxFixedErrorPx < 1, `elbow target kept (${far.maxFixedErrorPx})`);
});

test("drag solves are deterministic", () => {
    const a = runDrag(scene, { ...POC_DRAGS[1], method: "lm" });
    const b = runDrag(scene, { ...POC_DRAGS[1], method: "lm" });
    assert.equal(JSON.stringify(a.finalState), JSON.stringify(b.finalState));
});
