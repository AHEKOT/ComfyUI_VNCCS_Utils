import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const studio = fs.readFileSync(path.join(root, "web", "vnccs_3d_factory.js"), "utf8");
const viewer = fs.readFileSync(path.join(root, "web", "vnccs_3d_factory_viewer.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "web", "vnccs_3d_factory.css"), "utf8");
const planGeometry = fs.readFileSync(path.join(root, "web", "factory3d", "plan_geometry.mjs"), "utf8");

test("Factory widget registers the renamed node and persists opaque state", () => {
    assert.match(studio, /VNCCS_3DFactory/);
    assert.match(studio, /factory_data/);
    assert.match(studio, /scene_id/);
    assert.match(studio, /selected_object_id/);
    assert.match(studio, /scene_snapshot/);
    assert.match(studio, /source: this\.sourceAsset/);
    assert.match(studio, /FRONTEND_BUILD = "20260825\.26"/);
    assert.doesNotMatch(studio, /vnccs-i3s__brand/);
    assert.doesNotMatch(studio, /Image to Gaussian scene/);
    assert.match(studio, /<option value="524288">524K · Experimental<\/option>/);
    assert.match(studio, /<option value="1048576">1\.05M · Extreme<\/option>/);
    assert.match(studio, /Experimental 2× density/);
    assert.match(studio, /Extreme 4× density/);
    assert.match(studio, /widget\.type = "hidden"/);
    assert.doesNotMatch(studio, /widget\.type = "converted-widget"/);
    assert.match(studio, /widget\.callback\?\.\(value\)/);
    assert.match(studio, /ensureScene\(safeObject\(state\.scene_snapshot\)\)/);
    assert.match(studio, /_scheduleStateSave\(options\.final \? 0 : 160\)/);
    assert.match(studio, /this\._isRestoring = true;/);
});

test("Factory provides a native Gaussian object and scene library with HF repositories", () => {
    assert.match(studio, /> Model Library\n/);
    assert.doesNotMatch(studio, /Model Library Gallery/);
    assert.match(studio, /GAUSSIAN_LIBRARY_SCHEMA = "vnccs-3d-factory-library\/v1"/);
    assert.match(studio, /Rejected non-Gaussian library records/);
    assert.match(studio, /apiUrl\(item\.preview_url\)/);
    assert.match(studio, /vnccs-ps-library-modal/);
    assert.match(studio, /vnccs-ps-library-modal-header/);
    assert.match(studio, /vnccs-ps-library-toolbar/);
    assert.match(studio, /vnccs-ps-library-size-control/);
    assert.match(studio, /vnccs-ps-library-categories/);
    assert.match(studio, /vnccs-ps-library-modal-grid/);
    assert.match(studio, /vnccs-ps-library-inspector/);
    assert.match(studio, /vnccs-ps-library-settings/);
    assert.match(studio, /openLibrary\(\)/);
    assert.match(studio, /Save Current Asset/);
    assert.match(studio, /Selected model/);
    assert.match(studio, /Complete scene/);
    assert.match(studio, /openLibraryRepositories/);
    assert.match(studio, /libraryRepositoryPublish/);
    assert.match(studio, /libraryRepositoryRefresh/);
    assert.match(viewer, /captureObjectPreview/);
    assert.match(viewer, /captureSkydomePreview/);
    assert.match(studio, /this\.viewer\.captureSkydomePreview/);
    assert.match(viewer, /canonicalObjectPreviewCamera/);
    assert.match(viewer, /entry\.mesh\.position\.set\(0, 0, 0\)/);
    assert.match(viewer, /entry\.mesh\.quaternion\.identity\(\)/);
    assert.match(viewer, /if \(!selected\) value\.mesh\.parent\?\.remove\(value\.mesh\)/);
    assert.match(viewer, /await this\.spark\.update\(\{ scene: this\.scene, camera: this\.camera \}\)/);
    assert.match(studio, /openSaveLibraryModal\(preferredType = "", requestedObjectId = this\.selectedObjectId\)/);
    assert.match(studio, /captureObjectPreview\(selectedObjectId,/);
    assert.match(studio, /object_id: isObject \? selectedObjectId : ""/);
    assert.match(styles, /\.vnccs-i3s__library-launcher-wrap/);
    assert.match(styles, /--vnccs-ps-relative-ui-scale: 1/);
    assert.match(studio, /setProperty\("--vnccs-ps-relative-ui-scale", scaleValue\)/);
    assert.doesNotMatch(studio, /window\.(?:alert|confirm|prompt)/);
});

test("Factory keeps the viewport clear and exposes camera projections in the Cameras panel", () => {
    assert.doesNotMatch(studio, /vnccs-i3s__viewport-camera/);
    assert.doesNotMatch(styles, /vnccs-i3s__viewport-camera/);
    assert.doesNotMatch(studio, /data-camera-action=/);
    assert.doesNotMatch(studio, /data-camera-pan=/);
    assert.doesNotMatch(studio, /data-camera-orbit=/);
    assert.doesNotMatch(studio, /data-camera-vector=/);
    assert.doesNotMatch(studio, /vnccs-i3s__camera-distance-range/);
    assert.doesNotMatch(studio, /vnccs-i3s__camera-height-range/);
    assert.match(studio, /Wheel zoom speed/);
    assert.match(studio, /vnccs-i3s__camera-zoom-speed-range/);
    assert.match(studio, /View projection/);
    assert.match(studio, /data-camera-preset="perspective"/);
    assert.match(studio, /data-camera-preset="front"/);
    assert.match(studio, /data-camera-preset="right"/);
    assert.match(studio, /data-camera-preset="top"/);
    assert.match(studio, /_syncCameraPanelControls/);
    assert.match(studio, /this\.editorView\.view_mode === "plan"/);
    assert.match(viewer, /setZoomSensitivity\(value/);
    assert.match(viewer, /this\.dollyCamera\(\(-event\.deltaY \/ 100\) \* this\.zoomSensitivity/);
    assert.match(styles, /\.vnccs-i3s__camera-view-preset-grid/);
});

test("Factory exposes scenes, generation, transforms, and PLY export", () => {
    assert.match(studio, /Scene manager/);
    assert.match(studio, /confirmDeleteScene\(scene\)/);
    assert.match(studio, /skipSceneDeleteConfirmation/);
    assert.match(studio, /Don’t ask again for scene deletions during this session/);
    assert.match(studio, /ENDPOINTS\.scene\(sceneId\), \{ method: "DELETE" \}/);
    assert.match(styles, /\.vnccs-i3s__scene-card-actions/);
    assert.match(styles, /\.vnccs-i3s__delete-confirm-option/);
    assert.match(studio, /Generate object/);
    assert.match(viewer, /TransformControls/);
    assert.match(studio, /duplicateObject/);
    assert.match(studio, /Gaussian PLY/);
    assert.match(studio, /item\?\.urls\?\.export_ply/);
    assert.match(studio, /exportScene\(\)/);
    assert.match(studio, /download\(scene\.exports\.urls\.ply\)/);
});

test("Factory imports an existing Gaussian PLY into the scene and viewport", () => {
    assert.match(studio, />Import PLY</);
    assert.match(studio, /accept="\.ply,application\/octet-stream"/);
    assert.match(
        studio,
        /importObject: sceneId => `\$\{API_BASE\}\/scenes\/\$\{encodeURIComponent\(sceneId\)\}\/objects\/import`/,
    );
    const importMethod = studio.match(
        /async importPly\(file\) \{[\s\S]*?\n    \}\n\n    async _monitorJob/,
    );
    assert.ok(importMethod, "PLY import method not found");
    assert.match(importMethod[0], /form\.append\("ply", file/);
    assert.match(importMethod[0], /await this\._applyScene\(result\.scene, \{ preserveSource: true \}\)/);
    assert.match(importMethod[0], /this\._selectObject\(result\.object_id\)/);
    assert.match(importMethod[0], /this\.viewer\.fit\(result\.object_id\)/);
    assert.match(importMethod[0], /this\._scheduleScenePreview\(120\)/);
    assert.match(styles, /\.vnccs-i3s__ply-import/);
});

test("Factory provides persistent realtime lighting for Gaussian scenes", () => {
    assert.match(studio, /Scene lighting/);
    assert.match(studio, /data-preset="\$\{key\}"/);
    assert.match(studio, /day: Object\.freeze/);
    assert.match(studio, /off: Object\.freeze/);
    assert.match(studio, /night: Object\.freeze/);
    assert.match(studio, /dawn: Object\.freeze/);
    assert.match(studio, /sunset: Object\.freeze/);
    assert.match(studio, /lighting: \{ \.\.\.this\.lighting \}/);
    assert.match(studio, /lighting_settings: \{ \.\.\.this\.lighting \}/);
    assert.match(studio, /_bindLightingRadar/);
    assert.match(
        studio,
        /lightingClose: \$\("\.vnccs-i3s__lighting-panel \.vnccs-i3s__lighting-close"\)/,
    );
    assert.match(viewer, /createDirectionalLightingModifier/);
    assert.match(viewer, /modifier: lighting/);
    assert.match(viewer, /entry\.splat\.objectModifier = lightingModifier\.modifier/);
    assert.match(viewer, /entry\.splatBounds\.getCenter\(this\._lightingCenterScratch\)/);
    assert.match(viewer, /entry\.splatBounds\.getSize\(this\._lightingSizeScratch\)/);
    assert.match(
        viewer,
        /this\._lightColor\.r \* this\.lighting\.intensity \* LIGHTING_BASE_RESPONSE/,
    );
    assert.match(
        viewer,
        /this\._lightColor\.r \* this\.lighting\.intensity,/,
    );
    assert.match(
        viewer,
        /\$\{outputs\.gsplat\}\.center - \$\{inputs\.objectCenter\}[\s\S]*?\* \$\{inputs\.inverseHalfSize\}/,
    );
    assert.match(viewer, /vnccsObjectOffset \* inversesqrt/);
    assert.match(
        viewer,
        /dot\([\s\S]*?vnccsObjectOffset \* inversesqrt[\s\S]*?\$\{inputs\.lightSource\}/,
    );
    assert.match(viewer, /0\.56 \+ 0\.56 \* vnccsSourceFacing/);
    assert.match(viewer, /0\.12 \+ 0\.88 \* vnccsShapedLight/);
    assert.match(viewer, /\(vnccsLightResponse - 0\.65\)/);
    assert.doesNotMatch(viewer, /lightingEnvelope|_lightTint|backgroundGain/);
    assert.doesNotMatch(
        viewer,
        /vnccsViewNormal|vnccsNormalConfidence|vnccsLambert|vnccsNormalWeights|vnccsAxisResponse/,
    );
    assert.doesNotMatch(
        viewer,
        /vnccsLightField|_updateLightingBounds|_installLightingShader|material\.vertexShader/,
    );
    const demandRender = viewer.match(
        /_renderFrame\(time\) \{[\s\S]*?\n    \}\n\n    _attachDirectionalLighting/,
    );
    assert.ok(demandRender, "viewer demand-render loop not found");
    assert.doesNotMatch(
        demandRender[0],
        /this\._syncDirectionalLighting|_updateLightingUniforms/,
    );
    assert.doesNotMatch(viewer, /_animate\(\)/);
    assert.match(viewer, /this\.spark\.onDirty = \(\) => this\.invalidate\(\)/);
    assert.match(viewer, /new IntersectionObserver/);
    assert.match(viewer, /document\.visibilityState !== "hidden"/);
    assert.match(viewer, /setLighting\(value = \{\}\)/);
    assert.match(viewer, /for \(const entry of this\.objects\.values\(\)\)/);
    assert.match(studio, /Occlusion shadows/);
    assert.match(studio, /Active shadow-casting point lights/);
    assert.match(studio, /vnccs-i3s__local-light-add/);
    assert.match(studio, /this\.lighting\.lights\.push\(\{/);
    assert.match(studio, /kind: "point"/);
    assert.match(studio, /const lights = this\.lighting\?\.lights \|\| \[\]/);
    assert.match(studio, /fragment\.appendChild\(this\._createLightCard\(light\)\)/);
    assert.match(studio, /Scene object · editor sphere is excluded from camera exports/);
    assert.match(viewer, /new THREE\.PointLight\(data\.color, data\.intensity, data\.distance\)/);
    assert.match(viewer, /this\.lightHelperRoot/);
    assert.match(styles, /\.vnccs-i3s__lighting-panel/);
});

test("Architecture shadows use closed geometry without hidden full-wall shadow casters", () => {
    assert.match(planGeometry, /shadowSide: data\.kind === "glass" \? THREE\.DoubleSide : THREE\.BackSide/);
    assert.doesNotMatch(planGeometry, /shadowSeal|factoryShadowSeal|WALL_SHADOW_SEAL/);
    assert.match(planGeometry, /mesh\.castShadow = true/);
    assert.match(planGeometry, /mesh\.receiveShadow = true/);
    assert.match(viewer, /Math\.max\(configuredNormalBias, DEFAULT_LIGHTING\.shadows\.normal_bias\)/);
    assert.doesNotMatch(viewer, /Math\.max\(configuredNormalBias, 0\.006\)/);
});

test("Factory provides a persistent equirectangular skydome with professional controls", () => {
    assert.match(studio, /ENDPOINTS\.skydome\(this\.sceneId\)/);
    assert.match(studio, /title="Skydome"/);
    assert.match(studio, /Equirectangular environment background/);
    assert.match(studio, /Horizontal rotation/);
    assert.match(studio, /Horizon tilt/);
    assert.match(studio, /Horizon roll/);
    assert.match(studio, /Background blur/);
    assert.match(studio, /Level horizon/);
    assert.match(studio, /Reset alignment/);
    assert.match(studio, /asset_type: assetType/);
    assert.match(studio, /<option value="skydome"/);
    assert.match(studio, /selected_skydome: this\.selectedSkydome/);
    assert.match(studio, /vnccs-i3s__skydome-object/);
    assert.match(viewer, /THREE\.EquirectangularReflectionMapping/);
    assert.match(viewer, /scene\.backgroundRotation/);
    assert.match(viewer, /scene\.backgroundIntensity = 2 \*\* this\.skydome\.exposure/);
    assert.match(viewer, /scene\.backgroundBlurriness = this\.skydome\.blur/);
    assert.match(viewer, /hasVisibleSkydome/);
    assert.match(styles, /\.vnccs-i3s__skydome-panel/);
});

test("Scene objects provide layer-style grouping, visibility, rename, and drag/drop", () => {
    assert.match(studio, /Shift-click to select multiple/);
    assert.match(studio, /groupSelectedObjects/);
    assert.match(studio, /selectedObjectIds = new Set/);
    assert.match(studio, /event\.shiftKey/);
    assert.match(studio, /card\.draggable = true/);
    assert.match(studio, /dragstart/);
    assert.match(studio, /drop-before/);
    assert.match(studio, /drop-after/);
    assert.match(studio, /drop-inside/);
    assert.match(studio, /_beginInlineRename/);
    assert.match(studio, /Double-click to rename/);
    assert.match(studio, /Show object/);
    assert.match(studio, /Hide object/);
    assert.match(studio, /Show group/);
    assert.match(studio, /Hide group/);
    assert.match(studio, /this\.viewer\.setGroupVisibility\(/);
    assert.match(viewer, /setGroupVisibility\(/);
    assert.match(studio, /Ungroup objects/);
    assert.match(styles, /\.vnccs-i3s__group-card/);
    assert.match(styles, /\.vnccs-i3s__inline-name/);
    assert.match(styles, /\.vnccs-i3s__object\.is-hidden/);
});

test("Replacing a reference always derives a fresh bounded object name from its filename", () => {
    const helperSource = studio.match(
        /(function objectNameFromFileName\(value\) \{[\s\S]*?\n\})\n\nfunction sleep/,
    );
    assert.ok(helperSource, "objectNameFromFileName helper not found");
    const parseName = Function(`${helperSource[1]}; return objectNameFromFileName;`)();
    assert.equal(parseName("second.reference.PNG"), "second.reference");
    assert.equal(parseName("new%20asset.webp"), "new asset");
    assert.equal(parseName(".png"), "Object");
    assert.equal(parseName(`${"a".repeat(90)}.jpg`).length, 80);

    const acceptSource = studio.match(
        /async _acceptSource\(file\) \{[\s\S]*?\n    \}\n\n    async _fetchJSON/,
    );
    assert.ok(acceptSource, "_acceptSource method not found");
    assert.match(acceptSource[0], /this\.settings\.name = objectNameFromFileName\(file\.name\)/);
    assert.match(acceptSource[0], /this\.els\.objectName\.value = this\.settings\.name/);
    assert.doesNotMatch(acceptSource[0], /if \(!this\.settings\.name\)/);
});

test("Selection no longer rebuilds layer cards before a double-click can rename them", () => {
    const selection = studio.match(
        /_selectObject\(objectId,[\s\S]*?\n    _syncSelectionControls\(\)/,
    );
    assert.ok(selection, "selection methods not found");
    assert.match(selection[0], /_syncSelectionPresentation\(\)/);
    assert.doesNotMatch(selection[0], /_renderObjects\(\)/);
    assert.match(studio, /name\.addEventListener\("dblclick", beginRename\)/);
    assert.match(studio, /if \(card\) card\.draggable = false/);
    assert.match(styles, /grid-template-columns: 36px minmax\(0,1fr\) auto/);
    assert.match(styles, /\.vnccs-i3s__object-actions \{ grid-column: auto/);
});

test("Scene updates reuse loaded splats and group transforms fan out to every object", () => {
    assert.match(studio, /this\.viewer\.setScene\(scene, \{ incremental \}\)/);
    assert.match(viewer, /async setScene\(sceneData, \{ incremental = false \} = \{\}\)/);
    assert.match(viewer, /if \(!incremental\) \{/);
    assert.match(viewer, /existing\?\.assetPath === assetPath/);
    assert.match(viewer, /this\.objects\.delete\(objectId\)/);
    assert.match(viewer, /selectGroup\(groupId, objectIds = \[\]\)/);
    assert.match(viewer, /_beginGroupTransform/);
    assert.match(viewer, /_applyGroupTransform/);
    assert.match(viewer, /group_id: this\.selectedGroupId/);
});

test("TripoSplat setup separates models, inference, and persisted SPLAT cache settings", () => {
    assert.match(studio, /vnccs-i3s__setup-block--models/);
    assert.match(studio, /vnccs-i3s__setup-block--settings/);
    assert.match(studio, /vnccs-i3s__setup-block--cache/);
    assert.match(studio, /Conditioning resolution/);
    assert.match(studio, /1024 × 1024/);
    assert.match(studio, /1536 × 1536/);
    assert.match(studio, /2048 × 2048/);
    assert.match(studio, /Do not upscale smaller sources/);
    assert.match(studio, /conditioning_resolution: 1024/);
    assert.match(studio, /prevent_upscale: false/);
    assert.match(studio, /splat_cache_limit_gb: 32/);
    assert.doesNotMatch(studio, /Object and scene export/);
    assert.doesNotMatch(studio, /vnccs-triposplat-export-format/);
    assert.match(studio, /SPLAT cache/);
    assert.match(studio, /Clear cache/);
    assert.match(studio, /ENDPOINTS\.splatCacheSettings/);
    assert.match(studio, /ENDPOINTS\.splatCacheClear/);
    assert.match(studio, /this\.settings\.splat_cache_limit_gb = draft\.splat_cache_limit_gb/);
    assert.doesNotMatch(studio, /No API, CLI, or external inference server/);
    assert.match(studio, /form\.append\("prevent_upscale", this\.settings\.prevent_upscale \? "1" : "0"\)/);
    assert.match(studio, /this\.settings\.prevent_upscale \? "native cap" : ""/);
    assert.match(styles, /\.vnccs-i3s__setup-grid/);
    assert.match(styles, /\.vnccs-i3s__setup-block--cache/);
    assert.match(styles, /\.vnccs-i3s__cache-limit-controls/);
    assert.match(styles, /\.vnccs-i3s__resolution-option:has\(input:checked\)/);
    assert.doesNotMatch(styles, /\.vnccs-i3s__format-option/);
});

test("Generation exposes background removal and UniCanvas-style seed mode without mask erosion", () => {
    assert.match(studio, /remove_background: true/);
    assert.match(studio, /Remove background/);
    assert.match(studio, /vnccs-i3s__remove-background/);
    assert.match(studio, /form\.append\("remove_background", this\.settings\.remove_background \? "1" : "0"\)/);
    assert.doesNotMatch(studio, /Mask erosion/);
    assert.doesNotMatch(studio, /vnccs-i3s__erosion/);
    assert.match(studio, /seed_mode: "randomize"/);
    assert.match(studio, /vnccs-i3s__seed-row/);
    assert.match(studio, /vnccs-i3s__seed-dice/);
    assert.match(studio, /this\.settings\.seed_mode === "randomize"/);
    assert.match(styles, /\.vnccs-i3s__seed-dice\.active/);
});

test("Factory reuses the UniCanvas support banner in the lower-left panel", () => {
    assert.match(studio, /assets\/VNCCS_Donate_Button\.png/);
    assert.match(studio, /https:\/\/www\.buymeacoffee\.com\/MIUProject/);
    assert.match(studio, /vnccs-i3s__donate-link/);
    assert.match(studio, /this\._listen\(this\.els\.donateLink, "pointerdown", event => event\.stopPropagation\(\)\)/);
    assert.match(styles, /\.vnccs-i3s__donate-link \{[^}]*margin-top: auto/);
});

test("Middle-button graph navigation is forwarded from UI but not the 3D viewport", () => {
    assert.match(studio, /event\.button !== 1/);
    assert.match(studio, /forwardMouse\("mousedown", event, 4\)/);
    assert.match(studio, /forwardMouse\("mousemove", event, event\.buttons \|\| 4\)/);
    assert.match(studio, /forwardMouse\("mouseup", event, 0\)/);
    assert.match(studio, /"pointerdown"/);
    assert.match(studio, /\.vnccs-i3s__viewer-host/);
    assert.match(studio, /root\.addEventListener\("wheel", forwardWheelFromInterface, \{ capture: true, passive: false \}\)/);
    assert.match(studio, /root\.removeEventListener\("mousedown", startPan, true\)/);
});

test("Factory production code contains no retired LLM integrations", () => {
    for (const retired of ["codex_cli", "claude_api", "azure_openai", "local_gguf", "llama_cpp"]) {
        assert.equal(studio.toLowerCase().includes(retired), false, retired);
    }
});

test("Viewer uses true splats, transform controls, adaptive clipping, and no floor mesh", () => {
    assert.match(viewer, /SplatMesh/);
    assert.match(viewer, /SparkRenderer/);
    assert.match(viewer, /fileType: "splat"/);
    assert.match(viewer, /fileBytes/);
    assert.match(viewer, /const createMesh = \(\) =>/);
    assert.match(viewer, /lod: false/);
    assert.doesNotMatch(viewer, /lod: usesLod \? "quality" : false/);
    assert.doesNotMatch(viewer, /nonLod: usesLod/);
    assert.match(viewer, /raycastable: false/);
    assert.match(viewer, /editable: false/);
    assert.doesNotMatch(viewer, /startPendingLodUpgrades|_pendingLodCandidates/);
    assert.doesNotMatch(viewer, /fileBytes\.slice\(0\)/);
    assert.match(viewer, /_waitForRenderable/);
    assert.match(studio, /Loading generated object/);
    assert.match(studio, /generatedScene = safeObject\(job\.result\?\.scene\)/);
    assert.match(studio, /this\.els\.cancelJob\.disabled = !visible \|\| !this\.currentJobId \|\| value >= 100/);
    assert.match(viewer, /prepareSplatBufferAsync/);
    assert.match(viewer, /await yieldToMainThread\(\)/);
    assert.doesNotMatch(viewer, /lodSplatCount:/);
    assert.match(viewer, /enabled: false,\s*builder: "none"/);
    assert.match(viewer, /lodRenderScale: 1,/);
    assert.match(viewer, /minSortIntervalMs: 32/);
    assert.match(studio, /viewportResult = await this\.viewer\.setScene/);
    assert.match(studio, /Viewport scene load incomplete/);
    assert.match(studio, /Viewport failed/);
    assert.match(styles, /\.vnccs-i3s__object\.has-viewport-error/);
    assert.match(styles, /Loading Gaussian scene/);
    assert.match(viewer, /_setInteractive\("orbit", true\)/);
    assert.match(viewer, /pixelBudget/);
    assert.doesNotMatch(viewer, /new SplatMesh\(\{\s*url:/);
    assert.match(viewer, /TransformControls/);
    assert.match(viewer, /boundedObjectHit/);
    assert.match(viewer, /selectionBounds/);
    assert.match(viewer, /_updateClipPlanes/);
    assert.doesNotMatch(viewer, /PlaneGeometry/);
    assert.doesNotMatch(viewer, /intersectObjects\(meshes/);
});

test("Factory avoids background canvas churn and defers expensive convenience captures", () => {
    assert.doesNotMatch(studio, /setDirtyCanvas/);
    assert.doesNotMatch(studio, /app\.graph\?\.setDirtyCanvas/);
    assert.match(studio, /requestIdleCallback\(save, \{ timeout: 8000 \}\)/);
    assert.match(studio, /Math\.max\(1000, Number\(delay\) \|\| 0\)/);
    assert.match(studio, /automatic[\s\S]*?2_200_000/);
    assert.match(studio, /document\.createDocumentFragment\(\)/);
    assert.match(studio, /thumbnail\.loading = "lazy"/);
    assert.match(styles, /contain: layout paint style/);
});

test("Preview output is captured from the clean 3D viewport and persisted per scene", () => {
    assert.match(studio, /preview: sceneId =>/);
    assert.match(studio, /_scheduleScenePreview/);
    assert.match(studio, /this\.viewer\.capturePreview/);
    assert.match(studio, /form\.append\("image", blob, "scene-preview\.png"\)/);
    assert.match(studio, /form\.append\("revision", String\(savedScene\.revision\)\)/);
    assert.match(studio, /form\.append\("render_revision", String\(savedScene\.render_revision\)\)/);
    assert.match(studio, /vnccs_req_3d_factory_preview/);
    assert.match(studio, /_captureExecutionPreview/);
    assert.match(studio, /form\.append\("capture_token", captureToken\)/);
    assert.match(studio, /Execution preview completed/);
    assert.match(studio, /previewError: sceneId =>/);
    assert.match(viewer, /async capturePreview/);
    assert.match(studio, /width: this\.exportSettings\.width/);
    assert.match(studio, /height: this\.exportSettings\.height/);
    assert.match(viewer, /this\.captureCamera\.aspect = targetWidth \/ targetHeight/);
    assert.match(viewer, /this\.renderer\.setPixelRatio\(1\)/);
    assert.match(viewer, /this\.renderer\.setSize\(targetWidth, targetHeight, false\)/);
    assert.match(viewer, /target\.width = targetWidth/);
    assert.match(viewer, /target\.height = targetHeight/);
    assert.match(viewer, /this\.transformHelper\.visible = false/);
    assert.match(viewer, /this\.selectionBounds\.visible = false/);
    assert.match(viewer, /context\.drawImage\(this\.canvas/);
    assert.match(viewer, /this\.resize\(\)/);
    assert.doesNotMatch(viewer, /preserveDrawingBuffer:\s*true/);
    assert.doesNotMatch(viewer, /maxSide/);
});

test("Camera block provides graphical FPV control, one Cameras group, and LIST capture order", () => {
    const cameraBlock = studio.match(
        /<section class="vnccs-i3s__section vnccs-i3s__camera-section">[\s\S]*?<\/section>/,
    )?.[0] || "";
    assert.match(cameraBlock, />Camera</);
    assert.match(cameraBlock, /vnccs-i3s__camera-look/);
    assert.match(cameraBlock, /vnccs-i3s__camera-zoom-speed-range/);
    assert.match(cameraBlock, /vnccs-i3s__camera-view-presets/);
    assert.match(cameraBlock, /data-camera-preset="perspective"/);
    assert.match(cameraBlock, /data-camera-preset="top"/);
    assert.doesNotMatch(cameraBlock, /camera-roll|Roll camera|slider to roll/);
    assert.match(cameraBlock, />Add camera</);
    assert.match(cameraBlock, /<strong>Cameras<\/strong>/);
    assert.doesNotMatch(cameraBlock, /type="text"/);
    assert.doesNotMatch(cameraBlock, /type="number"/);
    const cameraControls = studio.match(
        /_bindCameraControls\(\) \{[\s\S]*?\n    \}\n\n    async addCamera/,
    )?.[0] || "";
    assert.match(cameraControls, /setPointerCapture\?\.\(event\.pointerId\)/);
    assert.match(cameraControls, /rotate\(\{ yaw: -deltaX \* 0\.18, pitch: -deltaY \* 0\.18 \}\)/);
    assert.doesNotMatch(cameraControls, /cameraRoll|roll\s*:/);
    assert.match(studio, /async addCamera\(\)/);
    assert.match(studio, /_selectCamera\(cameraId\)/);
    assert.match(studio, /_exitCameraView\(\{ restore = true \}/);
    assert.match(studio, /this\._cameraReturnState = this\._normalizeCameraState/);
    assert.match(studio, /cameras: this\._normalizeSceneCameras/);
    assert.match(viewer, /rotateCameraFPV/);
    assert.match(viewer, /this\.camera\.up\.copy\(worldUp\)/);
    assert.match(viewer, /this\.camera\.lookAt\(this\.controls\.target\)/);
    assert.doesNotMatch(viewer, /new THREE\.Euler\(pitchRadians, yawRadians, rollRadians/);
    assert.match(viewer, /cameraState = null/);
    assert.match(studio, /captureSet: sceneId =>/);
    assert.match(studio, /form\.append\("current", current, "current\.png"\)/);
    assert.match(studio, /for \(const camera of cameras\)/);
    assert.match(studio, /camera_\$\{camera\.camera_id\}/);
    assert.match(studio, /_saveExecutionCaptureSet\(captureToken\)/);
    assert.match(styles, /vnccs-i3s__camera-look-reticle/);
    assert.match(styles, /vnccs-i3s__camera-item\.is-selected/);
});

test("Exact saved-camera XYZ rotation round-trips through one quaternion order", async () => {
    const helpers = studio.match(
        /(function quaternionFromEulerDegrees[\s\S]*?function eulerDegreesFromQuaternion[\s\S]*?\n\})\n\n\nclass Factory3DWidget/,
    );
    assert.ok(helpers, "camera rotation helpers not found");
    const THREE = await import(pathToFileURL(path.join(root, "web", "vendor", "spark", "three.module.js")).href);
    const normalizePose = value => {
        const quaternion = new THREE.Quaternion().fromArray(value.quaternion || [0, 0, 0, 1]);
        if (quaternion.lengthSq() < 1e-12) quaternion.identity();
        quaternion.normalize();
        return { quaternion: quaternion.toArray() };
    };
    const rotationHelpers = Function(
        "normalizedCameraPose",
        `${helpers[1]}; return { quaternionFromEulerDegrees, eulerDegreesFromQuaternion };`,
    )(normalizePose);
    for (const rotation of [[17, -23, 41], [-32, 18, -11], [6.25, 54.5, 72.75]]) {
        const restored = rotationHelpers.eulerDegreesFromQuaternion(
            rotationHelpers.quaternionFromEulerDegrees(rotation),
        );
        for (let axis = 0; axis < 3; axis += 1) {
            assert.ok(Math.abs(restored[axis] - rotation[axis]) < 1e-9);
        }
    }
});

test("Scene export exposes persistent dimensions, aspect presets, and an exact camera frame", () => {
    assert.match(studio, /Aspect ratio/);
    assert.match(studio, /16:9 · Widescreen/);
    assert.match(studio, /class="vnccs-i3s__input vnccs-i3s__scene-width"/);
    assert.match(studio, /class="vnccs-i3s__input vnccs-i3s__scene-height"/);
    assert.match(studio, /Camera frame/);
    assert.match(studio, /Show the exact exported crop in the 3D editor/);
    assert.match(studio, /render: \{ \.\.\.this\.exportSettings \}/);
    assert.match(studio, /camera: camera \? \{ \.\.\.camera \} : undefined/);
    assert.match(studio, /render_settings: \{ \.\.\.this\.exportSettings \}/);
    assert.match(studio, /this\.viewer\?\.setCaptureSettings/);
    assert.match(viewer, /vnccs-i3s__camera-frame/);
    assert.match(viewer, /setCaptureSettings/);
    assert.match(viewer, /getCaptureSettings/);
    assert.match(viewer, /const limitingHalfFov/);
    assert.match(viewer, /this\.captureWidth \/ Math\.max\(1, this\.captureHeight\)/);
    assert.match(styles, /\.vnccs-i3s__camera-frame/);
    assert.match(styles, /\.vnccs-i3s__scene-render-settings/);
});

test("Interior cutaway is viewport-only and camera exports restore complete architecture", () => {
    assert.match(studio, /Interior cutaway \(viewport only\)/);
    assert.match(studio, /this\.editorView\.interior_cutaway\[key\]/);
    assert.match(studio, /this\.editorView\.interior_cutaway\?\.\[cutawayKey\]/);
    assert.match(viewer, /setInteriorCutaway\(enabled\)/);
    assert.match(viewer, /hideCeilings: this\.interiorCutaway/);
    assert.match(viewer, /const hiddenWallId = this\._nearestCutawayWallId\(\)/);
    assert.match(viewer, /filter\(hit => isObjectPickableInHierarchy\(hit\.object\)\)/);
    assert.match(viewer, /this\.lightHelperRoot\.visible = false/);
    assert.match(viewer, /this\.architecture\.setActiveLevel\(this\.activeLevelId, false, \{[\s\S]*?hideCeilings: false,[\s\S]*?hiddenWallId: ""/);
    assert.match(viewer, /this\._syncViewportCutaway\(true\)/);
});

test("Canvas gizmos and the Inspector provide coarse and precise transforms", () => {
    assert.doesNotMatch(studio, /vnccs-i3s__transform-panel/);
    assert.doesNotMatch(studio, /vnccs-i3s__selected-name/);
    assert.match(studio, /data-editor-path=/);
    assert.match(studio, /exact value/);
    assert.match(studio, /type="range" aria-label=/);
    assert.match(studio, /Rotation · degrees/);
    assert.match(studio, /step: 0\.01/);
    assert.match(studio, /Duplicate object/);
    assert.match(studio, /confirmDeleteObject\(item\.object_id\)/);
    assert.match(studio, /actions\.append\(visibility, exportObject, duplicate, remove\)/);
    assert.match(styles, /\.vnccs-i3s \[hidden\] \{ display: none !important; \}/);
    assert.match(studio, /W\/E\/R: move\/rotate\/scale/);
});

test("Factory keeps a responsive Sakura workspace with isolated side-panel tabs", () => {
    assert.match(styles, /--i3-pink: #ff8fa3/);
    assert.match(styles, /--i3-lavender: #b8a9e8/);
    assert.match(styles, /grid-template-columns: 280px minmax\(420px, 1fr\) 360px/);
    assert.match(styles, /grid-template-columns: 200px minmax\(290px, 1fr\) 220px/);
    assert.match(studio, /data-workspace-tab="generate"/);
    assert.match(studio, /data-workspace-tab="cameras"/);
    assert.match(studio, /data-workspace-tab="objects"/);
    assert.match(studio, /data-workspace-tab="inspector"/);
    assert.match(studio, /data-workspace-tab="export"/);
    assert.match(styles, /\.vnccs-i3s__workspace-panel/);
    assert.doesNotMatch(styles, /minmax\(205px, 23fr\)/);
    assert.match(studio, /vnccs-i3s__side--left/);
    assert.match(studio, /vnccs-i3s__center/);
    assert.match(studio, /vnccs-i3s__side--right/);
});

test("Plan mode exposes distinct, previewed building workflows and explicit snap controls", () => {
    assert.match(studio, /data-plan-tool="wall"/);
    assert.match(studio, /Draw connected wall segments/);
    assert.match(studio, /data-plan-tool="room"/);
    assert.match(studio, /Create a rectangular room from two corners/);
    assert.match(studio, /data-plan-tool="opening"/);
    assert.match(studio, /data-plan-tool="camera"/);
    assert.match(studio, /Opening type/);
    assert.match(studio, /Grid step · m/);
    assert.match(studio, /Major line every/);
    assert.match(studio, /Hold Alt to bypass snap/);
    assert.match(studio, /Hold Shift to force an orthogonal segment/);
    assert.match(studio, /Press and drag to draw a wall/);
    assert.match(studio, /Press and drag diagonally to draw a rectangular room/);
    assert.match(studio, /Press on a wall and drag to set the opening width/);
    assert.match(studio, /_queuePlanHover/);
    assert.match(studio, /phase === "start"/);
    assert.match(studio, /phase === "move"/);
    assert.match(studio, /phase !== "end"/);
    assert.match(studio, /if \(!gesture\.moved\)/);
    assert.match(studio, /Opening preview/);
    assert.match(studio, /Camera position set · move to aim/);
    assert.match(studio, /_fitOpeningOnWall/);
    assert.match(viewer, /snapPlanPoint: options\.snapPlanPoint/);
    assert.match(viewer, /setPlanDraft\(draft\)/);
    assert.match(viewer, /setPlanGrid\(value = \{\}\)/);
    assert.match(viewer, /setCameraMarkers\(cameras = \[\]\)/);
    assert.match(viewer, /onPlanGesture: options\.onPlanGesture/);
    assert.match(viewer, /phase: "start",[\s\S]*?type: "room"/);
    assert.match(viewer, /phase: "move",[\s\S]*?type: "room"/);
    assert.match(studio, /if \(phase === "move"\) \{[\s\S]*?_queueSelectedArchitecturePreview\(\{ persist: false \}\)/);
});

test("Editor workflows keep buildings optional and make levels, selection, floor drop, and camera exits explicit", () => {
    assert.doesNotMatch(studio, /\+ Building/);
    assert.doesNotMatch(studio, /vnccs-i3s__building-select/);
    assert.match(studio, /Move building/);
    assert.match(studio, /Delete building/);
    assert.match(studio, /No replacement Building will be created/);
    assert.doesNotMatch(studio, /_ensureBuilding|_createDefaultBuilding/);
    assert.match(studio, /_applyBuildingTransform/);
    assert.match(studio, /Assign camera to building/);
    assert.match(studio, /data-object-property="building_id"/);
    assert.match(studio, /data-camera-property="building_id"/);
    assert.match(studio, /data-light-path="building_id"/);
    assert.match(studio, /vnccs-i3s__camera-track-building/);
    assert.match(studio, /track\.building_id !== building\.building_id/);
    assert.match(studio, /active_building_id/);
    assert.match(studio, /vnccs-i3s__level-panel/);
    assert.match(studio, /Add level/);
    assert.match(studio, /\["wall", "room", "opening"\]\.includes\(this\.editorView\.plan_tool\)/);
    assert.match(studio, /this\.els\.levelPanel\.hidden = !architectureToolActive/);
    assert.match(viewer, /selectedBuildingIds/);
    assert.match(viewer, /this\.controls\.enableRotate = false/);
    assert.match(viewer, /dollyCamera\(/);
    assert.match(viewer, /rotateCameraFPV/);
    assert.match(studio, /Drop selection to the nearest surface \(End\)/);
    assert.match(studio, /this\._dropSelectionToSurface\(event\.shiftKey\)/);
    assert.match(viewer, /dropSelectionToSurface\(\{ individual = false \} = \{\}\)/);
    assert.match(studio, /Enter camera view/);
    assert.match(studio, /Exit camera view/);
    assert.match(studio, /Update from current view/);
    assert.match(studio, /Add camera as path point/);
    assert.match(studio, /Delete active camera path/);
    assert.match(studio, /Precise edits in 3D enter the saved camera non-destructively/);
    assert.match(studio, /selected_architecture: this\.selectedArchitecture/);
    assert.match(studio, /selected_camera_keyframe_id: this\.selectedCameraKeyframeId/);
    assert.match(studio, /this\._listen\(window, "keydown", event =>/);
    assert.match(studio, /event\.key === "Delete" \|\| event\.key === "Backspace"/);
    assert.match(studio, /\[data-inspector-action="delete"\]/);
    assert.match(studio, /if \(editing\) return/);
    assert.match(studio, /if \(key === "c"\) this\._copySelection\(\)/);
    assert.match(studio, /else void this\._pasteSelection\(\)/);
    assert.match(studio, /_selectPlanItems\(items = \[\]/);
    assert.match(viewer, /onPlanMarqueeSelection\(items/);
    assert.match(viewer, /_planItemsInBounds\(start, end\)/);
    assert.match(studio, /rooms: Array\.from\(rooms\.values\(\)\)/);
    assert.match(studio, /walls: Array\.from\(walls\.values\(\)\)/);
    assert.match(studio, /openings: Array\.from\(openings\.values\(\)\)/);
    assert.match(studio, /cameras,/);
    assert.match(studio, /lights,/);
    assert.match(studio, /for \(const source of clipboard\.rooms \|\| \[\]\)/);
    assert.match(studio, /wall_ids: \(source\.wall_ids \|\| \[\]\)\.map\(id => wallIds\.get\(id\) \|\| id\)/);
    assert.match(studio, /for \(const source of clipboard\.lights \|\| \[\]\)/);
});

test("Editor schema normalizes grid aliases, room perimeters, buildings, and non-overlapping openings", async () => {
    const schema = await import(
        `${pathToFileURL(path.join(root, "web", "factory3d", "editor_schema.mjs")).href}?test=${Date.now()}`
    );
    const view = schema.normalizedEditorView({
        plan_grid: { visible: false, step: 0.25, major_every: 8 },
        snap: { enabled: false, grid: 3, endpoints: false },
    }, "level-a");
    assert.deepEqual(view.plan_grid, { visible: false, step: 0.25, major_every: 8 });
    assert.equal(view.snap.enabled, false);
    assert.equal(view.snap.grid, 0.25);
    assert.equal(view.snap.endpoints, false);
    assert.equal(view.active_level_id, "level-a");
    assert.deepEqual(view.interior_cutaway, { plan: true, three_d: false });
    assert.deepEqual(
        schema.normalizedEditorView({ interior_cutaway: true }).interior_cutaway,
        { plan: true, three_d: true },
    );
    assert.equal(schema.normalizedEditorView({ active_building_id: "building-a" }).active_building_id, "building-a");
    assert.equal(schema.normalizedObjectEditorProperties({
        building_id: "building-a",
        light_transport: "transmissive",
        transmission: 0.42,
    }).building_id, "building-a");
    assert.equal(schema.normalizedObjectEditorProperties({
        building_id: "building-a",
        light_transport: "transmissive",
        transmission: 0.42,
    }).transmission, 0.42);

    const level = { level_id: "level-a" };
    const building = { building_id: "building-a", name: "House" };
    const walls = [
        { wall_id: "w1", building_id: "building-a", level_id: "level-a", start: [0, 0], end: [4, 0] },
        { wall_id: "w2", building_id: "building-a", level_id: "level-a", start: [4, 0], end: [4, 3] },
        { wall_id: "w3", building_id: "building-a", level_id: "level-a", start: [4, 3], end: [0, 3] },
        { wall_id: "w4", building_id: "building-a", level_id: "level-a", start: [0, 3], end: [0, 0] },
    ];
    const normalized = schema.normalizedArchitecture({
        buildings: [building],
        walls,
        rooms: [{
            room_id: "room-a",
            building_id: "building-a",
            level_id: "level-a",
            polygon: [[0, 0], [4, 0], [4, 3], [0, 3]],
            wall_ids: ["w1", "w2", "w3", "w4"],
        }],
        openings: [
            { opening_id: "o1", wall_id: "w1", offset: 0.5, width: 2 },
            { opening_id: "o2", wall_id: "w1", offset: 0.5, width: 2 },
        ],
    }, [level]);
    assert.equal(normalized.buildings[0].building_id, "building-a");
    assert.deepEqual(normalized.rooms[0].wall_ids, ["w1", "w2", "w3", "w4"]);
    assert.equal(normalized.openings.length, 2);
    const intervals = normalized.openings
        .map(opening => [opening.offset * 4 - opening.width / 2, opening.offset * 4 + opening.width / 2])
        .sort((left, right) => left[0] - right[0]);
    assert.ok(intervals[0][1] <= intervals[1][0] + 1e-9);

    const invalid = schema.normalizedArchitecture({
        buildings: [building],
        walls,
        rooms: [{
            room_id: "room-b",
            building_id: "building-a",
            level_id: "level-a",
            polygon: [[0, 0], [4, 0], [4, 3], [0, 3]],
            wall_ids: ["w1", "w1", "w3", "w4"],
        }],
    }, [level]);
    assert.deepEqual(invalid.rooms[0].wall_ids, []);
    const emptyArchitecture = schema.normalizedArchitecture({
        buildings: [], walls: [], rooms: [], openings: [], materials: [],
    }, [level]);
    assert.deepEqual(emptyArchitecture.buildings, []);
    const rootArchitecture = schema.normalizedArchitecture({
        buildings: [],
        walls: [{
            wall_id: "root-wall",
            building_id: "",
            level_id: "level-a",
            start: [0, 0],
            end: [2, 0],
        }],
        rooms: [],
        openings: [],
        materials: [],
    }, [level]);
    assert.deepEqual(rootArchitecture.buildings, []);
    assert.equal(rootArchitecture.walls[0].building_id, "");
    const rootRoomArchitecture = schema.normalizedArchitecture({
        buildings: [],
        walls: walls.map(wall => ({ ...wall, building_id: "" })),
        rooms: [{
            room_id: "root-room",
            building_id: "",
            level_id: "level-a",
            polygon: [[0, 0], [4, 0], [4, 3], [0, 3]],
            wall_ids: ["w1", "w2", "w3", "w4"],
        }],
        openings: [],
        materials: [],
    }, [level]);
    assert.deepEqual(rootRoomArchitecture.buildings, []);
    assert.deepEqual(rootRoomArchitecture.rooms[0].wall_ids, ["w1", "w2", "w3", "w4"]);
    assert.equal(rootRoomArchitecture.rooms[0].building_id, "");
});

test("Factory DOM widget follows node resize like Pose Studio", () => {
    assert.match(studio, /widget\.triggerDraw\?\.\(\)/);
    assert.match(studio, /function scheduleDOMWidgetWidth\(node\)/);
    assert.match(studio, /scheduleDOMWidgetWidth\(this\)/);
    assert.match(studio, /requestAnimationFrame\(\(\) => syncDOMWidgetWidth\(this\)\)/);
    assert.match(studio, /this\.onResize\?\.\(this\.size\)/);
    assert.match(styles, /\.vnccs-i3s \{[\s\S]*?min-width: 0;[\s\S]*?min-height: 0;/);
    assert.doesNotMatch(styles, /\.vnccs-i3s \{[\s\S]*?min-height: 610px;/);
});

test("Factory cache executes after createLayout without a leaked local root variable", () => {
    const cacheMethod = studio.match(/(_cache\(\) \{[\s\S]*?\n    \})\n\n    _listen/);
    assert.ok(cacheMethod, "_cache method not found");
    const cache = Function(`return ({${cacheMethod[1]}})._cache;`)();
    const container = {
        querySelector: selector => ({ selector }),
        querySelectorAll: selector => [
            { selector, index: 0 },
            { selector, index: 1 },
        ],
    };
    const widget = { container };
    assert.doesNotThrow(() => cache.call(widget));
    assert.equal("transformContent" in widget.els, false);
    assert.equal("selectedName" in widget.els, false);
});

test("Factory serializes settings, source, scene snapshot, selection, and viewer state", () => {
    const method = studio.match(/(serializeState\(\) \{[\s\S]*?\n    \})\n\n    _scheduleStateSave/);
    assert.ok(method, "serializeState method not found");
    const serialize = Function(`return ({${method[1].replace("STATE_VERSION", "17")}}).serializeState;`)();
    const snapshot = {
        name: "Remembered",
        objects: [{ object_id: "object-a" }, { object_id: "object-b" }],
        layers: [{
            type: "group",
            group_id: "group-a",
            name: "Group",
            visible: true,
            children: ["object-a", "object-b"],
        }],
    };
    const state = serialize.call({
        sceneId: "scene-a",
        selectedObjectId: "object-a",
        selectedObjectIds: new Set(["object-a", "object-b"]),
        selectedGroupId: "group-a",
        collapsedGroupIds: new Set(["group-a"]),
        settings: { steps: 37, seed: 12 },
        exportSettings: {
            width: 1920,
            height: 1080,
            aspect: "16:9",
            show_camera_frame: true,
        },
        selectedSkydome: false,
        selectedArchitecture: { type: "room", id: "room-a" },
        selectedArchitectureItems: new Map([["room:room-a", { type: "room", id: "room-a" }]]),
        selectedCameraId: "camera-a",
        selectedCameraIds: new Set(["camera-a"]),
        selectedLightId: "light-a",
        selectedCameraKeyframeId: "keyframe-a",
        activeCameraTrackId: "track-a",
        lighting: {
            shadows: { enabled: true, quality: "medium" },
            lights: [{ light_id: "light-a", kind: "point" }],
        },
        editorView: {
            view_mode: "plan",
            plan_tool: "room",
            interior_cutaway: { plan: true, three_d: false },
            plan_camera: { target: [0, 0], zoom: 24 },
        },
        viewerState: { mode: "rotate", zoom_sensitivity: 0.1 },
        viewer: {
            getState: () => ({
                mode: "scale",
                zoom_sensitivity: 0.08,
                plan_camera: { target: [4, 5], zoom: 32 },
                camera: { position: [1, 2, 3] },
            }),
        },
        scene: { objects: snapshot.objects },
        sourceAsset: { url: "/reference", name: "input.png" },
        _selectedArchitectureRefs: () => [{ type: "room", id: "room-a" }],
        _scenePayload: () => snapshot,
    });
    assert.equal(state.schema_version, 17);
    assert.equal(state.settings.steps, 37);
    assert.equal(state.selected_object_id, "object-a");
    assert.deepEqual(state.selected_object_ids, ["object-a", "object-b"]);
    assert.equal(state.selected_group_id, "group-a");
    assert.deepEqual(state.collapsed_group_ids, ["group-a"]);
    assert.deepEqual(state.scene_snapshot, snapshot);
    assert.equal(state.source.url, "/reference");
    assert.equal(state.viewer_state.mode, "scale");
    assert.equal(state.viewer_state.zoom_sensitivity, 0.08);
    assert.deepEqual(state.selected_architectures, [{ type: "room", id: "room-a" }]);
    assert.deepEqual(state.selected_camera_ids, ["camera-a"]);
    assert.equal(state.selected_light_id, "light-a");
    assert.equal(state.active_camera_track_id, "track-a");
    assert.equal(state.selected_camera_keyframe_id, "keyframe-a");
    assert.deepEqual(state.editor_view.interior_cutaway, { plan: true, three_d: false });
    assert.deepEqual(state.editor_view.plan_camera, { target: [4, 5], zoom: 32 });
    assert.equal(state.lighting_settings.lights[0].light_id, "light-a");
    assert.deepEqual(state.render_settings, {
        width: 1920,
        height: 1080,
        aspect: "16:9",
        show_camera_frame: true,
    });
});

test("Factory state widget stays hidden without changing its serializable widget type", () => {
    const source = studio.match(/function hideFactoryDataWidget\(node\) \{[\s\S]*?\n\}/);
    assert.ok(source, "hideFactoryDataWidget not found");
    const hide = Function(`${source[0]}; return hideFactoryDataWidget;`)();
    const widget = { name: "factory_data", element: { style: {} }, inputEl: { style: {} } };
    hide({ widgets: [widget] });
    assert.equal(widget.type, "hidden");
    assert.equal(widget.hidden, true);
    assert.deepEqual(widget.computeSize(), [0, -4]);
    assert.equal(widget.element.style.display, "none");
});

test("Configured nodes cancel blank initialization before restoring their saved scene", () => {
    const lifecycle = studio.match(
        /nodeType\.prototype\.onNodeCreated = function[\s\S]*?nodeType\.prototype\.onSerialize = function/,
    );
    assert.ok(lifecycle, "factory lifecycle hooks not found");
    assert.match(lifecycle[0], /_vnccsFactoryConfigured = false/);
    assert.match(lifecycle[0], /if \(this\._vnccsFactoryConfigured\) return/);
    assert.match(lifecycle[0], /_vnccsFactoryConfigured = true/);
    assert.match(lifecycle[0], /clearTimeout\(this\._vnccsFactoryInit\)/);
    assert.match(lifecycle[0], /\}, 400\)/);
    assert.match(lifecycle[0], /\}, 40\)/);
});

test("Plan marquee converts client coordinates into the scaled viewport host", async () => {
    const module = await import(
        `${pathToFileURL(path.join(root, "web", "vnccs_3d_factory_viewer.js")).href}?marquee=${Date.now()}`
    );
    const marqueeViewer = Object.create(module.Factory3DViewer.prototype);
    marqueeViewer.host = { clientWidth: 1600, clientHeight: 900 };
    marqueeViewer.canvas = {
        clientWidth: 1600,
        clientHeight: 900,
        getBoundingClientRect: () => ({ left: 300, top: 200, width: 800, height: 450 }),
    };
    marqueeViewer.planMarqueeElement = { hidden: true, style: {} };
    marqueeViewer._planMarquee = {
        originX: 500,
        originY: 300,
        currentX: 700,
        currentY: 450,
    };
    marqueeViewer._updatePlanMarqueeElement();
    assert.equal(marqueeViewer.planMarqueeElement.hidden, false);
    assert.deepEqual(marqueeViewer.planMarqueeElement.style, {
        left: "400px",
        top: "200px",
        width: "400px",
        height: "300px",
    });
});

test("Plan object drag moves selected Gaussian objects live while preserving height", async () => {
    const module = await import(
        `${pathToFileURL(path.join(root, "web", "vnccs_3d_factory_viewer.js")).href}?object-drag=${Date.now()}`
    );
    const viewer = Object.create(module.Factory3DViewer.prototype);
    const changes = [];
    const transforms = {
        "object-a": {
            position: [10, 2.5, 20],
            rotation: [0, 15, 0],
            scale: 1,
        },
        "object-b": {
            position: [14, 6, 25],
            rotation: [0, -20, 0],
            scale: 0.8,
        },
    };
    viewer.objects = new Map(Object.keys(transforms).map(objectId => [objectId, {
        data: { transform: transforms[objectId] },
        mesh: { objectId },
    }]));
    viewer._objectPlanDrag = {
        pointerId: 7,
        objectIds: ["object-a", "object-b"],
        originPoint: [1, 1],
        anchorPosition: [10, 20],
        previousTransforms: structuredClone(transforms),
        currentTransforms: structuredClone(transforms),
        originX: 100,
        originY: 100,
        moved: false,
        interactive: false,
    };
    viewer.selectedGroupId = "";
    viewer.screenToPlan = () => [3, 4];
    viewer.options = {
        snapPlanPoint: point => point,
        onTransformChange: (objectId, transform, options) => changes.push({
            objectId,
            transform: structuredClone(transform),
            options,
        }),
    };
    viewer._applyTransform = (mesh, transform) => { mesh.transform = structuredClone(transform); };
    viewer._refreshSelectionBounds = () => {};
    viewer._refreshObjectSelectionHighlights = () => {};
    viewer._setInteractive = () => {};
    viewer.spark = { setDirty() {} };
    viewer.invalidate = () => {};
    viewer.canvas = {
        style: {},
        releasePointerCapture() {},
    };

    viewer._updatePlanObjectDrag({ pointerId: 7, clientX: 120, clientY: 115 });
    assert.deepEqual(viewer.objects.get("object-a").data.transform.position, [12, 2.5, 23]);
    assert.deepEqual(viewer.objects.get("object-b").data.transform.position, [16, 6, 28]);
    assert.equal(changes.at(-1).options.final, false);

    viewer._finishPlanObjectDrag({ pointerId: 7, clientX: 120, clientY: 115 });
    assert.equal(viewer._objectPlanDrag, null);
    assert.equal(changes.at(-1).options.final, true);
    assert.equal(changes.at(-1).options.command_last, true);
    assert.deepEqual(changes.at(-1).options.previous_transforms, transforms);
});

test("Architecture runtime casts opaque closed geometry from back faces only", async () => {
    const geometryModule = await import(
        `${pathToFileURL(path.join(root, "web", "factory3d", "plan_geometry.mjs")).href}?shadow=${Date.now()}`
    );
    const THREE = await import(
        pathToFileURL(path.join(root, "web", "vendor", "spark", "three.module.js")).href
    );
    const materials = new geometryModule.FactoryMaterialRegistry();
    const wall = geometryModule.createWallObject(
        {
            wall_id: "wall-a",
            name: "Wall",
            start: [0, 0],
            end: [4, 0],
            thickness: 0.12,
            height: 2.8,
        },
        { elevation: 0, height: 2.8 },
        [],
        materials,
    );
    const wallMeshes = wall.children.filter(
        child => child.isMesh && child.userData?.factoryType === "wall",
    );
    assert.equal(wallMeshes.length, 1);
    assert.equal(wallMeshes[0].castShadow, true);
    assert.equal(wallMeshes[0].receiveShadow, true);
    for (const material of wallMeshes[0].material) {
        assert.equal(material.shadowSide, THREE.BackSide);
    }
    assert.equal(
        wall.children.some(child => child.userData?.factoryShadowSeal),
        false,
    );
    wall.traverse(child => child.geometry?.dispose?.());
    materials.dispose();
});

test("Factory viewer and every vendored Three/Spark dependency can actually import", async () => {
    const module = await import(
        `${pathToFileURL(path.join(root, "web", "vnccs_3d_factory_viewer.js")).href}?test=${Date.now()}`
    );
    const THREE = await import(pathToFileURL(path.join(root, "web", "vendor", "spark", "three.module.js")).href);
    const SPARK = await import(pathToFileURL(path.join(root, "web", "vendor", "spark", "spark.module.js")).href);
    const support = await import(
        `${pathToFileURL(path.join(root, "web", "factory3d", "support_solver.mjs")).href}?test=${Date.now()}`
    );
    assert.equal(typeof module.Factory3DViewer, "function");
    assert.equal(typeof module.boundedObjectHit, "function");
    assert.equal(typeof module.computeRobustSplatBounds, "function");
    assert.equal(typeof module.gaussianShadowProxyTransforms, "function");
    assert.equal(typeof module.isObjectPickableInHierarchy, "function");
    assert.equal(typeof module.canonicalObjectPreviewCamera, "function");
    assert.equal(typeof module.createDirectionalLightingModifier, "function");
    assert.equal(typeof module.effectiveVisibleObjectIds, "function");
    assert.equal(typeof module.lightSourceDirection, "function");
    assert.equal(typeof module.normalizedLighting, "function");
    assert.equal(typeof module.normalizedSkydome, "function");
    assert.equal(typeof module.triposplatCanonicalMatrix, "function");
    assert.equal(typeof module.validateSplatBuffer, "function");
    assert.equal(typeof module.prepareSplatBuffer, "function");
    assert.equal(typeof module.prepareSplatBufferAsync, "function");
    assert.equal(typeof support.solveDropToSurface, "function");
    assert.equal(module.FACTORY_VIEWER_BUILD, "20260825.16");
    const visiblePickRoot = new THREE.Group();
    const visiblePickMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    visiblePickRoot.add(visiblePickMesh);
    assert.equal(module.isObjectPickableInHierarchy(visiblePickMesh), true);
    visiblePickRoot.visible = false;
    assert.equal(module.isObjectPickableInHierarchy(visiblePickMesh), false);
    visiblePickRoot.visible = true;
    visiblePickRoot.userData.factoryPointerPassthrough = true;
    assert.equal(module.isObjectPickableInHierarchy(visiblePickMesh), false);
    visiblePickMesh.geometry.dispose();

    const shadowSplats = [];
    for (let index = 0; index < 96; index += 1) {
        shadowSplats.push({
            center: new THREE.Vector3((index % 12) / 11, Math.floor(index / 12) / 7, 0),
            scales: new THREE.Vector3(0.02, 0.03, 0.01),
            quaternion: new THREE.Quaternion(),
            opacity: index === 95 ? 0 : 1,
        });
    }
    const shadowTransforms = module.gaussianShadowProxyTransforms(
        {
            numSplats: shadowSplats.length,
            splats: { getSplat: index => shadowSplats[index] },
        },
        new THREE.Box3(new THREE.Vector3(0, 0, -0.1), new THREE.Vector3(1, 1, 0.1)),
        { maxInstances: 32 },
    );
    assert.equal(shadowTransforms.length, 32);
    assert.ok(shadowTransforms.every(item => item.position.isVector3));
    assert.ok(shadowTransforms.every(
        item => item.scale.x > 0 && item.scale.y > 0 && item.scale.z > 0,
    ));
    const shadowViewer = Object.create(module.Factory3DViewer.prototype);
    shadowViewer.lighting = { shadows: { enabled: true, quality: "medium" } };
    const shadowRoot = new THREE.Group();
    const shadowSplat = new THREE.Object3D();
    shadowSplat.numSplats = shadowSplats.length;
    shadowSplat.splats = { getSplat: index => shadowSplats[index] };
    shadowRoot.add(shadowSplat);
    const shadowEntry = {
        mesh: shadowRoot,
        splat: shadowSplat,
        splatBounds: new THREE.Box3(
            new THREE.Vector3(0, 0, -0.1),
            new THREE.Vector3(1, 1, 0.1),
        ),
        data: { light_transport: "opaque" },
    };
    shadowViewer._attachShadowProxy(shadowEntry);
    assert.equal(shadowEntry.shadowProxy.isInstancedMesh, true);
    assert.equal(shadowEntry.shadowProxy.geometry.type, "IcosahedronGeometry");
    assert.equal(shadowEntry.shadowProxy.castShadow, true);
    assert.equal(shadowEntry.shadowProxy.material.colorWrite, false);
    shadowViewer._disposeEntry(shadowEntry);
    const basementMesh = new THREE.Object3D();
    basementMesh.position.set(0, -2, 0);
    basementMesh.updateMatrixWorld(true);
    const basementDrop = support.solveDropToSurface({
        entries: new Map([["basement-object", {
            mesh: basementMesh,
            data: { collision_proxy: { mode: "auto_box" } },
            localBounds: new THREE.Box3(
                new THREE.Vector3(-0.5, -0.5, -0.5),
                new THREE.Vector3(0.5, 0.5, 0.5),
            ),
        }]]),
        selectedIds: ["basement-object"],
        floorElevations: [-3],
    });
    assert.ok(Math.abs(basementDrop.supportY + 3) < 1e-9);
    assert.ok(basementDrop.deltaY < 0);
    const fpvViewer = Object.create(module.Factory3DViewer.prototype);
    fpvViewer.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
    fpvViewer.camera.position.set(1, 2, 3);
    fpvViewer.controls = {
        target: new THREE.Vector3(1, 2, 2),
        update() {},
    };
    fpvViewer.camera.lookAt(fpvViewer.controls.target);
    fpvViewer.captureFov = 42;
    fpvViewer._disposed = false;
    fpvViewer.invalidate = () => {};
    fpvViewer.options = { onStateChange() {} };
    const fpvPosition = fpvViewer.camera.position.clone();
    for (const delta of [
        { yaw: 18, pitch: -7 },
        { yaw: -9, pitch: 4 },
        { yaw: 13, pitch: -3 },
        { yaw: -5, pitch: 6 },
    ]) {
        fpvViewer.rotateCameraFPV(delta, { emit: false });
    }
    assert.deepEqual(fpvViewer.camera.position.toArray(), fpvPosition.toArray());
    assert.ok(
        Math.abs(fpvViewer.camera.position.distanceTo(fpvViewer.controls.target) - 1) < 1e-9,
    );
    assert.deepEqual(fpvViewer.camera.up.toArray(), [0, 1, 0]);
    const fpvForward = fpvViewer.controls.target.clone()
        .sub(fpvViewer.camera.position)
        .normalize();
    const expectedScreenUp = new THREE.Vector3(0, 1, 0)
        .addScaledVector(fpvForward, -fpvForward.y)
        .normalize();
    const actualScreenUp = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(fpvViewer.camera.quaternion)
        .normalize();
    assert.ok(
        actualScreenUp.distanceTo(expectedScreenUp) < 1e-9,
        "yaw/pitch look input must not accumulate camera roll",
    );
    assert.deepEqual(fpvViewer.getCameraState().position, [1, 2, 3]);
    const modifierState = module.createDirectionalLightingModifier();
    assert.equal(typeof modifierState.modifier.apply, "function");
    assert.deepEqual(modifierState.objectCenter.value.toArray(), [0, 0, 0]);
    assert.deepEqual(modifierState.inverseHalfSize.value.toArray(), [1, 1, 1]);
    assert.deepEqual(modifierState.lightSource.value.toArray(), [0, 1, 0]);
    const modifierSplats = new SPARK.PackedSplats();
    modifierSplats.pushSplat(
        new THREE.Vector3(),
        new THREE.Vector3(1, 1, 1),
        new THREE.Quaternion(),
        1,
        new THREE.Color(),
    );
    const modifierMesh = new SPARK.SplatMesh({ packedSplats: modifierSplats });
    modifierMesh.objectModifier = modifierState.modifier;
    modifierMesh.constructGenerator(modifierMesh.context);
    const modifierProgram = modifierSplats.prepareProgramMaterial(modifierMesh.generator);
    assert.match(modifierProgram.program.shader, /vnccsSourceFacing/);
    modifierMesh.dispose();
    const backSource = module.lightSourceDirection(0, 0);
    const rightSource = module.lightSourceDirection(90, 0);
    const frontSource = module.lightSourceDirection(180, 0);
    const highSource = module.lightSourceDirection(0, 90);
    assert.ok(backSource.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6);
    assert.ok(rightSource.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6);
    assert.ok(frontSource.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-6);
    assert.ok(highSource.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6);
    assert.deepEqual(
        module.normalizedLighting({
            preset: "night",
            intensity: 1.4,
            color: "#8EAAFF",
            azimuth: -22,
            elevation: 24,
            ambient: 0.22,
            background: "#090D1A",
        }),
        {
            preset: "night",
            intensity: 1.4,
            color: "#8eaaff",
            azimuth: 338,
            elevation: 24,
            ambient: 0.22,
            background: "#090d1a",
            shadows: {
                enabled: true,
                quality: "medium",
                bias: -0.0002,
                normal_bias: 0.0015,
            },
            lights: [],
        },
    );
    const normalizedPointLight = module.normalizedLighting({
        shadows: { enabled: true, quality: "high", bias: -0.0002, normal_bias: 0.0015 },
        lights: [{
            light_id: "light-a",
            name: "Practical",
            kind: "point",
            position: [1, 2.4, 3],
            target: [1, 0, 3],
            color: "#FF0088",
            intensity: 10,
            distance: 8,
            cast_shadow: true,
            visible: true,
        }],
    });
    assert.equal(normalizedPointLight.shadows.quality, "high");
    assert.equal(normalizedPointLight.lights.length, 1);
    assert.equal(normalizedPointLight.lights[0].kind, "point");
    assert.equal(normalizedPointLight.lights[0].color, "#FF0088");
    assert.deepEqual(normalizedPointLight.lights[0].position, [1, 2.4, 3]);
    assert.deepEqual(
        module.normalizedSkydome({
            url: "/sky.jpg",
            yaw: 250,
            pitch: -120,
            roll: -220,
            exposure: 8,
            blur: 4,
        }),
        {
            url: "/sky.jpg",
            type: "skydome",
            projection: "equirectangular",
            visible: true,
            yaw: 180,
            pitch: -90,
            roll: -180,
            exposure: 4,
            blur: 1,
        },
    );
    assert.equal(module.validateSplatBuffer(new ArrayBuffer(64)).byteLength, 64);
    assert.throws(
        () => module.validateSplatBuffer(new ArrayBuffer(33)),
        /32 bytes per Gaussian/,
    );
    const splatBuffer = new ArrayBuffer(64);
    const splatView = new DataView(splatBuffer);
    for (let index = 0; index < 2; index += 1) {
        const offset = index * 32;
        splatView.setFloat32(offset, index, true);
        splatView.setFloat32(offset + 4, index + 1, true);
        splatView.setFloat32(offset + 8, index + 2, true);
        splatView.setFloat32(offset + 12, 0.1, true);
        splatView.setFloat32(offset + 16, 0.2, true);
        splatView.setFloat32(offset + 20, 0.3, true);
        splatView.setUint8(offset + 27, 255);
    }
    const prepared = module.prepareSplatBuffer(splatBuffer);
    assert.equal(prepared.buffer, splatBuffer);
    assert.deepEqual(prepared.diagnostics, {
        gaussians: 2,
        visible: 2,
        invalid: 0,
        repaired: false,
    });
    splatView.setFloat32(0, Number.NaN, true);
    const repaired = module.prepareSplatBuffer(splatBuffer);
    assert.notEqual(repaired.buffer, splatBuffer);
    assert.equal(repaired.diagnostics.invalid, 1);
    assert.equal(repaired.diagnostics.visible, 1);
    assert.equal(new DataView(repaired.buffer).getUint8(27), 0);
    const asyncRepaired = await module.prepareSplatBufferAsync(
        splatBuffer,
        "async SPLAT",
        { chunkRecords: 1024 },
    );
    assert.equal(asyncRepaired.diagnostics.invalid, 1);
    assert.equal(asyncRepaired.diagnostics.visible, 1);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
        module.prepareSplatBufferAsync(
            splatBuffer,
            "cancelled SPLAT",
            { signal: aborted.signal },
        ),
        error => error?.name === "AbortError",
    );
    const mesh = new THREE.Object3D();
    mesh.position.set(3, 0, 0);
    const entries = new Map([[
        "object-a",
        {
            mesh,
            localBounds: new THREE.Box3(
                new THREE.Vector3(-1, -1, -1),
                new THREE.Vector3(1, 1, 1),
            ),
        },
    ]]);
    const hit = module.boundedObjectHit(
        new THREE.Ray(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)),
        entries,
    );
    assert.equal(hit.objectId, "object-a");
    const canonicalPoint = new THREE.Vector3(1, 2, 3).applyMatrix4(
        module.triposplatCanonicalMatrix(),
    );
    assert.ok(
        canonicalPoint.distanceTo(new THREE.Vector3(3, -2, 1)) < 1e-6,
        `unexpected TripoSplat orientation: ${canonicalPoint.toArray()}`,
    );
    const previewBounds = new THREE.Box3(
        new THREE.Vector3(-3, -2, -0.75),
        new THREE.Vector3(1, 4, 1.25),
    );
    const previewState = module.canonicalObjectPreviewCamera(
        previewBounds,
        640,
        640,
        42,
    );
    assert.deepEqual(previewState.target.toArray(), [-1, 1, 0.25]);
    assert.equal(previewState.position.x, -1);
    assert.equal(previewState.position.y, 1);
    assert.ok(previewState.position.z > previewBounds.max.z);
    const previewCamera = new THREE.PerspectiveCamera(
        previewState.fov,
        1,
        previewState.near,
        previewState.far,
    );
    previewCamera.position.copy(previewState.position);
    previewCamera.up.copy(previewState.up);
    previewCamera.lookAt(previewState.target);
    previewCamera.updateProjectionMatrix();
    previewCamera.updateMatrixWorld(true);
    for (const x of [previewBounds.min.x, previewBounds.max.x]) {
        for (const y of [previewBounds.min.y, previewBounds.max.y]) {
            for (const z of [previewBounds.min.z, previewBounds.max.z]) {
                const projected = new THREE.Vector3(x, y, z).project(previewCamera);
                assert.ok(Math.abs(projected.x) < 1, `preview x was cropped: ${projected.x}`);
                assert.ok(Math.abs(projected.y) < 1, `preview y was cropped: ${projected.y}`);
            }
        }
    }
    const previewViewer = Object.create(module.Factory3DViewer.prototype);
    previewViewer.scene = new THREE.Scene();
    previewViewer.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
    previewViewer.camera.position.set(9, 8, 7);
    previewViewer.controls = {
        target: new THREE.Vector3(1, 2, 3),
        update() {},
    };
    previewViewer.captureFov = 42;
    previewViewer._capturing = false;
    previewViewer._suppressStateEvents = false;
    previewViewer._refreshSelectionBounds = () => {};
    previewViewer.renderer = { render() {} };
    previewViewer.options = { onError(error) { throw error; } };
    const makePreviewEntry = (id, x) => {
        const rootObject = new THREE.Group();
        rootObject.userData.factoryObjectId = id;
        rootObject.position.set(x, x + 1, x + 2);
        rootObject.rotation.set(0.1 * x, 0.2 * x, 0.3 * x);
        rootObject.scale.setScalar(x + 1);
        const splat = new THREE.Object3D();
        rootObject.add(splat);
        previewViewer.scene.add(rootObject);
        return {
            mesh: rootObject,
            splat,
            localBounds: new THREE.Box3(
                new THREE.Vector3(-1, -2, -0.5),
                new THREE.Vector3(1, 2, 0.5),
            ),
        };
    };
    const firstPreviewEntry = makePreviewEntry("first", 1);
    const selectedPreviewEntry = makePreviewEntry("selected-second", 4);
    previewViewer.objects = new Map([
        ["first", firstPreviewEntry],
        ["selected-second", selectedPreviewEntry],
    ]);
    const mappingSnapshots = [];
    previewViewer.spark = {
        setDirty() {},
        async update({ scene }) {
            mappingSnapshots.push(
                scene.children
                    .map(child => child.userData?.factoryObjectId)
                    .filter(Boolean),
            );
        },
    };
    previewViewer.invalidate = () => {};
    previewViewer.skydome = { visible: false };
    previewViewer.skydomeTexture = {};
    previewViewer._applySkydomeSettings = () => {};
    selectedPreviewEntry.mesh.visible = false;
    selectedPreviewEntry.splat.visible = false;
    let skydomeCaptureIds = null;
    let skydomeWasVisible = false;
    previewViewer.capturePreview = async () => {
        skydomeCaptureIds = previewViewer.scene.children
            .map(child => child.userData?.factoryObjectId)
            .filter(Boolean);
        skydomeWasVisible = previewViewer.skydome.visible;
        return "skydome-preview";
    };
    const skydomePreview = await previewViewer.captureSkydomePreview();
    assert.equal(skydomePreview, "skydome-preview");
    assert.deepEqual(skydomeCaptureIds, []);
    assert.equal(skydomeWasVisible, true);
    assert.equal(previewViewer.skydome.visible, false);
    assert.equal(firstPreviewEntry.mesh.parent, previewViewer.scene);
    assert.equal(selectedPreviewEntry.mesh.parent, previewViewer.scene);
    assert.equal(firstPreviewEntry.mesh.visible, true);
    assert.equal(selectedPreviewEntry.mesh.visible, false);
    assert.equal(selectedPreviewEntry.splat.visible, false);
    mappingSnapshots.length = 0;

    let capturedIds = [];
    let capturedTransform = null;
    previewViewer.capturePreview = async () => {
        capturedIds = previewViewer.scene.children
            .map(child => child.userData?.factoryObjectId)
            .filter(Boolean);
        capturedTransform = {
            position: selectedPreviewEntry.mesh.position.toArray(),
            scale: selectedPreviewEntry.mesh.scale.toArray(),
        };
        return "preview";
    };
    const result = await previewViewer.captureObjectPreview("selected-second");
    assert.equal(result, "preview");
    assert.deepEqual(mappingSnapshots[0], ["selected-second"]);
    assert.deepEqual(capturedIds, ["selected-second"]);
    assert.deepEqual(capturedTransform.position, [0, 0, 0]);
    assert.deepEqual(capturedTransform.scale, [1, 1, 1]);
    assert.equal(firstPreviewEntry.mesh.parent, previewViewer.scene);
    assert.equal(selectedPreviewEntry.mesh.parent, previewViewer.scene);
    assert.deepEqual(selectedPreviewEntry.mesh.position.toArray(), [4, 5, 6]);
    assert.deepEqual(selectedPreviewEntry.mesh.scale.toArray(), [5, 5, 5]);
    assert.deepEqual(mappingSnapshots.at(-1), ["first", "selected-second"]);

    const frameViewer = Object.create(module.Factory3DViewer.prototype);
    frameViewer.host = { clientWidth: 1600, clientHeight: 900 };
    frameViewer.camera = new THREE.PerspectiveCamera();
    frameViewer.captureWidth = 1080;
    frameViewer.captureHeight = 1920;
    frameViewer.captureFov = 42;
    frameViewer.cameraFrameVisible = true;
    frameViewer.cameraFrame = { style: {} };
    frameViewer.cameraFrameLabel = { textContent: "" };
    frameViewer._updateCameraProjection(1600, 900);
    frameViewer._updateCameraFrame(1600, 900);
    const portraitWidth = Number.parseFloat(frameViewer.cameraFrame.style.width);
    const portraitHeight = Number.parseFloat(frameViewer.cameraFrame.style.height);
    const portraitLeft = Number.parseFloat(frameViewer.cameraFrame.style.left);
    const portraitTop = Number.parseFloat(frameViewer.cameraFrame.style.top);
    assert.ok(frameViewer.camera.fov > 42);
    assert.ok(portraitLeft >= 18);
    assert.ok(portraitTop >= 18);
    assert.ok(portraitLeft + portraitWidth <= 1600 - 18);
    assert.ok(portraitTop + portraitHeight <= 900 - 18);
    assert.ok(Math.abs(portraitWidth / portraitHeight - 1080 / 1920) < 1e-9);
    assert.ok(Math.abs(
        Math.tan(THREE.MathUtils.degToRad(21))
            / Math.tan(THREE.MathUtils.degToRad(frameViewer.camera.fov * 0.5))
            - portraitHeight / 900,
    ) < 1e-9);
    assert.equal(frameViewer.cameraFrameLabel.textContent, "1080 × 1920");

    frameViewer.captureWidth = 1920;
    frameViewer.captureHeight = 1080;
    frameViewer._updateCameraProjection(900, 1600);
    frameViewer._updateCameraFrame(900, 1600);
    const landscapeWidth = Number.parseFloat(frameViewer.cameraFrame.style.width);
    const landscapeHeight = Number.parseFloat(frameViewer.cameraFrame.style.height);
    const landscapeLeft = Number.parseFloat(frameViewer.cameraFrame.style.left);
    const landscapeTop = Number.parseFloat(frameViewer.cameraFrame.style.top);
    assert.ok(frameViewer.camera.fov > 42);
    assert.ok(landscapeLeft >= 18);
    assert.ok(landscapeTop >= 18);
    assert.ok(landscapeLeft + landscapeWidth <= 900 - 18);
    assert.ok(landscapeTop + landscapeHeight <= 1600 - 18);
    assert.ok(Math.abs(landscapeWidth / landscapeHeight - 1920 / 1080) < 1e-9);
    assert.ok(Math.abs(
        Math.tan(THREE.MathUtils.degToRad(21))
            / Math.tan(THREE.MathUtils.degToRad(frameViewer.camera.fov * 0.5))
            - landscapeHeight / 1600,
    ) < 1e-9);

    frameViewer.captureWidth = 1024;
    frameViewer.captureHeight = 1024;
    const squareLayout = frameViewer._cameraFrameLayout(1024, 1024);
    assert.equal(squareLayout.safeInset, 56);
    assert.equal(squareLayout.left, 56);
    assert.equal(squareLayout.top, 56);
    assert.equal(squareLayout.width, 912);
    assert.equal(squareLayout.height, 912);

    // ComfyUI graph zoom changes the screen-space bounding rect but not the
    // frame's local containing-block coordinates. The frame must stay centered
    // in the complete local viewport.
    let renderedSize = null;
    frameViewer._disposed = false;
    frameViewer.captureWidth = 1024;
    frameViewer.captureHeight = 439;
    frameViewer.host = {
        clientWidth: 1600,
        clientHeight: 900,
        getBoundingClientRect: () => ({ width: 800, height: 450 }),
    };
    frameViewer.renderer = {
        setSize: (width, height, updateStyle) => {
            renderedSize = [width, height, updateStyle];
        },
    };
    frameViewer.resize();
    assert.deepEqual(renderedSize, [1600, 900, false]);
    const zoomedFrameWidth = Number.parseFloat(frameViewer.cameraFrame.style.width);
    const zoomedFrameHeight = Number.parseFloat(frameViewer.cameraFrame.style.height);
    const zoomedFrameLeft = Number.parseFloat(frameViewer.cameraFrame.style.left);
    const zoomedFrameTop = Number.parseFloat(frameViewer.cameraFrame.style.top);
    assert.ok(Math.abs(zoomedFrameLeft + zoomedFrameWidth * 0.5 - 800) < 1e-9);
    assert.ok(Math.abs(zoomedFrameTop + zoomedFrameHeight * 0.5 - 450) < 1e-9);
    assert.ok(Math.abs(zoomedFrameWidth / zoomedFrameHeight - 1024 / 439) < 1e-9);

    const splats = [];
    for (let index = 0; index < 1000; index += 1) {
        const t = index / 999;
        splats.push({
            center: new THREE.Vector3(t * 2 - 1, Math.sin(index) * 0.5, Math.cos(index) * 0.25),
            opacity: 1,
        });
    }
    splats.push(
        { center: new THREE.Vector3(500, 500, 500), opacity: 1 },
        { center: new THREE.Vector3(-900, -900, -900), opacity: 0.0001 },
    );
    const robustBounds = module.computeRobustSplatBounds({
        numSplats: splats.length,
        forEachSplat: callback => splats.forEach((splat, index) => callback(
            index,
            splat.center,
            new THREE.Vector3(10000, 10000, 10000),
            new THREE.Quaternion(),
            splat.opacity,
            new THREE.Color(),
        )),
        getBoundingBox: () => {
            throw new Error("fallback should not be used");
        },
    });
    assert.ok(robustBounds.min.x > -2, `unexpected min x: ${robustBounds.min.x}`);
    assert.ok(robustBounds.max.x < 2, `unexpected max x: ${robustBounds.max.x}`);
    assert.ok(robustBounds.max.y < 2, `unexpected max y: ${robustBounds.max.y}`);

    const visibility = module.effectiveVisibleObjectIds({
        objects: [
            { object_id: "object-a", visible: true },
            { object_id: "object-b", visible: true },
            { object_id: "object-c", visible: false },
            { object_id: "object-d", visible: true, building_id: "building-hidden" },
        ],
        architecture: {
            buildings: [{ building_id: "building-hidden", visible: false }],
        },
        layers: [
            {
                type: "group",
                group_id: "group-a",
                visible: false,
                children: ["object-a"],
            },
            { type: "object", object_id: "object-b" },
            { type: "object", object_id: "object-c" },
            { type: "object", object_id: "object-d" },
        ],
    });
    assert.deepEqual(Array.from(visibility), ["object-b"]);

    const groupLayer = {
        type: "group",
        group_id: "group-visibility",
        visible: true,
        children: ["visible-child", "hidden-child"],
    };
    const visibleChild = new THREE.Object3D();
    const hiddenChild = new THREE.Object3D();
    let detachCount = 0;
    let configureCount = 0;
    const visibilityViewer = Object.create(module.Factory3DViewer.prototype);
    visibilityViewer.sceneData = {
        objects: [
            { object_id: "visible-child", visible: true },
            { object_id: "hidden-child", visible: false },
        ],
        layers: [groupLayer],
    };
    visibilityViewer.objects = new Map([
        ["visible-child", { mesh: visibleChild }],
        ["hidden-child", { mesh: hiddenChild }],
    ]);
    visibilityViewer.selectedGroupId = groupLayer.group_id;
    visibilityViewer.transform = { detach: () => { detachCount += 1; } };
    visibilityViewer.selectionBounds = {
        visible: true,
        box: new THREE.Box3(),
    };
    visibilityViewer._configureGroupPivot = () => { configureCount += 1; };
    visibilityViewer.spark = { setDirty() {} };
    visibilityViewer.setGroupVisibility(
        groupLayer.group_id,
        groupLayer.children,
        false,
        visibilityViewer.sceneData,
    );
    assert.equal(groupLayer.visible, false);
    assert.equal(visibleChild.visible, false);
    assert.equal(hiddenChild.visible, false);
    assert.equal(visibilityViewer.selectionBounds.visible, false);
    assert.equal(detachCount, 1);
    visibilityViewer.setGroupVisibility(
        groupLayer.group_id,
        groupLayer.children,
        true,
        visibilityViewer.sceneData,
    );
    assert.equal(groupLayer.visible, true);
    assert.equal(visibleChild.visible, true);
    assert.equal(hiddenChild.visible, false);
    assert.equal(configureCount, 1);

    const groupEvents = [];
    const left = new THREE.Object3D();
    const right = new THREE.Object3D();
    left.position.set(-1, 0, 0);
    right.position.set(1, 0, 0);
    left.updateMatrixWorld(true);
    right.updateMatrixWorld(true);
    const groupViewer = Object.create(module.Factory3DViewer.prototype);
    groupViewer.selectedGroupId = "group-a";
    groupViewer.selectedGroupObjectIds = ["left", "right"];
    groupViewer.objects = new Map([
        ["left", { mesh: left, data: { transform: {} } }],
        ["right", { mesh: right, data: { transform: {} } }],
    ]);
    groupViewer.groupPivot = new THREE.Object3D();
    groupViewer._groupTransformStart = null;
    groupViewer._suppressTransform = false;
    groupViewer.options = {
        onTransformChange: (objectId, transform, options) => {
            groupEvents.push({ objectId, transform, options });
        },
    };
    groupViewer.spark = { setDirty() {} };
    groupViewer.selectionBounds = {
        visible: false,
        box: new THREE.Box3(),
        updateMatrixWorld() {},
    };
    groupViewer._refreshSelectionBounds = () => {};
    groupViewer._beginGroupTransform();
    groupViewer.groupPivot.position.set(3, 2, 1);
    groupViewer.groupPivot.scale.setScalar(2);
    groupViewer.groupPivot.updateMatrixWorld(true);
    groupViewer._applyGroupTransform(true);
    assert.deepEqual(left.position.toArray(), [1, 2, 1]);
    assert.deepEqual(right.position.toArray(), [5, 2, 1]);
    assert.equal(left.scale.x, 2);
    assert.equal(right.scale.x, 2);
    assert.deepEqual(groupEvents.map(item => item.objectId), ["left", "right"]);
    assert.ok(groupEvents.every(item => item.options.final && item.options.group_id === "group-a"));
});
