import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { STANDALONE_STYLES } from "../../web/unicanvas/standalone_theme.mjs";
import { MODEL_DEPENDENCIES_CSS } from "../../web/unicanvas/model_dependencies.mjs";

const moduleSource = await readFile(new URL("../../web/unicanvas/model_dependencies.mjs", import.meta.url), "utf8");
const widgetSource = await readFile(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const styles = widgetSource.match(/const STYLES = `([\s\S]*?)`;/)[1];
const polling = widgetSource.slice(widgetSource.indexOf("  startPresetDownloadPolling() {"), widgetSource.indexOf("  // A linked VNCSS Config overrides"));
const selectPreset = widgetSource.slice(widgetSource.indexOf("  selectPreset(presetId) {"), widgetSource.indexOf("  isPresetTurboEnabled(preset) {"));
const outpaintKey = "qwen_image21:dependency:0";
const turboKey = "qwen_image21:turbo";
const assets = [
  { download_key:"qwen_image21:asset:1", name:"Text encoder", required:true, installed:true },
  { download_key:"qwen_image21:asset:2", name:"VAE", required:true, installed:true },
  { download_key:outpaintKey, name:"Outpaint LoRA", description:"Used for outpaint.", role:"lora", installed:false },
  { download_key:turboKey, name:"Turbo LoRA", description:"Used for six-step generation.", role:"lora", installed:false },
];

async function fixture(page, { installed = false } = {}) {
  const server = { states:{}, posts:[], gets:[], failDownload:false };
  if (installed) for (const asset of assets) server.states[asset.download_key] = { status:"success" };
  await page.route("http://unicanvas.test/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/model_dependencies.mjs") return route.fulfill({ contentType:"text/javascript", body:moduleSource });
    if (url.pathname === "/vnccs/unicanvas/dependencies") {
      server.gets.push(Object.fromEntries(url.searchParams));
      return route.fulfill({ json:{ label:"Qwen Edit 2.1", assets:assets.map(asset => ({ ...asset,
        installed:asset.installed || server.states[asset.download_key]?.status === "success",
        ...(server.states[asset.download_key] || {}),
      })) } });
    }
    if (url.pathname === "/vnccs/unicanvas/dependencies/download") {
      server.posts.push(request.postDataJSON());
      if (server.failDownload) return route.fulfill({ status:500, json:{ error:"Network unavailable" } });
      for (const key of request.postDataJSON().download_keys) server.states[key] = { status:"queued", progress:0 };
      return route.fulfill({ json:{ queued:request.postDataJSON().download_keys } });
    }
    if (url.pathname === "/vnccs/unicanvas/presets/status") return route.fulfill({ json:server.states });
    if (url.pathname !== "/") return route.fulfill({ status:404, body:"Not found" });
    return route.fulfill({ contentType:"text/html", body:`<!doctype html><style>
      :root { --base-background:#202020; --interface-panel-surface:#282828; --secondary-background:#353535;
        --secondary-background-hover:#444; --interface-stroke:#4e4e4e; --base-foreground:#fff;
        --muted-foreground:#aaa; --primary-background:#236692; --primary-fg:#fff; --p-primary-color:#3485bb; color-scheme:dark; }
      body { margin:0; } #host { height:100vh; } #controls { padding:16px; }
      ${styles}${MODEL_DEPENDENCIES_CSS}${STANDALONE_STYLES}
    </style><div id="host" class="vnccs-unicanvas vnccs-uc-standalone"><div id="controls">
      <button id="preset" class="vnccs-uc-btn">Select preset</button><button id="custom" class="vnccs-uc-btn">Select custom model</button>
      <output id="status"></output></div></div><script type="module">
      import { checkModelDependencies, disposeModelDependencies } from "/model_dependencies.mjs";
      class Host {
        constructor() {
          this.container = document.querySelector("#host"); this.presetDownloads = {}; this.assetRefreshes = 0;
          this.settings = { generation_mode:"qwen_image21", diffusion_model_name:"custom/Qwen-Image-2.1.safetensors", clip_name:"custom/encoder.safetensors", vae_name:"custom/vae.safetensors" };
          this.presets = [{ id:"qwen_image21" }];
        }
        getModelBase() { return this.settings.generation_mode; }
        getPresetById(id) { return this.presets.find(preset => preset.id === id); }
        getActivePreset() { return null; }
        applyPresetSettings() { this.settings.model_selection_mode = "presets"; }
        syncPromptControls() {} syncSettingsToWidget() {} renderModelSelectionControls() {}
        async loadPresets() {} async _loadAssets() { this.assetRefreshes++; }
        setStatus(message) { document.querySelector("#status").textContent = message; }
        ${selectPreset}${polling}
      }
      window.widget = new Host();
      document.querySelector("#preset").onclick = () => widget.selectPreset("qwen_image21");
      document.querySelector("#custom").onclick = () => { widget.settings.model_selection_mode = "custom"; checkModelDependencies(widget); };
      window.dispose = () => { widget._disposed = true; disposeModelDependencies(widget); clearInterval(widget.presetDownloadTimer); };
      window.ready = true;
    </script>` });
  });
  await page.goto("http://unicanvas.test/");
  await page.waitForFunction(() => window.ready);
  return server;
}

