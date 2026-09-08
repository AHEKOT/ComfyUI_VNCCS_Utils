import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as schema from "../web/factory3d/editor_schema.mjs";
import * as descriptors from "../web/factory3d/core/property_descriptors.mjs";
import * as parts from "../web/factory3d/geometry/parametric_parts.mjs";
import { FactoryCommandHistory } from "../web/factory3d/editor_commands.mjs";

// Execute the actual widget methods without importing the ComfyUI host or creating a GPU renderer.
const source = fs.readFileSync(new URL("../web/vnccs_3d_factory.js", import.meta.url), "utf8");
const prototype = vm.runInNewContext(source.slice(source.indexOf("class Factory3DWidget"),
    source.indexOf("function enableCanvasNavigationForwarding")) + "\nFactory3DWidget.prototype", {
    ...schema, ...descriptors, ...parts, structuredClone, clearTimeout,
    ENDPOINTS: { createPrimitive: id => `/test/scenes/${id}/primitive` },
    safeObject: value => value && typeof value === "object" ? value : {},
    escapeHTML: value => String(value ?? ""),
    clamp: (value, min, max) => Math.max(min, Math.min(max, Number(value))),
});

test("List selection remains in Objects and never loops through the viewport callback", () => {
    const widget = Object.create(prototype);
    Object.assign(widget, {
        scene: { objects: [{ object_id: "a" }, { object_id: "b" }] },
        editorView: { plan_tool: "select" }, selectedObjectIds: new Set(), selectedCameraIds: new Set(),
        selectedArchitectureItems: new Map(), selectedObjectId: "",
        _validBuildingId: () => "", _selectedArchitectureRefs: () => [],
        _syncSelectionPresentation() {}, _renderInspector() {}, _syncToolbar() {}, _scheduleStateSave() {},
        _setWorkspaceTab() { assert.fail("List selection must not navigate to Inspector"); },
    });
    widget.viewer = {
        selectLightMarker() {}, setArchitectureSelection() {},
        select(id, options) {
            assert.equal(options.emit, false);
            if (options.emit !== false) widget._selectObject(id, { fromViewer: true });
        },
    };
    widget._selectObject("a");
    widget._selectObject("b", { additive: true });
    assert.deepEqual([...widget.selectedObjectIds], ["a", "b"]);
    widget._selectObject("a", { additive: true });
    assert.deepEqual([...widget.selectedObjectIds], ["b"]);
});

test("State synchronization preserves the native widget contract", () => {
    const widget = Object.create(prototype);
    let painted = 0;
    const state = { name: "factory_data", type: "customtext", value: "{}", callback() {
        assert.fail("Programmatic state writes must not invoke host input handlers");
    } };
    widget.node = { widgets: [state], setDirtyCanvas() { painted++; } };
    widget.serializeState = () => ({ scene_id: "terrain-scene" });
    widget.syncToNode();
    assert.equal(JSON.parse(state.value).scene_id, "terrain-scene");
    assert.equal(state.type, "customtext");
    assert.equal(painted, 0);
    const hide = vm.runInNewContext(source.match(/function hideFactoryDataWidget\(node\) \{[\s\S]*?\n\}/)[0] + "\nhideFactoryDataWidget");
    hide(widget.node);
    assert.equal(state.type, "customtext");
    assert.equal(state.hidden, true);
});

