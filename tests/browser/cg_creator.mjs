// Adapted from VNCCS tests/browser/background_creator.mjs: real widget, local fixtures, After captures.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { settingsDefaults } from "../../web/cg_creator/state.mjs";
import { base, backgroundId, imageId, modelId, camera, document as initial, scene, roomSplat } from "./fixtures/cg_creator.mjs";

const { chromium } = createRequire(new URL("../e2e/package.json", import.meta.url))("playwright");
const project = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[3] || join(project, "tests/e2e/evidence/cg-creator"));
await mkdir(output, { recursive: true });
for (const name of ["after", "after-compact", "after-settings", "after-save-view", "after-generating", "after-completed", "after-empty", "after-read-only", "after-failure"])
    await rm(join(output, name + ".png"), { force: true });
for (const name of ["after.geometry.json", "report.json"]) await rm(join(output, name), { force: true });
const room = await readFile(new URL("./fixtures/room.svg", import.meta.url));
const splat = roomSplat(), assets = new Map();
let document = { ...structuredClone(initial), cg_settings: settingsDefaults() }, job = null, readOnly = false;
const mutations = [], errors = [], unexpected = [], warnings = [], scenarios = [];
const publicDocument = () => ({ ...document, ...(readOnly ? { _recovery: { source: "Evening room.json.backup" } } : {}) });
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>VNCCS CG Creator browser test</title>
<style>body{margin:0;padding:20px;background:#202024}#host{margin:0 auto;position:relative}</style><div id="host"></div><script type="module">
import '/web/vnccs_cg_creator.js';
import { app } from '/scripts/app.js';
window.setup=async({width=1600,height=1000,empty=false,raw=null}={})=>{
 window.widget?.node.onRemoved();const host=document.querySelector('#host');host.replaceChildren();
 const saved=await(await fetch('/fixture')).json();
 class Node{
  constructor(){this.id=7;this.type='VNCCS_CGCreator';this.size=[width,height];this.graph=app.graph;this.properties={};this.widgets=[{name:'cg_data',value:'unconfigured'}];}
  setSize(size){this.size=[...size];host.style.width=size[0]+'px';}
  addDOMWidget(name,type,element,options){const widget={name,type,element,options,triggerDraw(){}};this.widgets.push(widget);return widget;}
 }
 app.extensions.find(extension=>extension.name==='VNCCS.CGCreator').beforeRegisterNodeDef(Node,{name:'VNCCS_CGCreator'});
 const node=new Node();app.graph._nodes=[node];node.onNodeCreated();window.widget=node.cgCreator;
 if(node.widgets[0].value!=='unconfigured')throw new Error('Construction overwrote workflow data');
 node.widgets[0].value=raw||JSON.stringify({schema_version:1,background_id:empty?'':saved.background_id,
  selected_image_id:empty?'':saved.selected_image_id,model_id:empty?'':saved.models[0].model_id,selected_cg_id:empty?'':saved.cgs[0].cg_id,
  model_settings:saved.model_settings,settings:saved.cg_settings});
 node.onConfigure();clearTimeout(node._cgRestore);node.setSize([width,height]);host.append(widget.container);node.onResize();await widget.restore();
 if(widget.restoring)throw new Error(widget.status.textContent);await document.fonts.ready;
};
window.ready=true;
</script></html>`;
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, "http://localhost");
        let content, type = "application/json";
        if (url.pathname === "/") { content = html; type = "text/html"; }
        else if (url.pathname === "/scripts/app.js") { content = "export const app={extensions:[],graph:{_nodes:[],setDirtyCanvas(){}},registerExtension(e){this.extensions.push(e)}};"; type = "text/javascript"; }
        else if (url.pathname === "/scripts/api.js") { content = "export const api={apiURL:path=>path,fetchApi:(path,options)=>fetch(path,options),queuePrompt(){throw new Error('The browser fixture must not queue a workflow')}};"; type = "text/javascript"; }
        else if (url.pathname.startsWith("/web/")) {
            const path = resolve(project, "." + decodeURIComponent(url.pathname));
            assert.ok(path.startsWith(join(project, "web") + sep));
            content = await readFile(path); type = mime[extname(path)] || "application/octet-stream";
        } else if (url.pathname === "/fixture") content = JSON.stringify(publicDocument());
        else if (url.pathname === `${base}/config`) content = JSON.stringify({ settings: settingsDefaults(), model: "Qwen Image 2.1 INT8 ConvRot", installed: true, assets: [], samplers: ["euler", "dpmpp_2m"], schedulers: ["simple", "normal"] });
        else if (url.pathname === `${base}/backgrounds`) content = JSON.stringify({ backgrounds: [publicDocument()] });
        else if (url.pathname === `${base}/backgrounds/${backgroundId}/models/${modelId}`) content = JSON.stringify(scene);
        else if (url.pathname.endsWith(`/objects/${scene.objects[0].object_id}/splat`)) { content = splat; type = "application/octet-stream"; }
        else if (url.pathname === document.images[0].url || document.cgs.some(cg => cg.url === url.pathname)) {
            const asset = assets.get(url.pathname); content = asset || room; type = asset ? "image/png" : "image/svg+xml";
        } else if (url.pathname === `${base}/backgrounds/${backgroundId}/jobs` && request.method === "POST") {
            const parts = []; for await (const part of request) parts.push(part);
            const form = await new Request(url, { method: "POST", headers: request.headers, body: Buffer.concat(parts) }).formData();
            const values = JSON.parse(form.get("data")), image = form.get("image");
            assert.equal(values.action, "cg"); assert.equal(values.model_id, modelId); assert.ok(image.size > 0);
            assert.equal(values.revision, document.revision);
            job = { job_id: "8".repeat(32), status: "running", progress: 42, message: "Refining CG · fixture progress", values, image: Buffer.from(await image.arrayBuffer()) };
            mutations.push({ action: "cg", ...values }); content = JSON.stringify({ job_id: job.job_id });
        } else if (url.pathname === "/__fixture__/complete") {
            assert.ok(job); const cgId = "9".repeat(32), imageURL = `${base}/backgrounds/${backgroundId}/cg/${cgId}/image`;
            assets.set(imageURL, job.image);
            document = { ...document, revision: document.revision + 1, cgs: [...document.cgs, { cg_id: cgId, name: job.values.name, camera: job.values.camera,
                model_id: modelId, source_image_id: imageId, width: job.image.readUInt32BE(16), height: job.image.readUInt32BE(20), url: imageURL }] };
            job.status = "completed"; job.result = { document: publicDocument() }; content = "{}";
        } else if (url.pathname === `${base}/jobs/${job?.job_id}`) content = JSON.stringify({ job_id: job.job_id, status: job.status, progress: job.progress, message: job.message, result: job.result });
        else if (url.pathname === `${base}/backgrounds/${backgroundId}`) {
            if (request.method === "PATCH") {
                let raw = ""; for await (const chunk of request) raw += chunk;
                const payload = JSON.parse(raw); assert.equal(payload.revision, document.revision);
                mutations.push(payload); document = { ...document, revision: document.revision + 1, cg_settings: payload.cg_settings, model_settings: payload.model_settings };
            }
            content = JSON.stringify(publicDocument());
        } else if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
        else { unexpected.push(url.pathname); response.writeHead(404).end(); return; }
        response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(content);
    } catch (error) { errors.push(String(error)); response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"], ...(process.argv[2] ? { executablePath: process.argv[2] } : {}) })
    .catch(error => { server.close(); throw error; });
const page = await browser.newPage({ viewport: { width: 1800, height: 1160 }, deviceScaleFactor: 1 });
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (["warning", "error"].includes(message.type())) warnings.push(message.text()); });
await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ["blob:", "data:"].includes(url.protocol)) return route.continue();
    unexpected.push(url.href); return route.abort();
});
const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const capture = async name => {
    await page.evaluate(() => document.fonts.ready); await settle();
    const host = page.locator("#host"), dialog = page.locator("dialog[open]");
    if (await dialog.count()) {
        const a = await host.boundingBox(), b = await dialog.boundingBox(), x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        await page.screenshot({ path: join(output, name + ".png"), animations: "disabled", clip: { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y } });
    } else await host.screenshot({ path: join(output, name + ".png"), animations: "disabled" });
};
const geometry = () => page.evaluate(() => {
    const result = {};
    for (const [key, selector] of Object.entries({ widget: ".vnccs-cg-creator", source: ".bg-model-source", viewport: ".bg-viewport-panel", gallery: ".bg-cg-panel", toolbar: ".bg-camera-toolbar" })) {
        const element = document.querySelector(selector), rect = element.getBoundingClientRect();
        result[key] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, overflow: element.scrollWidth - element.clientWidth };
    }
    return result;
});
try {
    await page.goto(origin, { waitUntil: "domcontentloaded" }); await page.waitForFunction(() => window.ready);
    for (const width of [1600, 1180]) {
        await page.evaluate(width => setup({ width, height: 1000 }), width); await settle();
        assert.equal(await page.locator("[data-step],[data-wizard],[data-upload]").count(), 0);
        assert.equal(await page.locator("[data-cgs] .bg-cg-card").count(), 2);
        assert.equal(await page.locator("[data-save-view]").isEnabled(), true);
        const bounds = await geometry();
        assert.ok(bounds.source.x < bounds.viewport.x && bounds.viewport.x < bounds.gallery.x);
        for (const [name, box] of Object.entries(bounds)) assert.ok(box.overflow <= 1, `${name} has horizontal overflow at ${width}px`);
        assert.ok(bounds.viewport.width > 350, "The model viewport remains usable");
        const rendered = await page.evaluate(async () => {
            const blob = await widget.viewer.capturePreview({ width: 640, height: 352, cameraState: widget.viewer.getCameraState() });
            const bitmap = await createImageBitmap(blob), canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d");
            context.drawImage(bitmap, 0, 0); const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
            let colored = 0; for (let i = 0; i < data.length; i += 4) if (data[i] > 30 && data[i + 1] > 20) colored++;
            return { splats: [...widget.viewer.objects.values()][0].splat.numSplats, coverage: colored / (bitmap.width * bitmap.height) };
        });
        assert.ok(rendered.splats > 1000 && rendered.coverage > 0.15, "The production WebGL viewport renders the Gaussian fixture");
        await capture(width === 1600 ? "after" : "after-compact");
        if (width === 1600) await writeFile(join(output, "after.geometry.json"), JSON.stringify(bounds, null, 2));
        scenarios.push({ name: `workspace-${width}`, geometry: bounds, rendered });
    }
    await page.evaluate(() => setup());
    const slider = page.locator("[data-fov]"), sliderBox = await slider.boundingBox();
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.5, sliderBox.y + sliderBox.height / 2); await page.mouse.down();
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.7, sliderBox.y + sliderBox.height / 2); await settle();
    const live = await page.evaluate(() => ({ slider: Number(widget.fov.value), exact: Number(widget.fovNumber.value), camera: widget.viewer.getCameraState().fov, saved: JSON.parse(widget.node.widgets[0].value).camera.fov }));
    assert.ok(live.camera > 70); assert.equal(live.slider, live.camera); assert.equal(live.exact, live.camera); assert.equal(live.saved, live.camera);
    await page.mouse.up(); assert.equal(await page.evaluate(() => widget.history.undoStack.length), 1);
    await page.locator("[data-recenter]").click();
    const viewport = await page.locator("[data-viewer] canvas").boundingBox(), before = await page.evaluate(() => widget.viewer.getCameraState());
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2); await page.mouse.down();
    await page.mouse.move(viewport.x + viewport.width / 2 + 30, viewport.y + viewport.height / 2 + 12, { steps: 4 }); await settle();
    assert.notDeepEqual(await page.evaluate(() => widget.viewer.getCameraState().target), before.target, "Camera motion is visible before pointer release");
    const synchronized = await page.evaluate(() => ({ saved: JSON.parse(widget.node.widgets[0].value).camera, current: widget.viewer.getCameraState() }));
    for (const key of ["position", "target", "up"]) synchronized.saved[key].forEach((value, i) => assert.ok(Math.abs(value - synchronized.current[key][i]) < 1e-9, `${key} stays synchronized during camera movement`));
    assert.equal(synchronized.saved.fov, synchronized.current.fov);
    await page.mouse.up(); scenarios.push({ name: "continuous-camera", live });
    await page.locator("[data-cgs] .bg-cg-card").nth(1).click();
    await page.waitForFunction(() => !widget.busy);
    assert.equal(await page.evaluate(() => widget.viewer.getCameraState().fov), 48);
    const saved = await page.evaluate(() => { const value = { widgets_values: [widget.node.widgets[0].serializeValue()] }; widget.node.onSerialize(value); return value.widgets_values[0]; });
    await page.evaluate(raw => setup({ raw }), saved);
    assert.equal(await page.evaluate(() => widget.state.selected_cg_id), initial.cgs[1].cg_id);
    assert.equal(await page.evaluate(() => widget.viewer.getCameraState().fov), 48); scenarios.push({ name: "saved-cg-workflow-restore" });
    await page.getByRole("button", { name: "CG settings", exact: true }).click(); await page.getByRole("dialog").waitFor(); await capture("after-settings");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator("[data-save-view]").click(); await page.getByRole("dialog").waitFor();
    await page.getByRole("dialog").getByLabel("Aspect ratio").selectOption("9:16");
    assert.ok(await page.evaluate(() => widget.viewer.getCaptureSettings().height > widget.viewer.getCaptureSettings().width), "Aspect selection immediately previews a portrait frame");
    await page.getByRole("dialog").getByLabel("Aspect ratio").selectOption("4:3");
    await capture("after-save-view");
    await page.getByRole("dialog").getByRole("button", { name: "Generate CG", exact: true }).click();
    await page.waitForFunction(() => Boolean(widget.jobId)); await capture("after-generating");
    assert.equal(await page.locator("[data-fov]").isDisabled(), true); assert.equal(await page.locator("[data-stop]").isEnabled(), true);
    await page.request.post(origin + "/__fixture__/complete"); await page.waitForFunction(() => !widget.busy);
    assert.equal(await page.locator("[data-cgs] .bg-cg-card").count(), 3);
    assert.equal(await page.evaluate(() => JSON.parse(widget.node.widgets[0].value).selected_cg_id), "9".repeat(32));
    await capture("after-completed"); scenarios.push({ name: "capture-refine-select", camera: job.values.camera });
    await page.evaluate(() => setup({ empty: true })); await capture("after-empty");
    assert.equal(await page.locator('[data-action="model"]').isDisabled(), true); assert.equal(await page.locator("[data-save-view]").isDisabled(), true);
    readOnly = true; await page.evaluate(() => setup()); await capture("after-read-only");
    assert.equal(await page.locator('[data-action="model"]').isDisabled(), true); assert.equal(await page.locator("[data-save-view]").isDisabled(), true);
    assert.match(await page.locator(".bg-status [role=status]").textContent(), /read-only/); scenarios.push({ name: "empty-and-recovered" });
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
    await writeFile(join(output, "report.json"), JSON.stringify({ fixture: "Deterministic room; production widget and Gaussian renderer; inference mocked", scenarios, mutations: mutations.length, errors, unexpected, warnings }, null, 2));
    console.log(JSON.stringify({ output, scenarios: scenarios.length, errors, unexpected, warnings }));
} catch (error) {
    await page.screenshot({ path: join(output, "after-failure.png"), fullPage: true });
    await writeFile(join(output, "report.json"), JSON.stringify({ scenarios, errors, unexpected, warnings, failure: String(error) }, null, 2));
    throw error;
} finally { await browser.close(); server.close(); }
