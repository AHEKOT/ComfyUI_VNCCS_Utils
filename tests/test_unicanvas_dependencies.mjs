import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { checkModelDependencies, disposeModelDependencies, openModelDependencies } from "../web/unicanvas/model_dependencies.mjs";

const source = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");

for (const [loader, key, name] of [
  ["checkpoint", "ckpt_name", "custom/checkpoint.safetensors"],
  ["diffusion_model", "diffusion_model_name", "krea2_raw_fp8_scaled.safetensors"],
  ["gguf", "gguf_model_name", "custom/model.gguf"],
]) {
  test(`Custom dependency checks include the selected ${loader} file`, async context => {
    const originalFetch = globalThis.fetch;
    context.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (url, options) => {
      assert.deepEqual(Object.fromEntries(new URL(url, "http://unicanvas.test").searchParams), {
        generation_mode:"krea2_edit", preset_id:"", model_loader:loader, model_name:name,
        clip_name:"custom/encoder.safetensors", vae_name:"custom/vae.safetensors",
      });
      assert.equal(options.cache, "no-store");
      return { ok:true, json:async () => ({ assets:[] }) };
    };
    await checkModelDependencies({ getModelBase:() => "krea2_edit", settings:{ model_loader:loader, [key]:name,
      clip_name:"custom/encoder.safetensors", vae_name:"custom/vae.safetensors" }, setStatus:message => assert.fail(message) });
  });
}

test("the dialog lists and downloads all missing core parts while retaining manual files", async context => {
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  context.after(() => { globalThis.document = previousDocument; globalThis.fetch = previousFetch; });
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.events = {}; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute() {} removeAttribute() {}
    addEventListener(type, callback) { this.events[type] = callback; }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    focus() { globalThis.document.activeElement = this; }
  }
  globalThis.document = { createElement:tag => new Element(tag), activeElement:null };
  const roles = ["diffusion_model", "clip", "vae", "lora"];
  const assets = roles.map(role => ({ role, name:role, download_key:role, required:true, installed:false }));
  assets.push({ name:"Installed VAE", installed:true },
    { name:"custom/missing.safetensors", download_key:"manual", installed:false, required:true, downloadable:false });
  let posted, polling = 0;
  globalThis.fetch = async (_url, options) => {
    posted = JSON.parse(options.body);
    return { ok:true, json:async () => ({ queued:posted.download_keys }) };
  };
  const host = { container:new Element("div"), presetDownloads:{}, startPresetDownloadPolling:() => { polling++; } };
  const dialog = openModelDependencies(host, { label:"Krea2 Edit", assets }, { generation_mode:"krea2_edit", preset_id:"krea2_edit" });
  const overlay = host.container.children[0], modal = overlay.children[0];
  const [, , list, summary, actions] = modal.children;
  assert.equal(list.children.length, 5);
  assert.deepEqual(list.children.map(row => row.children[0].children[1].textContent), [...roles, "custom/missing.safetensors"]);
  assert.equal(summary.textContent, "5 file(s) missing.");
  const manualCheckbox = list.children[4].children[0].children[0];
  assert.equal(manualCheckbox.disabled, true);
  assert.equal(manualCheckbox.checked, false);
  await actions.children[1].events.click();
  assert.deepEqual(posted.download_keys, roles);
  assert.equal(polling, 1);
  dialog.update(Object.fromEntries(roles.map(role => [role, { status:"success" }])));
  assert.equal(summary.textContent, "1 file(s) missing.");
  assert.equal(host._dependencyDialog, dialog, "an undownloadable missing file must keep the dialog open");
  dialog.close();
  assert.equal(host.container.children.length, 0);
});

