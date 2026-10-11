import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const modesSource = await readFile(new URL("../../web/unicanvas/modes.mjs", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../../web/unicanvas/standalone_theme.mjs", import.meta.url), "utf8");
const version = source.match(/const VNCCS_UNICANVAS_VERSION = "(\d+)"/)[1];
// An unversioned request receives the cached theme from before the reference row existed.
const cachedTheme = themeSource.replace(/^.*(?:vnccs-uc-refs-row|vnccs-uc-refs-wide|vnccs-uc-ref-layers|data-use-layers-reference).*$/gm, "");
const styles = source.match(/const STYLES = `([\s\S]*?)`;/)[1];
const controls = source.slice(source.indexOf('      <div class="vnccs-uc-h3-panel" data-h3-panel'), source.indexOf('      <div class="vnccs-uc-lora-stack"'));
const sync = source.slice(source.indexOf("  syncStandaloneGenerationControls() {"), source.indexOf("  presetRuntimeSettingKeys(preset) {"));
const refs = source.slice(source.indexOf("  editReferenceImages() {"), source.indexOf("  // Anchor a popover below"));
const inputListener = source.slice(source.indexOf('    this.left.addEventListener("input",'), source.indexOf('    this.left.addEventListener("change",'));

for (const [width, sidebarWidth, scale] of [[900, 280, 1], [1600, 336, 1], [1600, 336, 1.5]]) {
  test(`fixture: reference controls align and open at canvas bottom left (${width}px, ${sidebarWidth}px sidebar, ${scale}x)`, async ({ page }, testInfo) => {
    test.setTimeout(20000);
    page.on("pageerror", error => { throw error; });
    await page.setViewportSize({ width, height:800 });
    await page.route("http://reference-controls.test/**", route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/scripts/app.js") return route.fulfill({ contentType:"text/javascript", body:"export const app = {};" });
      if (url.pathname.endsWith("/modes.mjs")) return route.fulfill({ contentType:"text/javascript", body:modesSource });
      if (url.pathname.endsWith("/standalone_theme.mjs")) return route.fulfill({ contentType:"text/javascript",
        body:url.searchParams.get("v") === version ? themeSource : cachedTheme });
      return route.fulfill({ contentType:"text/html", body:`<!doctype html>
      <style>
        :root { --base-background:#202020; --interface-panel-surface:#282828; --secondary-background:#353535;
          --secondary-background-hover:#444; --interface-stroke:#4e4e4e; --base-foreground:#fff;
          --muted-foreground:#aaa; --primary-background:#236692; --primary-fg:#fff; --p-primary-color:#3485bb; color-scheme:dark; }
        ${styles}
        body { margin:0; } #host { --vnccs-uc-ui-scale:${scale}; width:100vw; height:100vh; grid-template-columns:${sidebarWidth * scale}px minmax(0,1fr); grid-template-rows:1fr; }
        #host > .vnccs-uc-left { width:${sidebarWidth}px; }
        #host > .vnccs-uc-left, #host > .vnccs-uc-stage-wrap { grid-row:1; }
      </style><div id="host" class="vnccs-unicanvas vnccs-uc-standalone"><div class="vnccs-uc-left">${controls}</div><div class="vnccs-uc-stage-wrap"></div></div>
      <script type="module">
        import { ensureUniCanvasModeStyles } from "/extensions/Utils/unicanvas/modes.mjs?v=${version}";
        ensureUniCanvasModeStyles();
        const getUniCanvasModelModule = key => ({ key, isEditModel:["qwen_image21", "minimax_h3", "flux_klein", "krea2_edit"].includes(key) });
        const referenceSlotName = (_descriptors, _mode, n) => ({ text:"<image" + n + ">" });
        const referenceConventionHint = () => "Working area is the first reference.";
        const NUMERIC_SETTINGS = new Set();
        const MODEL_MEMORY_ASSET_FIELDS = {};
        class Host {
          constructor() {
            this.standalone = true; this.container = document.querySelector("#host"); this.stageWrap = document.querySelector(".vnccs-uc-stage-wrap");
            this.left = document.querySelector(".vnccs-uc-left");
            this.settings = { generation_mode:"qwen_image21", steps:6, minimax_h3_steps:20, edit_use_layers_as_reference:true,
              edit_reference_images:["data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="] };
            ${inputListener}
          }
          _button(text, className, click, title) { const b = document.createElement("button"); b.type="button"; b.textContent=text; b.className=className; b.title=title || text; b.onclick=click; return b; }
          getModelBase() { return this.settings.generation_mode; }
          getRasterContentInBboxStats() { return { nonzeroAlphaPixels:this.emptyCanvas ? 0 : 1 }; }
          syncSettingsToWidget() { this.savedSettings = JSON.stringify(this.settings); } scheduleStateUpload() {} setStatus() {}
          ${sync}${refs}
        }
        window.widget = new Host(); widget.syncStandaloneGenerationControls();
        document.querySelector("[data-standalone-refs]").onclick = () => widget.openEditReferenceImages();
      </script>` });
    });
    await page.goto("http://reference-controls.test/");
    const geometry = await page.evaluate(() => {
      const grid = document.querySelector(".vnccs-uc-generation-grid");
      return Object.fromEntries(["steps", "sampler_name", "scheduler", "cfg"].map(key => {
        const rect = grid.querySelector('[data-setting="' + key + '"]').getBoundingClientRect();
        return [key, { x:rect.x, y:rect.y, height:rect.height, width:rect.width }];
      }));
    });
    expect(Math.abs(geometry.steps.y - geometry.sampler_name.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.cfg.y - geometry.scheduler.y)).toBeLessThanOrEqual(1);
    expect(geometry.steps.x).toBe(geometry.cfg.x);
    expect(geometry.sampler_name.x).toBe(geometry.scheduler.x);
    expect(geometry.steps.y).toBeLessThan(geometry.cfg.y);
    expect(new Set(Object.values(geometry).map(rect => rect.height)).size).toBe(1);
    expect(new Set(Object.values(geometry).map(rect => rect.width)).size).toBe(1);
    const button = page.getByRole("button", { name:"Reference Images", exact:true });
    const toggle = page.getByRole("checkbox", { name:"Use Layers", exact:true });
    await expect(button).toBeVisible();
    await expect(toggle).toBeChecked();
    const rowBounds = await button.evaluate(el => {
      const button = el.getBoundingClientRect();
      const label = el.nextElementSibling.getBoundingClientRect();
      const row = el.parentElement.getBoundingClientRect();
      return { topDelta:Math.abs(button.top-label.top), heightDelta:Math.abs(button.height-label.height),
        gap:label.left-button.right, fits:label.right <= row.right && el.scrollWidth <= el.clientWidth };
    });
    expect(rowBounds.topDelta).toBeLessThanOrEqual(1);
    expect(rowBounds.heightDelta).toBeLessThanOrEqual(1);
    expect(rowBounds.gap).toBeGreaterThanOrEqual(8);
    expect(rowBounds.fits).toBe(true);
    await button.click();
    const dialog = page.getByRole("dialog", { name:"Reference images", exact:true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(dialog.getByRole("img")).toHaveAttribute("alt", "<image2>");
    await page.evaluate(() => { widget.emptyCanvas = true; widget._vnccsRefsRender(); });
    await expect(dialog.getByRole("img")).toHaveAttribute("alt", "<image1>");
    await expect(dialog.locator(".vnccs-uc-refs-count")).toHaveText("1 / 4");
    await page.evaluate(() => { widget.emptyCanvas = false; widget._vnccsRefsRender(); });
    await expect(dialog.getByRole("img")).toHaveAttribute("alt", "<image2>");
    await toggle.locator("..").click();
    await expect(toggle).not.toBeChecked();
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(widget.savedSettings).edit_use_layers_as_reference)).toBe(false);
    await expect(dialog.getByRole("img")).toHaveAttribute("alt", "<image1>");
    await expect(dialog.locator(".vnccs-uc-refs-count")).toHaveText("1 / 4");
    await expect(dialog.locator(".vnccs-uc-refs-hint")).toContainText("Uploaded images start at image 1");
    await dialog.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    const bounds = await page.evaluate(() => {
      const panel = document.querySelector("[data-edit-refs-popover]").getBoundingClientRect();
      const stage = widget.stageWrap.getBoundingClientRect();
      return { left:panel.left-stage.left, bottom:stage.bottom-panel.bottom, width:panel.width, stageWidth:stage.width };
    });
    expect(bounds.left).toBe(8); expect(bounds.bottom).toBe(8);
    expect(bounds.width).toBeLessThanOrEqual(bounds.stageWidth-8);
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toBeChecked();
    expect(await page.evaluate(() => JSON.parse(widget.savedSettings).edit_use_layers_as_reference)).toBe(true);
    await expect(dialog.getByRole("img")).toHaveAttribute("alt", "<image2>");
    await expect(dialog.locator(".vnccs-uc-refs-count")).toHaveText("2 / 5");
    await dialog.locator('[title="Close reference images"]').focus();
    await page.screenshot({ path:testInfo.outputPath("after.png") });
    for (const family of ["minimax_h3", "flux_klein", "krea2_edit", "sdxl"]) {
      await page.evaluate(family => { widget.settings.generation_mode=family; widget.syncStandaloneGenerationControls(); }, family);
      await expect(dialog).toBeHidden();
      if (family === "sdxl") {
        await expect(button).toBeHidden();
        await expect(toggle).toBeHidden();
      } else {
        await expect(button).toBeVisible();
        await expect(toggle).toBeVisible();
        if (family === "krea2_edit") {
          await button.click();
          await expect(dialog.locator(".vnccs-uc-refs-count")).toHaveText("2 / 2");
          await toggle.uncheck();
          await expect(dialog.locator(".vnccs-uc-refs-count")).toHaveText("1 / 2");
          await expect(dialog.getByRole("img")).toHaveAttribute("alt", "<image1>");
        }
      }
    }
    await page.evaluate(() => { widget.settings.generation_mode="qwen_image21"; widget.syncStandaloneGenerationControls(); });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
  });
}
