import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const poseStudioSource = await readFile(
    new URL("../web/vnccs_pose_studio.js", import.meta.url),
    "utf8",
);
const poseStudioCoreSource = await readFile(
    new URL("../web/vnccs_pose_studio_core.js", import.meta.url),
    "utf8",
);


const methodSource = (source, signature, nextSignature) => {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `missing method: ${signature}`);
    const end = source.indexOf(nextSignature, start + signature.length);
    assert.notEqual(end, -1, `missing boundary after: ${signature}`);
    return source.slice(start, end);
};


test("scene animation cache stores all character clips in one compact bundle", () => {
    const buildMethod = methodSource(
        poseStudioSource,
        "buildSceneAnimationCachePayload()",
        "\n    sceneAnimationCacheSnapshot()",
    );
    assert.match(buildMethod, /const primary = characters\[0\] \|\| this\.getActiveCharacter\(\)/);
    assert.match(buildMethod, /serializeAnimationStateSnapshot\(character\.animationState\)/);
    assert.match(
        buildMethod,
        /characterAnimations:\s*characters\.slice\(1\)\.map\(character => \(\{[\s\S]*id:\s*character\.id,[\s\S]*animation:\s*snapshotFor\(character\)/,
    );
    assert.match(buildMethod, /this\.stripSceneCameraFromPose\(snapshot\.basePose\)/);

    const syncMethod = methodSource(
        poseStudioSource,
        "syncToNode(fullCapture = false, options = {})",
        "\n    loadFromNode()",
    );
    assert.match(syncMethod, /const animationSnapshot = this\.sceneAnimationCacheSnapshot\(\)/);
    assert.match(
        syncMethod,
        /serialized\.animation\s*=\s*\{[\s\S]*\.\.\.createAnimationCacheReference\(character\.animationState,[\s\S]*cacheId:\s*animationToSave\.cacheId,[\s\S]*revision:\s*animationToSave\.revision,[\s\S]*characterId:\s*character\.id/,
    );
});


test("scene animation cache restores each clip by stable character id", () => {
    const restoreMethod = methodSource(
        poseStudioSource,
        "async restoreAnimationFromCache(reference, fallbackPose = {})",
        "\n    resetAnimationHistory()",
    );
    assert.match(
        restoreMethod,
        /new Map\([\s\S]*\.map\(entry => \[String\(entry\.id\), entry\.animation\]\)/,
    );
    assert.match(restoreMethod, /for \(const character of this\.characters \|\| \[\]\)/);
    assert.match(
        restoreMethod,
        /String\(character\.id\) === String\(cachedAnimation\.primaryCharacterId\)[\s\S]*nestedAnimations\.get\(String\(character\.id\)\)/,
    );
    assert.match(restoreMethod, /character\.animationState = state/);
    assert.match(restoreMethod, /this\.retimeAllCharacterAnimations\(this\.sharedTimeline\)/);
});


test("character model swaps keep a stable scene camera target", () => {
    const loadDataMethod = methodSource(
        poseStudioCoreSource,
        "loadData(data, keepCamera = false)",
        "\n    _cleanupPrevious()",
    );
    assert.match(
        loadDataMethod,
        /this\.meshCenter = center\.clone\(\);\s*if \(!this\.sceneCameraTarget\) this\.sceneCameraTarget = center\.clone\(\);/,
    );

    const captureCameraMethod = methodSource(
        poseStudioCoreSource,
        "updateCaptureCamera(width, height, zoom = 1.0, offsetX = 0, offsetY = 0, yawDeg = 0, pitchDeg = 0)",
        "\n    snapToCaptureCamera",
    );
    assert.match(
        captureCameraMethod,
        /const baseTarget = this\.sceneCameraTarget \|\| this\.meshCenter \|\|/,
    );

    const hydrateMethod = methodSource(
        poseStudioSource,
        "hydrateCharacterSceneModels({ showOverlay = true, recenterViewport = true } = {})",
        "\n    setCharactersBusy",
    );
    const targetReset = hydrateMethod.indexOf("this.viewer?.resetSceneCameraTarget?.()");
    const firstModelLoad = hydrateMethod.indexOf("await this.loadModel(false, false, { updateScene: false })");
    const characterLoop = hydrateMethod.indexOf("for (const character of [...this.characters])");
    assert.ok(targetReset >= 0 && targetReset < firstModelLoad);
    assert.ok(firstModelLoad >= 0 && firstModelLoad < characterLoop);
    assert.equal(
        (hydrateMethod.match(/resetSceneCameraTarget/g) || []).length,
        1,
        "the shared camera target is reset once per complete scene hydration",
    );
});


test("setPose restores shaped bone positions before applying rotations", () => {
    const setPoseMethod = methodSource(
        poseStudioCoreSource,
        "setPose(pose, preserveCamera = false)",
        "\n    resetPose()",
    );
    const resetLoop = setPoseMethod.indexOf("for (const b of this.boneList)");
    const rotationLoop = setPoseMethod.indexOf("for (const [bName, rot] of Object.entries(bones))");
    assert.ok(resetLoop >= 0 && rotationLoop > resetLoop);
    const resetBlock = setPoseMethod.slice(resetLoop, rotationLoop);
    assert.match(resetBlock, /const shapedRest = this\.shapedBoneRestPositions\?\.\[b\.name\]/);
    assert.match(resetBlock, /const initialRest = this\.initialBoneStates\?\.\[b\.name\]\?\.position/);
    assert.match(resetBlock, /if \(shapedRest\) b\.position\.copy\(shapedRest\)/);
    assert.match(resetBlock, /else if \(initialRest\) b\.position\.copy\(initialRest\)/);
});


test("live body morph recalculates skin bind data in neutral character space", () => {
    const morphMethod = methodSource(
        poseStudioCoreSource,
        "updateBodyVertices(",
        "\n    _initSkeleton",
    );
    assert.match(morphMethod, /savedMeshPosition = this\.skinnedMesh\.position\.clone\(\)/);
    assert.match(morphMethod, /savedMeshScale = this\.skinnedMesh\.scale\.clone\(\)/);

    const neutralPosition = morphMethod.indexOf("this.skinnedMesh.position.set(0, 0, 0)");
    const neutralScale = morphMethod.indexOf("this.skinnedMesh.scale.set(1, 1, 1)");
    const recalculateBind = morphMethod.indexOf("this.skeleton.calculateInverses()", neutralScale);
    const restorePosition = morphMethod.indexOf("this.skinnedMesh.position.copy(savedMeshPosition)", recalculateBind);
    const restoreScale = morphMethod.indexOf("this.skinnedMesh.scale.copy(savedMeshScale)", recalculateBind);
    const refreshWorld = morphMethod.indexOf("this.skinnedMesh.updateMatrixWorld(true)", restoreScale);

    assert.ok(neutralPosition >= 0 && neutralScale > neutralPosition);
    assert.ok(recalculateBind > neutralScale);
    assert.ok(restorePosition > recalculateBind && restoreScale > recalculateBind);
    assert.ok(refreshWorld > restoreScale);
});


test("scene hydration visits every rig and capture waits for all readiness barriers", () => {
    const hydrateMethod = methodSource(
        poseStudioSource,
        "hydrateCharacterSceneModels({ showOverlay = true, recenterViewport = true } = {})",
        "\n    setCharactersBusy",
    );
    assert.match(hydrateMethod, /if \(this\._viewerInitPromise\) await this\._viewerInitPromise/);
    assert.match(
        hydrateMethod,
        /for \(const character of \[\.\.\.this\.characters\]\) \{[\s\S]*if \(character\.id === preferredActiveId\) continue;[\s\S]*await this\.selectCharacter\(character\.id, \{ sync: false, rebuildScene: false \}\)/,
    );
    assert.match(
        hydrateMethod,
        /if \(this\.activeCharacterId !== preferredActiveId\) \{[\s\S]*await this\.selectCharacter\(preferredActiveId, \{ sync: false, rebuildScene: false \}\)/,
    );
    assert.match(hydrateMethod, /await this\.viewer\?\.waitForCaptureReady\?\.\(\)/);

    const readyMethod = methodSource(
        poseStudioSource,
        "async awaitReadyForCompositeCapture(timeoutMs = 120000)",
        "\n    async selectCharacter",
    );
    assert.match(readyMethod, /const hydration = this\._sceneModelHydrationPromise;[\s\S]*await hydration/);
    assert.match(readyMethod, /const modelLoad = this\._modelLoadPromise;[\s\S]*await modelLoad/);
    assert.match(readyMethod, /this\._animationCacheRestorePromise/);
    assert.match(readyMethod, /await this\.waitForMorphIdle/);
    assert.match(readyMethod, /await this\.viewer\?\.waitForCaptureReady\?\.\(\)/);

    const syncRequestStart = poseStudioSource.indexOf('api.addEventListener("vnccs_req_pose_sync"');
    const syncRequestEnd = poseStudioSource.indexOf(
        '\n        api.addEventListener("vnccs_apply_sam3d_pose"',
        syncRequestStart,
    );
    const syncRequest = poseStudioSource.slice(syncRequestStart, syncRequestEnd);
    const readyWait = syncRequest.indexOf("await waitForPoseStudioSyncIdle(node.studioWidget)");
    const fullCapture = syncRequest.indexOf("node.studioWidget.syncToNode(true", readyWait);
    assert.ok(readyWait >= 0 && fullCapture > readyWait);
});


test("model loads reject stale character and mesh results", () => {
    const loadMethod = methodSource(
        poseStudioSource,
        "loadModel(showOverlay = true, recenterViewport = true)",
        "\n    isLiveMorphKey",
    );
    assert.match(loadMethod, /const requestKey = `\$\{requestedCharacterId\}\\u0000\$\{requestedMeshSignature\}`/);
    assert.match(loadMethod, /if \(this\._modelLoadKey === requestKey\) return this\._modelLoadPromise/);
    assert.match(loadMethod, /this\._modelLoadPromise\.catch\(\(\) => false\)\.then/);
    assert.match(loadMethod, /if \(currentKey !== requestKey\) return false/);
    assert.match(loadMethod, /if \(this\._modelLoadPromise === promise\)/);
});