test("preset selection checks its dependencies after applying the selected preset", () => {
  const method = source.slice(source.indexOf("  selectPreset(presetId) {"), source.indexOf("  isPresetTurboEnabled(preset) {"));
  const preset = { id:"qwen_image21" };
  const calls = [];
  const host = runInNewContext(`({ ${method} })`, { checkModelDependencies:(widget, selected) => {
    assert.equal(widget.selected, preset);
    calls.push(selected);
  } });
  Object.assign(host, { getPresetById:() => preset, getActivePreset:() => null,
    applyPresetSettings:selected => { host.selected = selected; }, syncPromptControls:() => {}, syncSettingsToWidget:() => {} });
  host.selectPreset(preset.id);
  assert.deepEqual(calls, [preset]);
  const input = source.slice(source.indexOf('this.left.addEventListener("input"'), source.indexOf('this.left.addEventListener("change"'));
  assert.match(input, /\["generation_mode", "model_loader", "ckpt_name", "diffusion_model_name", "gguf_model_name"\]\.includes\(key\)/);
  assert.match(input, /checkModelDependencies\(this\)/);
});

test("a later Custom family selection ignores the earlier response", async context => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
  const errors = [];
  const host = { getModelBase:() => "qwen_image21", setStatus:message => errors.push(message) };
  const first = checkModelDependencies(host, { id:"qwen_image21" });
  host.getModelBase = () => "anima";
  const second = checkModelDependencies(host);
  assert.equal(requests[0].options.signal.aborted, true);
  assert.ok(requests[1].url.includes("generation_mode=anima&preset_id="));
  requests[1].resolve({ ok:true, json:async () => ({ assets:[] }) });
  requests[0].resolve({ ok:false, json:async () => ({ error:"Stale error" }) });
  await Promise.all([first, second]);
  assert.deepEqual(errors, []);
});

test("disposal aborts a pending check and closes the dialog", async context => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  let closed = 0;
  const host = { getModelBase:() => "qwen_image21", _dependencyDialog:{ close:() => { closed++; } }, setStatus:() => assert.fail("disposed") };
  const pending = checkModelDependencies(host);
  host._disposed = true;
  disposeModelDependencies(host);
  release({ ok:true, json:async () => ({ assets:[{ installed:false }] }) });
  await pending;
  assert.equal(host._dependencyCheckAbort.signal.aborted, true);
  assert.equal(closed, 2);
  assert.match(source, /this\._disposed = true;\s*disposeModelDependencies\(this\)/);
});

for (const change of ["generation", "document"]) {
  test(`a dependency response cannot open a dialog after ${change} starts`, async context => {
    const originalFetch = globalThis.fetch;
    context.after(() => { globalThis.fetch = originalFetch; });
    let release;
    globalThis.fetch = () => new Promise(resolve => { release = resolve; });
    const errors = [];
    const host = { _documentRevision: 1, getModelBase: () => "qwen_image21", setStatus: message => errors.push(message) };
    const pending = checkModelDependencies(host);
    if (change === "generation") host.editingBlocked = true;
    else host._documentRevision++;
    release({ ok: true, json: async () => ({ assets: [{ installed: false }] }) });
    await pending;
    assert.deepEqual(errors, [], "a stale response must neither open UI nor replace the current status");
    assert.equal(host._dependencyDialog, undefined);
  });
}

test("a new download cannot be stopped by an older status response", async () => {
  const methods = source.slice(source.indexOf("  startPresetDownloadPolling() {"), source.indexOf("  // A linked VNCSS Config overrides"));
  let release, refreshes = 0;
  const host = runInNewContext(`(class { ${methods} }).prototype`, {
    fetch:() => new Promise(resolve => { release = resolve; }),
    window:{ clearInterval:() => assert.fail("New job lost its polling timer") },
  });
  Object.assign(host, { presetDownloadTimer:1, _presetDownloadRevision:1,
    presetDownloads:{ file:{ status:"queued" } },
    _loadAssets:() => { refreshes++; }, renderModelSelectionControls:() => {}, setStatus:() => assert.fail("unexpected error") });
  const pending = host.refreshPresetDownloadStatus();
  host.startPresetDownloadPolling();
  release({ ok:true, json:async () => ({}) });
  await pending;
  assert.equal(host.presetDownloadTimer, 1);
  assert.equal(host.presetDownloads.file.status, "queued");
  assert.equal(refreshes, 0);
  assert.equal(host._presetStatusRefreshing, false);
});
