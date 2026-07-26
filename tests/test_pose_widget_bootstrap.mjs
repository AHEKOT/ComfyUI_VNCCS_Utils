import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeClassList {
    add() {}
    remove() {}
    toggle() { return false; }
    contains() { return false; }
}

class FakeElement {
    constructor(tagName = "div", ownerDocument = null) {
        this.tagName = String(tagName).toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.style = { setProperty() {}, removeProperty() {} };
        this.classList = new FakeClassList();
        this.dataset = {};
        this.value = "";
        this.checked = false;
        this.disabled = false;
        this.scrollTop = 0;
        this.scrollLeft = 0;
        this.scrollWidth = 900;
        this.scrollHeight = 740;
        this.clientWidth = 900;
        this.clientHeight = 740;
        this.offsetWidth = 900;
        this.offsetHeight = 740;
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    append(...children) {
        this.children.push(...children);
    }

    prepend(...children) {
        this.children.unshift(...children);
    }

    replaceChildren(...children) {
        this.children = children;
    }

    remove() {}
    addEventListener() {}
    removeEventListener() {}
    setAttribute() {}
    removeAttribute() {}
    focus() {}
    click() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    matches() { return false; }
    getBoundingClientRect() {
        return {
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: this.clientWidth,
            bottom: this.clientHeight,
            width: this.clientWidth,
            height: this.clientHeight,
        };
    }
    getContext() {
        const gradient = { addColorStop() {} };
        const context = {
            beginPath() {},
            clearRect() {},
            closePath() {},
            createLinearGradient() { return gradient; },
            createRadialGradient() { return gradient; },
            fill() {},
            fillRect() {},
            lineTo() {},
            measureText(value) { return { width: String(value ?? "").length * 8 }; },
            moveTo() {},
            restore() {},
            save() {},
            stroke() {},
            strokeRect() {},
        };
        return new Proxy(context, {
            get(target, property) {
                if (property in target) return target[property];
                return () => {};
            },
        });
    }
}

function createFakeDocument() {
    const document = {
        addEventListener() {},
        removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement(tagName) {
            return new FakeElement(tagName, document);
        },
        createDocumentFragment() {
            return new FakeElement("fragment", document);
        },
    };
    document.head = new FakeElement("head", document);
    document.body = new FakeElement("body", document);
    return document;
}

async function syntheticModule(context, identifier, exports) {
    const names = Object.keys(exports);
    const module = new vm.SyntheticModule(names, function () {
        for (const name of names) this.setExport(name, exports[name]);
    }, { context, identifier });
    await module.link(() => {
        throw new Error(`Synthetic module ${identifier} has no dependencies`);
    });
    await module.evaluate();
    return module;
}

test("Pose Studio constructs its DOM widget and hides pose_data during node bootstrap", {
    skip: typeof vm.SourceTextModule !== "function"
        ? "requires Node --experimental-vm-modules"
        : false,
}, async () => {
    const document = createFakeDocument();
    let extension = null;
    const pendingTimers = new Map();
    let timerId = 1;
    const app = {
        graph: {},
        registerExtension(value) {
            extension = value;
        },
    };
    const api = { addEventListener() {}, removeEventListener() {} };
    const globals = {
        AbortController,
        Blob,
        console,
        crypto: globalThis.crypto,
        document,
        fetch: async () => ({ ok: true, json: async () => ({}) }),
        FormData,
        globalThis: null,
        localStorage: { getItem() { return null; }, setItem() {} },
        navigator: {},
        performance,
        ResizeObserver: class {
            observe() {}
            disconnect() {}
        },
        requestAnimationFrame() { return 1; },
        cancelAnimationFrame() {},
        setInterval() { return 1; },
        clearInterval() {},
        setTimeout(callback) {
            const id = timerId++;
            pendingTimers.set(id, callback);
            return id;
        },
        clearTimeout(id) {
            pendingTimers.delete(id);
        },
        URL,
        window: null,
    };
    globals.globalThis = globals;
    globals.window = globals;
    const context = vm.createContext(globals);

    const moduleCache = new Map();
    const loadSourceModule = async filePath => {
        const absolutePath = path.resolve(filePath);
        if (moduleCache.has(absolutePath)) return moduleCache.get(absolutePath);
        const modulePromise = (async () => {
            const source = await fs.readFile(absolutePath, "utf8");
            const module = new vm.SourceTextModule(source, {
                context,
                identifier: absolutePath,
                initializeImportMeta(meta) {
                    meta.url = `file://${absolutePath}`;
                },
            });
            await module.link(async (specifier, referencingModule) => {
                if (specifier === "../../scripts/app.js") {
                    return syntheticModule(context, specifier, { app });
                }
                if (specifier === "../../scripts/api.js") {
                    return syntheticModule(context, specifier, { api });
                }
                if (specifier === "./vnccs_pose_studio_core.js") {
                    class FakePoseViewerCore {
                        constructor() {
                            return new Proxy(this, {
                                get(target, property) {
                                    if (property in target) return target[property];
                                    return () => undefined;
                                },
                            });
                        }

                        init() {
                            return Promise.resolve();
                        }
                    }
                    return syntheticModule(context, specifier, {
                        PoseViewerCore: FakePoseViewerCore,
                    });
                }
                if (specifier === "./vnccs_mixamo_import.js") {
                    return syntheticModule(context, specifier, {
                        importMixamoFBXAnimation: async () => null,
                    });
                }
                if (specifier === "./vnccs_openpose_import.js") {
                    return syntheticModule(context, specifier, {
                        convertOpenPoseToPose: value => value,
                        detectAndParseJSON: value => value,
                        roundTripTest: value => value,
                    });
                }
                const relativePath = specifier.split(/[?#]/, 1)[0];
                const resolved = path.resolve(path.dirname(referencingModule.identifier), relativePath);
                return loadSourceModule(resolved);
            });
            return module;
        })();
        moduleCache.set(absolutePath, modulePromise);
        return modulePromise;
    };

    const module = await loadSourceModule(path.join(ROOT, "web/vnccs_pose_studio.js"));
    await module.evaluate();
    assert.ok(extension, "Pose Studio extension must register");

    class FakeNode {
        constructor() {
            this.size = [320, 240];
            this.inputs = [];
            this.outputs = [{ name: "images", type: "IMAGE", links: [] }];
            this.widgets = [{
                name: "pose_data",
                value: "{}",
                type: "text",
                element: new FakeElement("textarea", document),
            }];
        }

        setSize(size) {
            this.size = size;
        }

        addDOMWidget(name, type, element) {
            const widget = { name, type, element, _node: this, triggerDraw() {} };
            this.widgets.push(widget);
            return widget;
        }

        setDirtyCanvas() {}
    }

    await extension.beforeRegisterNodeDef(
        FakeNode,
        { name: "VNCCS_PoseStudio" },
        app,
    );
    const node = new FakeNode();
    node.onNodeCreated();

    assert.ok(node.studioWidget?.container, "Pose Studio DOM widget must be created");
    assert.ok(node.widgets.some(widget => widget.name === "pose_studio_ui"));
    const poseWidget = node.widgets.find(widget => widget.name === "pose_data");
    assert.equal(poseWidget.hidden, true);
    assert.equal(poseWidget.computeSize()[0], 0);
    assert.equal(poseWidget.computeSize()[1], -4);

    const studio = node.studioWidget;
    studio.exportParams.editor_mode = "image";
    studio.poses = [
        {
            cameraParams: {
                offset_x: -2,
                offset_y: 1,
                zoom: 1.25,
                yaw_deg: -20,
                pitch_deg: 5,
            },
        },
        {
            cameraParams: {
                offset_x: 4,
                offset_y: -3,
                zoom: 2.5,
                yaw_deg: 35,
                pitch_deg: -10,
            },
        },
    ];
    studio.characters[0].poses = studio.poses;

    studio.activeTab = 0;
    studio.restoreActivePoseCameraParams({ updateViewer: false });
    assert.deepEqual(
        [
            studio.exportParams.cam_offset_x,
            studio.exportParams.cam_offset_y,
            studio.exportParams.cam_zoom,
            studio.exportParams.cam_yaw_deg,
            studio.exportParams.cam_pitch_deg,
        ],
        [-2, 1, 1.25, -20, 5],
    );

    studio.activeTab = 1;
    studio.restoreActivePoseCameraParams({ updateViewer: false });
    studio.exportParams.cam_zoom = 3;
    studio.persistActivePoseCameraParams();
    assert.equal(studio.poses[0].cameraParams.zoom, 1.25);
    assert.equal(studio.poses[1].cameraParams.zoom, 3);

    studio.syncToNode(false, {
        skipCapture: true,
        skipCaptureUpload: true,
    });
    const savedState = JSON.parse(poseWidget.value);
    assert.equal(savedState.characters[0].poses[0].cameraParams.zoom, 1.25);
    assert.equal(savedState.characters[0].poses[1].cameraParams.zoom, 3);
});
