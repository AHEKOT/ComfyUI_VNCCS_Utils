import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const modelManagerSource = await readFile(new URL("../web/vnccs_model_manager.js", import.meta.url), "utf8");
const uniCanvasSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const poseStudioSource = await readFile(new URL("../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const poseStudioCoreSource = await readFile(new URL("../web/vnccs_pose_studio_core.js", import.meta.url), "utf8");
const poseAnimationSource = await readFile(new URL("../web/vnccs_pose_animation.mjs", import.meta.url), "utf8");
const poseCharactersSource = await readFile(new URL("../web/vnccs_pose_characters.mjs", import.meta.url), "utf8");


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


test("Pose Studio upload rejects HTTP sync failures", () => {
    const helperStart = poseStudioSource.indexOf("const requirePoseStudioSyncResponse = async");
    const eventEnd = poseStudioSource.indexOf("\n        api.addEventListener(\"vnccs_apply_sam3d_pose\"", helperStart);
    const normalSyncPath = poseStudioSource.slice(helperStart, eventEnd);
    assert.match(normalSyncPath, /if \(!response\.ok\)/);
    assert.match(normalSyncPath, /throw new Error\(message\)/);
    assert.match(normalSyncPath, /await requirePoseStudioSyncResponse\(response\)/);
    assert.match(normalSyncPath, /await reportPoseStudioSyncFailure\(nodeId, syncToken, e\)/);
});


test("Pose Library image previews preserve their aspect ratio without cropping", () => {
    const rule = poseStudioSource.match(/\.vnccs-ps-library-item-preview img\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(rule, /max-width:\s*100%/);
    assert.match(rule, /max-height:\s*100%/);
    assert.match(rule, /width:\s*auto/);
    assert.match(rule, /height:\s*auto/);
    assert.match(rule, /object-fit:\s*contain/);
    assert.doesNotMatch(rule, /object-fit:\s*cover/);
});

test("Pose Studio library launcher uses the concise product name", () => {
    assert.match(poseStudioSource, /> Pose Library';/);
    assert.doesNotMatch(poseStudioSource, /Pose Library Gallery/);
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

test("Pose Manager independently fits and centers every deformed pose preview", () => {
    const refreshStart = poseStudioSource.indexOf("refreshAllManagerPreviews(generation");
    const refreshEnd = poseStudioSource.indexOf("\n    updateExistingPoseManagerDetailCards", refreshStart);
    const refreshMethod = poseStudioSource.slice(refreshStart, refreshEnd);
    assert.match(refreshMethod, /viewer\.setPose\(pose, true\);[\s\S]*computeModelFitFraming\?\.\(/);
    assert.match(
        refreshMethod,
        /viewer\.capture\([\s\S]*framing\?\.zoom \?\? 1,[\s\S]*framing\?\.offsetX \?\? 0,[\s\S]*framing\?\.offsetY \?\? 0/,
    );
    assert.match(
        refreshMethod,
        /finally \{[\s\S]*viewer\.updateCaptureCamera\?\.\(w, h, 1, 0, 0, yaw, pitch\);/,
        "manager preview fitting must not leak its temporary camera into Studio or library poses",
    );

    assert.match(poseStudioCoreSource, /computeModelFitFraming\(/);
    assert.match(poseStudioCoreSource, /const determinant = j00 \* j11 - j01 \* j10;/);
});

test("Reset clears library framing together with the pose", () => {
    const fitStart = poseStudioSource.indexOf("\n    fitActiveRestPoseToFrame() {");
    const resetStart = poseStudioSource.indexOf("\n    resetCurrentPose() {");
    const resetEnd = poseStudioSource.indexOf("\n    resetCurrentAnimation()", resetStart);
    const fitMethod = poseStudioSource.slice(fitStart, resetStart);
    const resetMethod = poseStudioSource.slice(resetStart, resetEnd);
    assert.match(fitMethod, /viewer\.computeModelFitFraming\(/);
    assert.match(fitMethod, /cameraFramingToCharacterTransform\(/);
    assert.match(fitMethod, /active\.transform = \{ \.\.\.transform \};/);
    assert.match(resetMethod, /viewer\.resetPose\(\);[\s\S]*fitActiveRestPoseToFrame\(\);/);
    assert.match(
        resetMethod,
        /syncToNode\(false, \{ skipCapture: true, skipCaptureUpload: true \}\);/,
    );
    assert.match(resetMethod, /this\.poseCaptures\[this\.activeTab\] = null;/);

    const clearStart = poseAnimationSource.indexOf("export function createClearedAnimationState");
    const clearEnd = poseAnimationSource.indexOf("\nexport function serializeAnimationStateSnapshot", clearStart);
    const clearMethod = poseAnimationSource.slice(clearStart, clearEnd);
    assert.match(clearMethod, /baseTransform: DEFAULT_ANIMATION_CHARACTER_TRANSFORM/);
    assert.doesNotMatch(clearMethod, /previous\.baseTransform/);
});

test("state-only sync can suppress capture-cache upload retries", () => {
    const syncStart = poseStudioSource.indexOf("\n    syncToNode(fullCapture = false, options = {})");
    const syncEnd = poseStudioSource.indexOf("\n    loadFromNode()", syncStart);
    const syncMethod = poseStudioSource.slice(syncStart, syncEnd);
    assert.match(
        syncMethod,
        /if \(options\.skipCaptureUpload !== true\) \{[\s\S]*this\.queueCaptureUpload\(captureId\);/,
    );

    const uploadStart = poseStudioSource.indexOf("\n    queueCaptureUpload(captureId)");
    const uploadEnd = poseStudioSource.indexOf("\n    syncToNode(", uploadStart);
    const uploadMethod = poseStudioSource.slice(uploadStart, uploadEnd);
    assert.match(uploadMethod, /captures\.every\(capture => typeof capture === "string" && capture\.length > 0\)/);
    assert.match(uploadMethod, /error\?\.status !== 413/);
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


test("Characters section follows Prompt and starts collapsed", () => {
    const sidebarStart = poseStudioSource.indexOf("_createRightSidebar()");
    const sidebarEnd = poseStudioSource.indexOf("\n    _setupFinalUI()", sidebarStart);
    const sidebarMethod = poseStudioSource.slice(sidebarStart, sidebarEnd);
    const promptAppend = sidebarMethod.indexOf("rightSidebar.appendChild(promptSection.el)");
    const charactersCreate = sidebarMethod.indexOf('this.createSection("Characters", false)');
    const charactersAppend = sidebarMethod.indexOf("rightSidebar.appendChild(charactersSection.el)");

    assert.ok(promptAppend >= 0, "Prompt section must be appended to the right sidebar");
    assert.ok(charactersCreate > promptAppend, "Characters must be created after Prompt");
    assert.ok(charactersAppend > charactersCreate, "Characters must be appended after it is created");
});


test("the original camera positioning widget controls the selected character", () => {
    const leftStart = poseStudioSource.indexOf("_createLeftPanel()");
    const leftEnd = poseStudioSource.indexOf("\n    _createCenterPanel()", leftStart);
    const leftPanel = poseStudioSource.slice(leftStart, leftEnd);
    assert.match(leftPanel, /createSliderField\("Zoom", "cam_zoom"/);
    assert.match(leftPanel, /this\.createCameraRadar\(camSection\)/);

    const characterStart = poseStudioSource.indexOf("\n    renderCharactersUI() {");
    const characterEnd = poseStudioSource.indexOf("\n    persistActivePoseCameraParams()", characterStart);
    const characterPanel = poseStudioSource.slice(characterStart, characterEnd);
    assert.doesNotMatch(characterPanel, /Position X|Position Y|Depth|character-transform-grid/);

    const persistStart = characterEnd;
    const persistEnd = poseStudioSource.indexOf("\n    currentCameraParams()", persistStart);
    const persistMethod = poseStudioSource.slice(persistStart, persistEnd);
    assert.match(persistMethod, /x:\s*this\.exportParams\.cam_offset_x/);
    assert.match(persistMethod, /y:\s*this\.exportParams\.cam_offset_y/);
    assert.match(persistMethod, /zoom:\s*this\.exportParams\.cam_zoom/);

    const radarStart = poseStudioSource.indexOf("createCameraRadar(section)");
    const radarEnd = poseStudioSource.indexOf("\n    createLightRadar", radarStart);
    const radarMethod = poseStudioSource.slice(radarStart, radarEnd);
    const yUpdate = radarMethod.indexOf("this.exportParams.cam_offset_y = -normY * rangeY");
    const selectedCharacterUpdate = radarMethod.indexOf("this.persistActivePoseCameraParams()", yUpdate);
    assert.ok(yUpdate >= 0 && selectedCharacterUpdate > yUpdate);
});


test("character removal uses the Pose Studio modal instead of browser confirm", () => {
    const renderStart = poseStudioSource.indexOf("\n    renderCharactersUI() {");
    const confirmStart = poseStudioSource.indexOf("\n    showCharacterRemoveConfirm(character) {", renderStart);
    const renderMethod = poseStudioSource.slice(renderStart, confirmStart);
    assert.doesNotMatch(renderMethod, /window\.confirm/);
    assert.match(renderMethod, /this\.showCharacterRemoveConfirm\(active\)/);
    assert.match(renderMethod, /toolbar\.className = "vnccs-ps-character-toolbar"/);
    assert.match(renderMethod, /colorField\.className = "vnccs-ps-character-color-control"/);
    assert.match(renderMethod, /remove\.className = "vnccs-ps-character-remove"/);
    assert.doesNotMatch(renderMethod, /nameInput|character-name-row|textContent = "\+ Add"/);
    assert.match(
        renderMethod,
        /const charactersBySlot = new Map\(this\.characters\.map\(character => \[character\.slot, character\]\)\)/,
    );
    assert.match(
        renderMethod,
        /button\.classList\.add\("empty"\)[\s\S]*button\.addEventListener\("click", \(\) => this\.addCharacter\(index\)\)/,
    );

    const confirmEnd = poseStudioSource.indexOf("\n    persistActivePoseCameraParams()", confirmStart);
    const confirmMethod = poseStudioSource.slice(confirmStart, confirmEnd);
    assert.match(confirmMethod, /overlay\.className = "vnccs-ps-modal-overlay"/);
    assert.match(confirmMethod, /modal\.className = "vnccs-ps-modal vnccs-ps-character-remove-modal"/);
    assert.match(confirmMethod, /this\.deleteCharacter\(characterId\)/);
    assert.match(confirmMethod, /titleText\.textContent = `Remove Character \$\{characterNumber\}\?`/);
    assert.match(confirmMethod, /actions\.append\(cancelBtn, removeBtn\)/);
    assert.match(confirmMethod, /requestAnimationFrame\(\(\) => cancelBtn\.focus\(\)\)/);
    assert.match(confirmMethod, /event\.key === "Escape"/);
    assert.match(confirmMethod, /event\.key !== "Tab"/);
    assert.doesNotMatch(confirmMethod, /character\?\.name|innerHTML|window\.confirm|and its animation|🗑️|⚠️/);
    assert.match(poseStudioSource, /\.vnccs-ps-character-remove-modal \{[\s\S]*width: min\(240px, calc\(100% - 24px\)\)/);
    assert.match(poseStudioSource, /\.vnccs-ps-character-remove-actions \{[\s\S]*grid-template-columns: 1fr 1fr/);
});


test("save-to-library modal scales with the widget and keeps actions accessible", () => {
    assert.match(
        poseStudioSource,
        /\.vnccs-ps-save-library-modal \{[\s\S]*--vnccs-ps-save-scale: clamp\(0\.72, var\(--vnccs-ps-relative-ui-scale\), 1\.15\)/,
    );
    assert.match(
        poseStudioSource,
        /\.vnccs-ps-save-library-modal \{[\s\S]*width: min\(calc\(380px \* var\(--vnccs-ps-save-scale\)\), calc\(100% - 24px\)\)/,
    );
    assert.match(
        poseStudioSource,
        /\.vnccs-ps-save-library-modal \{[\s\S]*max-height: calc\(100% - 24px\)/,
    );
    assert.match(
        poseStudioSource,
        /\.vnccs-ps-save-library-modal \.vnccs-ps-modal-content \{[\s\S]*overflow-y: auto/,
    );
    assert.match(
        poseStudioSource,
        /\.vnccs-ps-save-library-actions \{[\s\S]*grid-template-columns: 1fr 1fr/,
    );
    assert.doesNotMatch(
        poseStudioSource,
        /\.vnccs-ps-save-library-modal \{[\s\S]{0,160}width: min\(680px/,
    );

    const saveStart = poseStudioSource.indexOf("showSaveToLibraryModal() {");
    const saveEnd = poseStudioSource.indexOf("\n    async saveLibraryPoseRecord", saveStart);
    const saveMethod = poseStudioSource.slice(saveStart, saveEnd);
    assert.match(saveMethod, /modal\.setAttribute\('aria-modal', 'true'\)/);
    assert.match(saveMethod, /class="vnccs-ps-save-library-actions"/);
    assert.match(saveMethod, /Name is required\./);
    assert.match(saveMethod, /saveButton\.disabled = true;[\s\S]*cancelButton\.disabled = true;/);
    assert.match(saveMethod, /event\.key === 'Escape'/);
    assert.match(saveMethod, /event\.key !== 'Tab'/);
    assert.match(saveMethod, /event\.key === 'Enter'/);
    assert.match(saveMethod, /requestAnimationFrame\(\(\) => nameInput\.focus\(\)\)/);
    assert.doesNotMatch(saveMethod, /💾|min-height: 72px|font-size: 22px/);
});


test("Pose Studio enforces four-character maximum and one-character minimum", () => {
    assert.match(
        poseCharactersSource,
        /export const MAX_POSE_STUDIO_CHARACTERS\s*=\s*4;/,
    );

    const addStart = poseStudioSource.indexOf("async addCharacter(requestedSlot = null)");
    const addEnd = poseStudioSource.indexOf("\n    async deleteCharacter", addStart);
    const addMethod = poseStudioSource.slice(addStart, addEnd);
    assert.match(
        addMethod,
        /this\.characters\.length\s*>=\s*MAX_POSE_STUDIO_CHARACTERS[\s\S]*return false;/,
    );
    assert.match(addMethod, /const slot = nextCharacterSlot\(this\.characters, requestedSlot\)/);
    assert.match(addMethod, /color: nextCharacterColor\(this\.characters, slot\)/);
    assert.match(addMethod, /this\.characters\.sort\(\(left, right\) => left\.slot - right\.slot\)/);

    const deleteStart = addEnd;
    const deleteEnd = poseStudioSource.indexOf("\n    async selectCharacter", deleteStart);
    const deleteMethod = poseStudioSource.slice(deleteStart, deleteEnd);
    assert.match(
        deleteMethod,
        /this\.characters\.length\s*<=\s*1[\s\S]*return false;/,
    );
});


test("Pose Studio sync persists the v3 multi-character scene schema", () => {
    const syncStart = poseStudioSource.indexOf("syncToNode(fullCapture = false, options = {})");
    const syncEnd = poseStudioSource.indexOf("\n    loadFromNode()", syncStart);
    const syncMethod = poseStudioSource.slice(syncStart, syncEnd);

    assert.match(syncMethod, /schema_version:\s*3/);
    assert.match(syncMethod, /active_character_id:\s*this\.activeCharacterId/);
    assert.match(syncMethod, /characters:\s*serializedCharacters/);
    assert.match(syncMethod, /timeline:\s*\{\s*\.\.\.this\.sharedTimeline\s*\}/);
});


test("full capture updates every character for the current frame or pose before rendering", () => {
    const syncStart = poseStudioSource.indexOf("syncToNode(fullCapture = false, options = {})");
    const syncEnd = poseStudioSource.indexOf("\n    loadFromNode()", syncStart);
    const syncMethod = poseStudioSource.slice(syncStart, syncEnd);
    const fullCaptureStart = syncMethod.indexOf("if (fullCapture)");
    const activeCaptureStart = syncMethod.indexOf("// Capture only ACTIVE", fullCaptureStart);
    const fullCapturePath = syncMethod.slice(fullCaptureStart, activeCaptureStart);

    assert.match(
        fullCapturePath,
        /this\.updateCharacterScene\(animationMode\s*\?\s*\{\s*frame:\s*i\s*\}\s*:\s*\{\s*poseIndex:\s*i\s*\}\s*\)/,
    );
    const sceneUpdate = fullCapturePath.indexOf("this.updateCharacterScene(animationMode");
    const compositeCapture = fullCapturePath.indexOf(
        "this.setPoseCapture(i, this.viewer.capture",
        sceneUpdate,
    );
    assert.ok(
        sceneUpdate >= 0 && compositeCapture > sceneUpdate,
        "the complete character scene must be updated before its composite capture",
    );
});