test("Terrain creation completes scene merge, inspector rendering and state synchronization", async () => {
    const widget = Object.create(prototype);
    const scene = { scene_id: "scene", schema_version: 12, objects: [], layers: [], levels: [], textures: [] };
    Object.assign(widget, {
        scene, sceneId: "scene", els: { inspector: { innerHTML: "" }, inspectorKind: {} },
        node: { widgets: [{ name: "factory_data", type: "customtext", value: "{}", callback() { assert.fail("Host callback"); } }] },
        _saveSceneNow: async () => {}, _scenePayload: () => ({ ...widget.scene }),
        _fetchJSON: async (url, options) => {
            const data = JSON.parse(options.body);
            assert.equal(data.primitive.kind, "terrain");
            return { object_id: "new-terrain", scene: { ...scene, objects: [{ ...data, object_id: "new-terrain", asset_kind: "primitive" }] } };
        },
        _applyScene: async next => { widget.scene = next; widget.syncToNode(); },
        _placeNewObjectOnActiveFloor() {},
        _selectObject: id => { widget.selectedObjectId = id; widget._renderObjectInspector(widget.scene.objects.find(item => item.object_id === id)); },
        _bindObjectInspector() {}, _scheduleScenePreview() {}, _scheduleStateSave() {}, toast() {},
        viewer: { fit() {} }, serializeState: () => ({ scene_snapshot: widget.scene }),
        _showError: (title, error) => { throw error; },
    });
    const result = await widget.createPrimitive("terrain");
    assert.equal(result.object_id, "new-terrain");
    assert.equal(widget.selectedObjectId, "new-terrain");
    assert.match(widget.els.inspector.innerHTML, /Relief height/);
    assert.equal(widget._creatingPrimitive, false);
    assert.equal(JSON.parse(widget.node.widgets[0].value).scene_snapshot.objects.length, 1);
});

test("An empty viewport pick clears selection without treating camera motion as a click", async () => {
    const { Factory3DViewer } = await import("../web/vnccs_3d_factory_viewer.js");
    const THREE = await import("../web/vendor/spark/three.module.js");
    const view = Object.create(Factory3DViewer.prototype);
    let cleared = 0;
    Object.assign(view, {
        canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) },
        pointer: new THREE.Vector2(), raycaster: new THREE.Raycaster(),
        planOverlay: new THREE.Group(), cameraHelperRoot: new THREE.Group(), lightHelperRoot: new THREE.Group(),
        architecture: { root: new THREE.Group() }, objects: new Map(), viewMode: "3d",
        activeCamera: () => new THREE.PerspectiveCamera(),
        select: id => { assert.equal(id, ""); cleared++; },
    });
    view._pick({ clientX: 200, clientY: 150 });
    assert.equal(cleared, 1);
    view._pick({ clientX: 200, clientY: 150, shiftKey: true });
    assert.equal(cleared, 1);
    const viewerSource = fs.readFileSync(new URL("../web/vnccs_3d_factory_viewer.js", import.meta.url), "utf8");
    assert.match(viewerSource, /if \(look\.moved\) \{[\s\S]*?return;/);
    assert.match(viewerSource, /if \(distance > 4 \|\| event\.button !== 0\) return;\s*this\._pick\(event\)/);
});

test("A normalized terrain can render every inspector field after creation", () => {
    const widget = Object.create(prototype);
    widget.scene = { schema_version: 12, levels: [], textures: [] };
    widget.els = { inspector: { innerHTML: "" }, inspectorKind: {} };
    widget._bindObjectInspector = () => {};
    const item = { object_id: "terrain", asset_kind: "primitive", name: "Terrain", primitive: { kind: "terrain" },
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } };
    widget._renderObjectInspector(item);
    assert.match(widget.els.inspector.innerHTML, /Relief height/);
    assert.match(widget.els.inspector.innerHTML, /Segments X/);
});

test("History buttons update after every completed edit without changing selection", () => {
    const widget = Object.create(prototype);
    widget.els = { undo: { disabled: true }, redo: { disabled: true } };
    widget.history = new FactoryCommandHistory({ onChange: () => widget._syncHistoryControls() });
    widget.history.push("Move", { x: 0 }, { x: 1 });
    assert.equal(widget.els.undo.disabled, false);
    widget.history.push("Move", { x: 1 }, { x: 2 });
    widget.history.undo();
    assert.equal(widget.els.undo.disabled, false);
    assert.equal(widget.els.redo.disabled, false);
    widget.history.undo();
    assert.equal(widget.els.undo.disabled, true);
    widget.history.redo();
    assert.equal(widget.els.undo.disabled, false);
    widget.history.clear();
    assert.equal(widget.els.undo.disabled, true);
    assert.equal(widget.els.redo.disabled, true);
});
