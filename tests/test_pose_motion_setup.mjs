import assert from "node:assert/strict";
import test from "node:test";

import { createScene, Element } from "./helpers/pose_studio_scene.mjs";
import {
    MOTION_SETUP_API,
    describeManagerDenial,
    installPipPackages,
    modelFacts,
    modelOptionLabel,
    modelReadiness,
    renderModelCard,
    restartComfyUI,
    waitForServer,
} from "../web/vnccs_pose_motion_setup.mjs";
import { MOTION_API, TextToMotionPanel } from "../web/vnccs_pose_text_to_motion.mjs";

const document = { createElement: (tag) => new Element(tag) };

const READY = {
    id: "kimodo",
    name: "Kimodo",
    available: true,
    capabilities: { start_pose_constraint: true, duration: { min: 1, max: 10, default: 4 }, steps: { min: 10, max: 200, default: 100 } },
    requirements: { vram_gb: 17 },
    guide: { summary: "Recommended.", best_for: "Continuing your pose", download_gb: 17 },
    license: { restricted_territories: [] },
    setup: [{ id: "package", kind: "pip", label: "Kimodo", packages: ["git+https://github.com/nv-tlabs/kimodo"], modules: ["kimodo"], done: true }],
};
const NEEDS_SETUP = {
    id: "unimate",
    name: "UniMate",
    available: false,
    capabilities: { start_pose_constraint: false, duration: { min: 0.5, max: 2, default: 2 }, guidance: { min: 1, max: 10, default: 2.5 } },
    requirements: { vram_gb: 6 },
    guide: { summary: "Research preview.", setup_effort: "Expert", download_gb: 2 },
    license: { restricted_territories: [] },
    setup: [
        { id: "packages", kind: "pip", label: "Python packages", packages: ["einops", "tyro"], modules: ["einops", "tyro"], done: false },
        { id: "extra", kind: "pip", label: "More packages", packages: ["loguru"], modules: ["loguru"], done: false },
        { id: "code", kind: "manual", check: "code", label: "Code", command: "git clone https://github.com/Friedrich-M/UniMate x", link: "https://github.com/Friedrich-M/UniMate", done: false },
        { id: "checkpoint", kind: "download", check: "checkpoint", label: "Checkpoint", done: true },
        { id: "notes", kind: "auto", label: "Weights", done: null },
    ],
};

function findAll(node, predicate, found = []) {
    if (predicate(node)) found.push(node);
    for (const child of node.children || []) findAll(child, predicate, found);
    return found;
}
const buttons = (node) => findAll(node, (n) => n.tagName === "BUTTON");
const byText = (node, text) => buttons(node).find((n) => n.textContent === text);
const texts = (node) => findAll(node, (n) => typeof n.textContent === "string" && n.textContent).map((n) => n.textContent);

