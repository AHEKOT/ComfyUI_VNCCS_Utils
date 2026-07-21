import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const modelManagerSource = await readFile(new URL("../web/vnccs_model_manager.js", import.meta.url), "utf8");
const uniCanvasSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const poseStudioSource = await readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const poseStudioCoreSource = await readFile(new URL("../web/vnccs_pose_studio_core.js", import.meta.url), "utf8");
const poseAnimationSource = await readFile(new URL("../web/vnccs_pose_animation.mjs", import.meta.url), "utf8");


test("Model Manager never interpolates remote data into innerHTML", () => {
    const assignments = modelManagerSource.matchAll(/innerHTML\s*\+?=\s*(`[^`]*`|"[^"]*"|'[^']*')/gs);
    for (const assignment of assignments) {
        assert.equal(assignment[1].includes("${"), false, assignment[0]);
    }
    assert.match(modelManagerSource, /appendTextElement\(topRow, "span", model\.name/);
    assert.match(modelManagerSource, /appendTextElement\(el, "div", m\.name/);
});


test("DOM widgets release global listeners and timers on removal", () => {
    assert.match(modelManagerSource, /this\.listWidget\?\.dispose\(\)/);
    assert.match(modelManagerSource, /this\.selectorWidget\?\.dispose\(\)/);
    assert.match(modelManagerSource, /removeEventListener\("vnccs-registry-updated"/);
    assert.match(uniCanvasSource, /this\._eventAbortController\?\.abort\(\)/);
    assert.match(uniCanvasSource, /this\.stopDrawProgressPolling\(\)/);
    assert.match(poseStudioSource, /document\.removeEventListener\("pointerdown", this\.studioWidget\._boundHandleDocumentPointerDown\)/);
});


test("Pose Studio sync lock is reset in a finally block", () => {
    const start = poseStudioSource.indexOf("syncToNode(fullCapture = false, options = {})");
    const end = poseStudioSource.indexOf("\n    loadFromNode()", start);
    const method = poseStudioSource.slice(start, end);
    assert.match(method, /this\._isSyncing = true;\s*try \{/);
    assert.match(method, /finally \{\s*this\._isSyncing = false;/);
});


test("Pose Manager regenerates missing previews after worker model load and mode entry", () => {
    const modeStart = poseStudioSource.indexOf("setInterfaceMode(mode, { sync = true } = {})");
    const modeEnd = poseStudioSource.indexOf("\n    applyInterfaceMode()", modeStart);
    const modeMethod = poseStudioSource.slice(modeStart, modeEnd);
    assert.match(
        modeMethod,
        /normalized === "manager"[\s\S]*renderPoseManager\(\);[\s\S]*scheduleAllManagerPreviewRefresh\(\);/,
    );

    const loadStart = poseStudioSource.indexOf("loadModel(showOverlay = true, recenterViewport = true)");
    const loadEnd = poseStudioSource.indexOf("\n    isLiveMorphKey", loadStart);
    const loadMethod = poseStudioSource.slice(loadStart, loadEnd);
    assert.match(
        loadMethod,
        /viewer\.isInitialized\(\)[\s\S]*syncToNode\(true\);[\s\S]*scheduleAllManagerPreviewRefresh\(\);/,
    );
});


test("Pose Manager waits for the real skin texture before capture", () => {
    const refreshStart = poseStudioSource.indexOf("refreshAllManagerPreviews(generation");
    const refreshEnd = poseStudioSource.indexOf("\n    updateExistingPoseManagerDetailCards", refreshStart);
    const refreshMethod = poseStudioSource.slice(refreshStart, refreshEnd);
    assert.match(refreshMethod, /isCaptureReady\?\.\(\) === false/);
    assert.match(refreshMethod, /waitForCaptureReady\?\.\(\)/);

    assert.match(poseStudioCoreSource, /isCaptureReady\(\)/);
    assert.match(poseStudioCoreSource, /waitForCaptureReady\(\)/);
    assert.match(
        poseStudioCoreSource,
        /map: skinTex,[\s\S]*color: skinTex \? 0xffffff : \(textureSkinningEnabled \? 0xc8b5aa : 0xaaaaaa\)/,
    );
});


test("Pose Manager exposes Head Size and refreshes it without rebuilding the morph model", () => {
    const sidebarStart = poseStudioSource.indexOf("_createPoseManagerSidebar()");
    const sidebarEnd = poseStudioSource.indexOf("\n    createManagerSlider", sidebarStart);
    const sidebarMethod = poseStudioSource.slice(sidebarStart, sidebarEnd);
    assert.match(
        sidebarMethod,
        /key: "head_size", label: "Head Size", min: 0\.5, max: 2\.0, step: 0\.01/,
    );

    const applyStart = poseStudioSource.indexOf("applyManagerMeshValue(key, value, options = {})");
    const applyEnd = poseStudioSource.indexOf("\n    applyExternalCharacterCreatorValues", applyStart);
    const applyMethod = poseStudioSource.slice(applyStart, applyEnd);
    assert.match(applyMethod, /key === "head_size"/);
    assert.match(applyMethod, /viewer\?\.updateHeadScale\?\.\(value\)/);
    assert.match(applyMethod, /scheduleAllManagerPreviewRefresh\(\)/);
});


test("each Pose Manager model generation restarts preview capture from the first card", () => {
    const scheduleStart = poseStudioSource.indexOf("\n    scheduleAllManagerPreviewRefresh() {");
    const scheduleEnd = poseStudioSource.indexOf("\n    refreshAllManagerPreviews", scheduleStart);
    const scheduleMethod = poseStudioSource.slice(scheduleStart, scheduleEnd);
    assert.match(scheduleMethod, /this\._managerPreviewRefreshNextIndex = 0;/);
    assert.doesNotMatch(scheduleMethod, /isMidRefresh/);

    const workerStart = poseStudioSource.indexOf("handleMorphWorkerMessage(message)");
    const workerEnd = poseStudioSource.indexOf("\n    flushPendingMorphSolve", workerStart);
    const workerMethod = poseStudioSource.slice(workerStart, workerEnd);
    assert.ok(
        workerMethod.indexOf("ageFitChanged = this.applyAgeCameraFit()")
            < workerMethod.indexOf("this.scheduleAllManagerPreviewRefresh()"),
        "AGE camera fitting must finish before preview capture is scheduled",
    );
});


test("animation timeline fills its viewport and exposes mouse-draggable horizontal scrolling", () => {
    assert.match(poseAnimationSource, /viewportWidth: this\.body\?\.clientWidth/);
    assert.match(poseAnimationSource, /this\.horizontalScrollInput\.type = "range"/);
    assert.match(
        poseAnimationSource,
        /this\.body\.scrollLeft = Number\(this\.horizontalScrollInput\.value\) \|\| 0/,
    );
    assert.match(
        poseAnimationSource,
        /this\.body\.addEventListener\("scroll", \(\) => \{\s*this\._syncHorizontalScrollbar\(\)/,
    );
    assert.match(poseStudioSource, /\.vnccs-ps-tl-body \{[\s\S]*overflow-x: hidden;[\s\S]*overflow-y: auto;/);
    assert.match(
        poseAnimationSource,
        /this\.body\.addEventListener\("wheel", event => \{[\s\S]*this\.body\.scrollLeft = clamp\(/,
    );
    assert.match(poseStudioSource, /\.vnccs-ps-tl-horizontal-scroll\.visible \{\s*display: flex;/);
});