for (const entry of ["preset", "custom"]) {
  test(`fixture: ${entry} selection offers missing files, progress, retry and preserves model choice`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width:900, height:650 });
    const server = await fixture(page);
    await page.locator(`#${entry}`).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(server.gets[0]).toEqual({ generation_mode:"qwen_image21", preset_id:entry === "preset" ? "qwen_image21" : "",
      ...(entry === "custom" ? { clip_name:"custom/encoder.safetensors", vae_name:"custom/vae.safetensors" } : {}) });
    expect(server.posts).toHaveLength(0);
    await expect(page.getByRole("checkbox", { name:"Text encoder", exact:true })).toBeDisabled();
    await page.getByRole("checkbox", { name:"Turbo LoRA", exact:true }).uncheck();
    const before = await page.evaluate(() => ({ ...widget.settings }));
    server.failDownload = true;
    await page.getByRole("button", { name:"Download selected" }).click();
    await expect(dialog).toContainText("Network unavailable");
    server.failDownload = false;
    await page.getByRole("button", { name:"Download selected" }).click();
    expect(server.posts.at(-1).download_keys).toEqual([outpaintKey]);
    await expect(dialog).toContainText("Queued");
    server.states[outpaintKey] = { status:"downloading", message:"Downloading", progress:50, downloaded_bytes:1048576, total_bytes:2097152 };
    await expect(dialog).toContainText("50% (1.0 / 2.0 MB)");
    await expect(dialog.getByRole("progressbar", { name:"Outpaint LoRA" })).toHaveAttribute("value", "50");
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(900); expect(box.y + box.height).toBeLessThanOrEqual(650);
    await page.screenshot({ path:testInfo.outputPath("after.png") });
    server.states[outpaintKey] = { status:"error", message:"Transfer interrupted" };
    await expect(dialog).toContainText("Transfer interrupted");
    await page.getByRole("button", { name:"Retry selected" }).click();
    server.states[outpaintKey] = { status:"success", progress:100 };
    await expect(page.getByRole("checkbox", { name:"Outpaint LoRA", exact:true })).toBeDisabled();
    await expect(dialog.getByRole("progressbar", { name:"Outpaint LoRA" })).toBeHidden();
    expect(await page.evaluate(() => widget.settings)).toEqual(before);
    await expect.poll(() => page.evaluate(() => widget.assetRefreshes)).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(`#${entry}`)).toBeFocused();
    expect(await page.locator("#controls").evaluate(element => element.inert)).toBe(false);
  });
}

test("fixture: installed dependencies stay silent and a closed dialog leaves downloads running", async ({ page }) => {
  const server = await fixture(page, { installed:true });
  await page.locator("#custom").click();
  await expect.poll(() => server.gets.length).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  delete server.states[outpaintKey];
  await page.locator("#preset").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name:"Download selected" }).click();
  await page.getByRole("button", { name:"Close", exact:true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => Boolean(widget.presetDownloadTimer))).toBe(true);
  server.states[outpaintKey] = { status:"success" };
  await expect.poll(() => page.evaluate(() => widget.assetRefreshes)).toBeGreaterThan(0);
  await page.locator("#custom").click();
  await expect.poll(() => server.gets.length).toBe(3);
  await expect(dialog).toHaveCount(0);
});

test("fixture: keyboard focus stays inside the modal and disposal releases the background", async ({ page }) => {
  await fixture(page);
  await page.locator("#custom").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name:"Download selected" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("checkbox", { name:"Outpaint LoRA", exact:true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name:"Download selected" })).toBeFocused();
  await page.evaluate(() => window.dispose());
  await expect(dialog).toHaveCount(0);
  expect(await page.locator("#controls").evaluate(element => element.inert)).toBe(false);
});