function response(status, body = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("readiness counts checked steps and pending pip installs", () => {
    assert.deepEqual(
        { ...modelReadiness(NEEDS_SETUP), pendingPip: modelReadiness(NEEDS_SETUP).pendingPip.map((s) => s.id) },
        { ready: false, done: 1, total: 4, pendingPip: ["packages", "extra"] },
    );
    assert.equal(modelReadiness(READY).ready, true);
    assert.equal(modelOptionLabel(READY), "Kimodo · ready");
    assert.equal(modelOptionLabel(NEEDS_SETUP), "UniMate · needs setup");
});

test("facts tell models apart", () => {
    assert.deepEqual(modelFacts(READY), ["Starts from your pose", "Up to 10 s", "~17 GB VRAM", "~17 GB download"]);
    assert.deepEqual(modelFacts({ ...READY, runner: "worker", worker: "ardy" }).slice(0, 2), ["Starts from your pose", 'Isolated worker "ardy"']);
    assert.deepEqual(modelFacts(NEEDS_SETUP), ["Applied on top of your pose", "Up to 2 s", "~6 GB VRAM", "~2 GB download"]);
});

test("a ready model shows its card without setup steps", () => {
    const card = renderModelCard(document, READY, {});
    assert.ok(texts(card).includes("Ready"));
    assert.ok(texts(card).includes("Recommended."));
    assert.ok(texts(card).includes("Good for: Continuing your pose"));
    assert.equal(buttons(card).length, 0);
});

test("a model that needs setup lists steps with the matching actions", () => {
    const calls = [];
    const record = (name) => (...args) => calls.push([name, ...args]);
    const actions = {
        installPip: record("installPip"), installAll: record("installAll"), download: record("download"),
        copy: record("copy"), restart: record("restart"), recheck: record("recheck"),
    };
    const card = renderModelCard(document, NEEDS_SETUP, actions, { restartPending: true });
    assert.ok(texts(card).includes("Setup 1/4"));
    const steps = findAll(card, (n) => n.dataset?.step);
    assert.deepEqual(steps.map((n) => n.dataset.step), ["packages", "extra", "code", "checkpoint", "notes"]);
    // A finished step has no actions; the pip step offers Install, the manual one Copy and Open.
    assert.deepEqual(buttons(steps[0]).map((b) => b.textContent), ["Install"]);
    assert.deepEqual(buttons(steps[2]).map((b) => b.textContent), ["Copy"]);
    assert.equal(findAll(steps[2], (n) => n.tagName === "A")[0].href, "https://github.com/Friedrich-M/UniMate");
    assert.equal(buttons(steps[3]).length, 0);

    buttons(steps[0])[0].click();
    buttons(steps[2])[0].click();
    byText(card, "Install all packages").click();
    byText(card, "Restart ComfyUI").click();
    byText(card, "Check again").click();
    assert.deepEqual(calls.map((call) => call[0]), ["installPip", "copy", "installAll", "restart", "recheck"]);
    assert.equal(calls[1][1], "git clone https://github.com/Friedrich-M/UniMate x");
    assert.deepEqual(calls[2][1].map((s) => s.id), ["packages", "extra"]);
});

test("pip installs go to ComfyUI-Manager and fall back to older APIs", async () => {
    const seen = [];
    const modern = await installPipPackages(async (route, options) => {
        seen.push([route, options.body]);
        return response(200);
    }, ["einops", "tyro"]);
    assert.equal(modern.ok, true);
    assert.deepEqual(seen, [["/customnode/install/pip", JSON.stringify({ packages: "einops tyro" })]]);

    // An old Manager reads plain text: a 400 for the JSON body retries as text.
    seen.length = 0;
    const legacy = await installPipPackages(async (route, options) => {
        seen.push(options.body);
        return response(options.body === "einops" ? 200 : 400);
    }, ["einops"]);
    assert.equal(legacy.ok, true);
    assert.equal(seen.length, 2);

    // Manager v4 only has /v2 routes.
    const v2 = await installPipPackages(async (route) => response(route.startsWith("/v2/") ? 200 : 404), ["einops"]);
    assert.equal(v2.ok, true);

    const denied = await installPipPackages(async () => response(403, { error: "allow_pip_install" }), ["einops"]);
    assert.deepEqual({ ok: denied.ok, status: denied.status, flag: denied.flag }, { ok: false, status: 403, flag: "allow_pip_install" });
    const missing = await installPipPackages(async () => response(404), ["einops"]);
    assert.equal(missing.status, 404);
});

test("denials explain the exact Manager change and the manual command", () => {
    const policy = { config_path: "/comfy/user/__manager/config.ini", listener_is_loopback: false, listener: "0.0.0.0", security_level: "normal" };
    const flag = describeManagerDenial({ status: 403, flag: "allow_pip_install" }, policy, ["einops"]);
    assert.match(flag, /allow_pip_install = true/);
    assert.match(flag, /\/comfy\/user\/__manager\/config\.ini/);
    assert.match(flag, /127\.0\.0\.1 \(it listens on 0\.0\.0\.0\)/);
    assert.match(flag, /python -m pip install einops/);
    assert.match(describeManagerDenial({ status: 404 }, null, ["einops"]), /ComfyUI-Manager is not installed/);
    assert.match(describeManagerDenial({ status: 403, flag: "" }, policy, []), /security_level \(now "normal"\)/);
});

test("restart uses Manager's reboot route and treats a dropped connection as accepted", async () => {
    const routes = [];
    assert.equal(await restartComfyUI(async (route) => { routes.push(route); return response(route.startsWith("/v2/") ? 200 : 404); }), true);
    assert.deepEqual(routes, ["/manager/reboot", "/v2/manager/reboot"]);
    assert.equal(await restartComfyUI(async () => { throw new Error("Failed to fetch"); }), true);
    assert.equal(await restartComfyUI(async () => response(404)), false);
});

test("waiting for the server needs it to go away or several good probes", async () => {
    const sleep = async () => {};
    const results = [true, false, false, true];
    let index = 0;
    assert.equal(await waitForServer(async () => results[index++], { sleep }), true);
    assert.equal(index, 4);
    assert.equal(await waitForServer(async () => false, { sleep, attempts: 3 }), false);
});

function sceneWithRig() {
    const scene = createScene({ skinned: true });
    scene.viewer._initIKHelpers();
    scene.w.canvasContainer = new Element();
    return scene;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function panelApi(models, extra = {}) {
    const calls = [];
    const fetchApi = async (route, options = {}) => {
        calls.push({ route, options });
        if (route === `${MOTION_API}/models`) return response(200, { models, default: models[0].id });
        if (extra[route]) return extra[route](options);
        return response(404, { error: "unknown" });
    };
    return { fetchApi, calls };
}

test("the panel starts on a ready model and shows a card for the selected one", async () => {
    const { w, document: doc } = sceneWithRig();
    const { fetchApi } = panelApi([NEEDS_SETUP, READY]);
    const panel = new TextToMotionPanel(w, { fetchApi, document: doc });
    panel.open();
    await settle();
    await settle();
    assert.equal(panel.settings.model, READY.id, "a ready model is preferred over the default that needs setup");
    assert.deepEqual(panel.controls.modelSelect.children.map((o) => o.textContent), ["UniMate · needs setup", "Kimodo · ready"]);
    assert.ok(texts(panel.controls.card).includes("Ready"));

    panel.controls.modelSelect.value = NEEDS_SETUP.id;
    panel.controls.modelSelect.emit("change");
    assert.ok(texts(panel.controls.card).includes("Setup 1/4"));
    panel.settings.prompt = "wave";
    panel.updateButtons();
    assert.equal(panel.controls.generate.disabled, true);
    panel.cancel();
});

test("Install in the card queues the packages and offers a restart; a denial shows what to change", async () => {
    const { w, document: doc } = sceneWithRig();
    let allow = true;
    const { fetchApi, calls } = panelApi([NEEDS_SETUP], {
        "/customnode/install/pip": () => (allow ? response(200) : response(403, { error: "allow_pip_install" })),
        [`${MOTION_SETUP_API}/policy`]: () => response(200, { config_path: "/m/config.ini", listener_is_loopback: true }),
    });
    const panel = new TextToMotionPanel(w, { fetchApi, document: doc });
    panel.open();
    await settle();
    await settle();
    const step = findAll(panel.controls.card, (n) => n.dataset?.step === "packages")[0];
    await panel.installPackages([NEEDS_SETUP.setup[0]], buttons(step)[0]);
    assert.equal(JSON.parse(calls.find((c) => c.route === "/customnode/install/pip").options.body).packages, "einops tyro");
    assert.ok(byText(panel.controls.card, "Restart ComfyUI"), "restart is offered after queueing");

    allow = false;
    await panel.installPackages([NEEDS_SETUP.setup[1]], null);
    assert.ok(texts(panel.controls.card).some((t) => /"allow_pip_install = true" under \[default\] in \/m\/config\.ini/.test(t)));
    panel.cancel();
});

test("pose-only hosts keep the single-frame flow with a clear button", async () => {
    const { w, document: doc } = sceneWithRig();
    const { fetchApi } = panelApi([READY]);
    w.isAnimationMode = () => true;
    w.animationState = { currentFrame: 0 };
    const panel = new TextToMotionPanel(w, { fetchApi, document: doc });
    panel.open({ poseOnly: true });
    assert.equal(panel.animation, false);
    assert.equal(panel.controls.ok.textContent, "Use this frame");
    panel.cancel();
    panel.open();
    assert.equal(panel.animation, true);
    assert.equal(panel.controls.ok.textContent, "Use as animation");
    panel.close();
});
