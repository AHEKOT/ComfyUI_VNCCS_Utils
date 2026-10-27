import assert from "node:assert/strict";
import test from "node:test";
import { createScene } from "./helpers/pose_studio_scene.mjs";

function referenceLoads(scene) {
    const loads = [];
    scene.viewer.THREE = { ...scene.THREE, TextureLoader: class {
        load(url, ready, _progress, error) { loads.push({ url, ready, error }); }
    } };
    return loads;
}
const texture = () => ({ dispose() {} });

test("skin replacement releases the previous texture after every character uses the new texture", () => {
    const scene = createScene(), loads = referenceLoads(scene), { viewer, THREE } = scene;
    viewer.options.enableTextureSkinning = true;
    viewer.options.skinMode = "naked";
    const passive = { mesh: { material: new THREE.MeshStandardMaterial() }, color: "#ffffff" };
    viewer.passiveCharacters.set("passive", passive);
    const first = texture(), second = texture();
    let disposed = 0;
    first.dispose = () => {
        assert.equal(viewer.skinnedMesh.material.map, second);
        assert.equal(passive.mesh.material.map, second);
        disposed++;
    };
    viewer.setSkinTexture("naked");
    loads[0].ready(first);
    viewer.setSkinTexture("naked_marks");
    assert.equal(viewer.skinnedMesh.material.map, first, "keep the last valid texture during loading");
    assert.equal(disposed, 0);
    loads[1].ready(second);
    assert.equal(disposed, 1);
    assert.equal(viewer.cachedSkinTexture, second);
    viewer.setSkinTexture("naked_marks");
    assert.equal(loads.length, 2, "reusing the cached texture needs no new load");
    assert.equal(disposed, 1);
});

test("captures wait for the newest skin without waiting for a superseded load", async () => {
    const scene = createScene(), loads = referenceLoads(scene), { viewer } = scene;
    viewer.options.enableTextureSkinning = true;
    viewer.options.skinMode = "naked";
    viewer.setSkinTexture("naked");
    const ready = viewer.waitForCaptureReady();
    let finished = false;
    ready.then(() => { finished = true; });
    viewer.setSkinTexture("naked_marks");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, "superseding the old request must not capture the still-loading skin");
    assert.equal(viewer.isCaptureReady(), false);
    const newest = texture();
    loads[1].ready(newest);
    assert.equal(await Promise.race([ready, new Promise(resolve => setImmediate(() => resolve("still waiting")))]), true);
    let disposed = 0;
    const stale = { dispose() { disposed++; } };
    loads[0].ready(stale);
    assert.equal(disposed, 1);
    assert.equal(viewer.cachedSkinTexture, newest);
});

for (const replacement of ["cached skin", "flat color", "dispose"]) {
    test(`${replacement} releases capture readiness from a pending skin load`, async () => {
        const scene = createScene(), loads = referenceLoads(scene), { viewer } = scene;
        viewer.options.enableTextureSkinning = true;
        viewer.options.skinMode = "naked";
        viewer.setSkinTexture("naked");
        const saved = texture();
        loads[0].ready(saved);
        viewer.setSkinTexture("naked_marks");
        const ready = viewer.waitForCaptureReady();
        const result = ready.catch(error => error.message);
        if (replacement === "cached skin") viewer.setSkinTexture("naked");
        if (replacement === "flat color") viewer.setSkinMode("flat_color");
        if (replacement === "dispose") {
            viewer.orbit.dispose = () => {};
            viewer.dispose();
        }
        const settled = await Promise.race([result, new Promise(resolve => setImmediate(() => resolve("still waiting")))]);
        if (replacement === "dispose") assert.match(settled, /disposed/i);
        else assert.equal(settled, true);
        let disposed = 0;
        loads[1].ready({ dispose() { disposed++; } });
        assert.equal(disposed, 1);
    });
}

test("a failed skin replacement retains the valid cached texture", async () => {
    const scene = createScene(), loads = referenceLoads(scene), { viewer } = scene;
    viewer.options.enableTextureSkinning = true;
    viewer.options.skinMode = "naked";
    let disposed = 0;
    const saved = { dispose() { disposed++; } };
    viewer.setSkinTexture("naked");
    loads[0].ready(saved);
    viewer.setSkinTexture("naked_marks");
    loads[1].error(new Error("decode failed"));
    assert.equal(await viewer.waitForCaptureReady(), true);
    assert.equal(viewer.skinnedMesh.material.map, saved);
    assert.equal(viewer.cachedSkinTexture, saved);
    assert.equal(disposed, 0);
});

test("captures wait for the newest background texture, including replacement while waiting", async () => {
    const scene = createScene(), loads = referenceLoads(scene);
    scene.viewer.loadReferenceImage("first");
    let finished = false;
    const ready = scene.viewer.waitForCaptureReady().then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(scene.viewer.isCaptureReady(), false);
    assert.equal(finished, false);
    scene.viewer.loadReferenceImage("second");
    loads[0].ready(texture());
    await Promise.resolve();
    assert.equal(finished, false);
    loads[1].ready(texture());
    await ready;
    assert.equal(scene.viewer.isCaptureReady(), true);
});

