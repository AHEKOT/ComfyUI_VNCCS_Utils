import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const studio = fs.readFileSync(path.join(root, "web", "vnccs_3d_factory.js"), "utf8");
const viewer = fs.readFileSync(path.join(root, "web", "vnccs_3d_factory_viewer.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "web", "vnccs_3d_factory.css"), "utf8");

test("Factory widget registers the renamed node and persists opaque state", () => {
    assert.match(studio, /VNCCS_3DFactory/);
    assert.match(studio, /factory_data/);
    assert.match(studio, /scene_id/);
    assert.match(studio, /selected_object_id/);
    assert.match(studio, /scene_snapshot/);
    assert.match(studio, /source: this\.sourceAsset/);
    assert.match(studio, /FRONTEND_BUILD = "20260724\.13"/);
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

test("Factory exposes scenes, generation, transform, and both export formats", () => {
    assert.match(studio, /Scene manager/);
    assert.match(studio, /Generate object/);
    assert.match(viewer, /TransformControls/);
    assert.match(studio, /duplicateObject/);
    assert.match(studio, /Scene PLY/);
    assert.match(studio, /Scene SPLAT/);
});

test("TripoSplat setup separates model management from persisted conditioning settings", () => {
    assert.match(studio, /vnccs-i3s__setup-block--models/);
    assert.match(studio, /vnccs-i3s__setup-block--settings/);
    assert.match(studio, /Conditioning resolution/);
    assert.match(studio, /1024 × 1024/);
    assert.match(studio, /1536 × 1536/);
    assert.match(studio, /2048 × 2048/);
    assert.match(studio, /Do not upscale smaller sources/);
    assert.match(studio, /conditioning_resolution: 1024/);
    assert.match(studio, /prevent_upscale: false/);
    assert.doesNotMatch(studio, /No API, CLI, or external inference server/);
    assert.match(studio, /form\.append\("prevent_upscale", this\.settings\.prevent_upscale \? "1" : "0"\)/);
    assert.match(studio, /this\.settings\.prevent_upscale \? "native cap" : ""/);
    assert.match(styles, /\.vnccs-i3s__setup-grid/);
    assert.match(styles, /\.vnccs-i3s__resolution-option:has\(input:checked\)/);
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
    assert.match(viewer, /const createMesh = lod =>/);
    assert.match(viewer, /lod: lod \? "quality" : false/);
    assert.match(viewer, /full-splat-visible; quality-lod-queued/);
    assert.match(viewer, /Quality LOD unavailable; keeping full SPLAT/);
    assert.match(viewer, /for \(const candidate of lodCandidates\) this\._queueLodUpgrade\(candidate\)/);
    assert.match(studio, /Loading generated object/);
    assert.match(studio, /generatedScene = safeObject\(job\.result\?\.scene\)/);
    assert.match(studio, /this\.els\.cancelJob\.disabled = !visible \|\| !this\.currentJobId \|\| value >= 100/);
    assert.match(viewer, /prepareSplatBuffer/);
    assert.doesNotMatch(viewer, /lodSplatCount:/);
    assert.match(viewer, /builder: "quality"/);
    assert.match(viewer, /aggregateBudget: "platform-adaptive"/);
    assert.match(viewer, /allocation: "screen-space"/);
    assert.match(viewer, /lodRenderScale: 1\.25/);
    assert.match(studio, /const viewportResult = await this\.viewer\.setScene/);
    assert.match(studio, /Viewport scene load incomplete/);
    assert.match(studio, /Viewport failed/);
    assert.match(styles, /\.vnccs-i3s__object\.has-viewport-error/);
    assert.match(styles, /Loading Gaussian scene/);
    assert.match(viewer, /_setInteractive\("orbit", true\)/);
    assert.match(viewer, /Math\.min\(this\._nativePixelRatio, 1\)/);
    assert.doesNotMatch(viewer, /new SplatMesh\(\{\s*url:/);
    assert.match(viewer, /TransformControls/);
    assert.match(viewer, /boundedObjectHit/);
    assert.match(viewer, /selectionBounds/);
    assert.match(viewer, /_updateClipPlanes/);
    assert.doesNotMatch(viewer, /PlaneGeometry/);
});

test("Preview output is captured from the clean 3D viewport and persisted per scene", () => {
    assert.match(studio, /preview: sceneId =>/);
    assert.match(studio, /_scheduleScenePreview/);
    assert.match(studio, /this\.viewer\.capturePreview/);
    assert.match(studio, /form\.append\("image", blob, "scene-preview\.png"\)/);
    assert.match(viewer, /async capturePreview/);
    assert.match(viewer, /this\.transformHelper\.visible = false/);
    assert.match(viewer, /this\.selectionBounds\.visible = false/);
    assert.match(viewer, /context\.drawImage\(this\.canvas/);
    assert.doesNotMatch(viewer, /preserveDrawingBuffer:\s*true/);
});

test("Canvas transforms are the only transform UI and object actions live on cards", () => {
    assert.doesNotMatch(studio, /vnccs-i3s__transform-panel/);
    assert.doesNotMatch(studio, /Precise values/);
    assert.doesNotMatch(studio, /vnccs-i3s__selected-name/);
    assert.match(studio, /Duplicate object/);
    assert.match(studio, /confirmDeleteObject\(item\.object_id\)/);
    assert.match(studio, /actions\.append\(ply, splat, duplicate, remove\)/);
    assert.match(styles, /\.vnccs-i3s \[hidden\] \{ display: none !important; \}/);
    assert.match(studio, /W\/E\/R: move\/rotate\/scale/);
});

test("Factory preserves the accepted Sakura three-column Studio interface", () => {
    assert.match(styles, /--i3-pink: #ff8fa3/);
    assert.match(styles, /--i3-lavender: #b8a9e8/);
    assert.match(styles, /grid-template-columns: minmax\(205px, 23fr\) minmax\(330px, 52fr\) minmax\(220px, 25fr\)/);
    assert.match(studio, /vnccs-i3s__side--left/);
    assert.match(studio, /vnccs-i3s__center/);
    assert.match(studio, /vnccs-i3s__side--right/);
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
    const serialize = Function(`return ({${method[1].replace("STATE_VERSION", "2")}}).serializeState;`)();
    const snapshot = { name: "Remembered", objects: [{ object_id: "object-a" }] };
    const state = serialize.call({
        sceneId: "scene-a",
        selectedObjectId: "object-a",
        settings: { steps: 37, seed: 12 },
        viewerState: { mode: "rotate" },
        viewer: { getState: () => ({ mode: "scale", camera: { position: [1, 2, 3] } }) },
        scene: { objects: snapshot.objects },
        sourceAsset: { url: "/reference", name: "input.png" },
        _scenePayload: () => snapshot,
    });
    assert.equal(state.schema_version, 2);
    assert.equal(state.settings.steps, 37);
    assert.equal(state.selected_object_id, "object-a");
    assert.deepEqual(state.scene_snapshot, snapshot);
    assert.equal(state.source.url, "/reference");
    assert.equal(state.viewer_state.mode, "scale");
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

test("Factory viewer and every vendored Three/Spark dependency can actually import", async () => {
    const module = await import(
        `${pathToFileURL(path.join(root, "web", "vnccs_3d_factory_viewer.js")).href}?test=${Date.now()}`
    );
    const THREE = await import(pathToFileURL(path.join(root, "web", "vendor", "spark", "three.module.js")).href);
    assert.equal(typeof module.Factory3DViewer, "function");
    assert.equal(typeof module.boundedObjectHit, "function");
    assert.equal(typeof module.computeRobustSplatBounds, "function");
    assert.equal(typeof module.triposplatCanonicalMatrix, "function");
    assert.equal(typeof module.validateSplatBuffer, "function");
    assert.equal(typeof module.prepareSplatBuffer, "function");
    assert.equal(module.FACTORY_VIEWER_BUILD, "20260724.13");
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
});
