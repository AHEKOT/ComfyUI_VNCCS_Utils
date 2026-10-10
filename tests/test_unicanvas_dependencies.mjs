import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { checkModelDependencies, disposeModelDependencies } from "../web/unicanvas/model_dependencies.mjs";

const source = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");

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