test("failed backgrounds report a capture error and removing them releases pending captures", async () => {
    const scene = createScene(), loads = referenceLoads(scene);
    scene.viewer.loadReferenceImage("broken");
    const failed = scene.viewer.waitForCaptureReady();
    loads[0].error(new Error("decode failed"));
    await assert.rejects(failed, /background image/i);
    scene.viewer.loadReferenceImage("removed");
    const ready = scene.viewer.waitForCaptureReady();
    scene.viewer.removeReferenceImage();
    await ready;
    assert.equal(scene.viewer.isCaptureReady(), true);
});

test("disposing during background loading rejects pending capture readiness", async () => {
    const scene = createScene();
    referenceLoads(scene);
    scene.viewer.loadReferenceImage("pending");
    const ready = scene.viewer.waitForCaptureReady();
    scene.viewer.orbit.dispose = () => {};
    scene.viewer.dispose();
    await assert.rejects(ready, /disposed/i);
});

test("disposing releases the loaded background once and rejects a late replacement", async () => {
    const scene = createScene(), loads = referenceLoads(scene), { viewer } = scene;
    viewer.scene.add(viewer.captureCamera);
    viewer.loadReferenceImage("loaded");
    let textureDisposals = 0, geometryDisposals = 0, materialDisposals = 0, lateDisposals = 0;
    loads[0].ready({ dispose() { textureDisposals++; } });
    const plane = viewer.refPlane;
    plane.geometry.addEventListener("dispose", () => { geometryDisposals++; });
    plane.material.addEventListener("dispose", () => { materialDisposals++; });
    viewer.loadReferenceImage("pending");
    const ready = viewer.waitForCaptureReady();
    viewer.orbit.dispose = () => {};
    viewer.dispose();
    await assert.rejects(ready, /disposed/i);
    assert.deepEqual([textureDisposals, geometryDisposals, materialDisposals], [1, 1, 1]);
    assert.equal(viewer.refPlane, null);
    assert.equal(plane.parent, null);
    loads[1].ready({ dispose() { lateDisposals++; } });
    assert.deepEqual([textureDisposals, geometryDisposals, materialDisposals, lateDisposals], [1, 1, 1, 1]);
    assert.equal(viewer.refPlane, null);
});

test("disposing frees capture frame and imported skeleton line resources", () => {
    const { viewer, THREE } = createScene({ skinned: true });
    viewer.orbit.dispose = () => {};
    viewer.captureFrame = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    viewer.scene.add(viewer.captureFrame);
    viewer._drawHMR2Figure({ neck: new THREE.Vector3(0, 1, 0), neck_tail: new THREE.Vector3(0, 2, 0) });
    const lines = [viewer.captureFrame, ...viewer._hmr2FigureGroup.children.filter(object => object.isLine)];
    assert.equal(lines.length, 2);
    const counts = lines.map(line => {
        const count = { geometry: 0, material: 0 };
        line.geometry.addEventListener("dispose", () => { count.geometry++; });
        line.material.addEventListener("dispose", () => { count.material++; });
        return count;
    });
    viewer.dispose();
    assert.deepEqual(counts, lines.map(() => ({ geometry: 1, material: 1 })));
});

test("manager background failures end preview refresh with a useful error", async () => {
    const scene = createScene(), loads = referenceLoads(scene), messages = [];
    scene.w.interfaceMode = "manager";
    scene.w._managerPreviewRefreshGeneration = 1;
    scene.w.showMessage = message => messages.push(message);
    scene.viewer.loadReferenceImage("broken");
    scene.w.refreshAllManagerPreviews(1);
    loads[0].error(new Error("decode failed"));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(scene.w._managerPreviewRefreshError.message, /background image/i);
    assert.equal(messages.length, 1);
    await assert.rejects(scene.w.awaitManagerPreviewRefresh(1), /background image/i);
});

test("a timed-out static morph response cannot overwrite the current body or stop another solve", async () => {
    const scene = createScene(), sent = [];
    scene.w.ensureMorphWorker = () => ({ postMessage: message => sent.push(message) });
    const pending = scene.w.requestStaticMorphModel();
    const timeout = [...scene.timers.values()].at(-1);
    timeout();
    await assert.rejects(pending, /Timed out/);
    scene.w._morphSolveInFlight = true;
    scene.viewer.updateBodyVertices = () => assert.fail("expired response must be ignored");
    scene.w.handleMorphWorkerMessage({ type: "result", seq: sent[0].seq });
    assert.equal(scene.w._morphSolveInFlight, true);
    scene.w.handleMorphWorkerMessage({ type: "error", seq: sent[0].seq, message: "expired failure" });
    assert.equal(scene.w._morphSolveInFlight, true);
    assert.equal(scene.w._morphWorkerFailed, false);
});

test("an unset thumbnail preference keeps the declared default size", () => {
    const scene = createScene();
    assert.equal(scene.w.libraryThumbSize, scene.w.getLibraryThumbnailBounds().defaultSize);
});
