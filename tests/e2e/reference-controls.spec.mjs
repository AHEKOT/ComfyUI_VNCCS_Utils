import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { STANDALONE_STYLES } from "../../web/unicanvas/standalone_theme.mjs";

const source = await readFile(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const styles = source.match(/const STYLES = `([\s\S]*?)`;/)[1];
const controls = source.slice(source.indexOf('      <div class="vnccs-uc-h3-panel" data-h3-panel'), source.indexOf('      <div class="vnccs-uc-lora-stack"'));
const sync = source.slice(source.indexOf("  syncStandaloneGenerationControls() {"), source.indexOf("  presetRuntimeSettingKeys(preset) {"));
const refs = source.slice(source.indexOf("  editReferenceImages() {"), source.indexOf("  // Anchor a popover below"));

for (const width of [900, 1600]) {
  test(`fixture: reference controls align and open at canvas bottom left (${width}px)`, async ({ page }, testInfo) => {
    test.setTimeout(20000);
    page.on("pageerror", error => { throw error; });
    await page.setViewportSize({ width, height:800 });
    await page.route("http://reference-controls.test/**", route => route.fulfill({ contentType:"text/html", body:`<!doctype html>
      <style>
        :root { --base-background:#202020; --interface-panel-surface:#282828; --secondary-background:#353535;
          --secondary-background-hover:#444; --interface-stroke:#4e4e4e; --base-foreground:#fff;
          --muted-foreground:#aaa; --primary-background:#236692; --primary-fg:#fff; --p-primary-color:#3485bb; color-scheme:dark; }
        ${styles}${STANDALONE_STYLES}
        body { margin:0; } #host { width:100vw; height:100vh; grid-template-columns:336px minmax(0,1fr); grid-template-rows:1fr; }
        #host > .vnccs-uc-left, #host > .vnccs-uc-stage-wrap { grid-row:1; }
      </style><div id="host" class="vnccs-unicanvas vnccs-uc-standalone"><div class="vnccs-uc-left">${controls}</div><div class="vnccs-uc-stage-wrap"></div></div>
      <script>
        const getUniCanvasModelModule = key => ({ key, isEditModel:["qwen_image21", "minimax_h3", "flux_klein", "krea2_edit"].includes(key) });
        const referenceSlotName = (_descriptors, _mode, n) => ({ text:"<image" + n + ">" });
        const referenceConventionHint = () => "Working area is the first reference.";
        class Host {
          constructor() {
            this.standalone = true; this.container = document.querySelector("#host"); this.stageWrap = document.querySelector(".vnccs-uc-stage-wrap");
            this.settings = { generation_mode:"qwen_image21", steps:6, minimax_h3_steps:20, edit_use_layers_as_reference:true,
              edit_reference_images:["data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="] };
          }
          _button(text, className, click, title) { const b = document.createElement("button"); b.type="button"; b.textContent=text; b.className=className; b.title=title || text; b.onclick=click; return b; }
          getModelBase() { return this.settings.generation_mode; }
          syncSettingsToWidget() {} scheduleStateUpload() {} setStatus() {}
          ${sync}${refs}
        }
        window.widget = new Host(); widget.syncStandaloneGenerationControls();
        document.querySelector("[data-standalone-refs]").onclick = () => widget.openEditReferenceImages();
      </script>` }));
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
    await expect(button).toBeVisible();
    await button.click();
    const dialog = page.getByRole("dialog", { name:"Reference images", exact:true });
    await expect(dialog).toBeVisible();
    const toggle = dialog.getByRole("button", { name:"Use Layers as 1st reference image", exact:true });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("img")).toHaveAttribute("alt", "<image2>");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.getByRole("img")).toHaveAttribute("alt", "<image1>");
    const bounds = await page.evaluate(() => {
      const panel = document.querySelector("[data-edit-refs-popover]").getBoundingClientRect();
      const stage = widget.stageWrap.getBoundingClientRect();
      return { left:panel.left-stage.left, bottom:stage.bottom-panel.bottom, width:panel.width, stageWidth:stage.width };
    });
    expect(bounds.left).toBe(8); expect(bounds.bottom).toBe(8);
    expect(bounds.width).toBeLessThanOrEqual(bounds.stageWidth-8);
    await toggle.click();
    await page.screenshot({ path:testInfo.outputPath("after.png") });
    for (const family of ["minimax_h3", "flux_klein", "krea2_edit", "sdxl"]) {
      await page.evaluate(family => { widget.settings.generation_mode=family; widget.syncStandaloneGenerationControls(); }, family);
      await expect(dialog).toBeHidden();
      if (family === "sdxl") await expect(button).toBeHidden();
      else await expect(button).toBeVisible();
    }
  });
}
