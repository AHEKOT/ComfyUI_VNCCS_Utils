import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { STANDALONE_STYLES } from "../../web/unicanvas/standalone_theme.mjs";

const source = await readFile(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const scaleModule = await readFile(new URL("../../web/unicanvas/scale_edit.mjs", import.meta.url), "utf8");
const styles = source.match(/const STYLES = `([\s\S]*?)`;/)[1];
const methods = source.slice(source.indexOf("  getOptimalDimension() {"), source.indexOf("  getDenoiseControlSetting() {"));
const listeners = source.slice(source.indexOf('    this.left.addEventListener("input", (e) => {'), source.indexOf("    this.setTool(this.tool, true);"));
const control = source.match(/<label class="vnccs-uc-infer-scale">[^\n]+/)[0].replace(/\$\{.*?\}/, "1");

test("fixture: inference scale matches VNCCS steps and updates during dragging and typing", async ({ page }, testInfo) => {
  test.setTimeout(20000);
  page.on("pageerror", error => { throw error; });
  await page.setViewportSize({ width:900, height:600 });
  await page.route("http://inference-scale.test/**", route => {
    if (route.request().url().endsWith("scale_edit.mjs")) return route.fulfill({ contentType:"text/javascript", body:scaleModule });
    return route.fulfill({ contentType:"text/html", body:`<!doctype html>
      <style>
        :root { --base-background:#202020; --interface-panel-surface:#282828; --secondary-background:#353535;
          --interface-stroke:#4e4e4e; --base-foreground:#fff; --muted-foreground:#aaa;
          --primary-background:#236692; --primary-fg:#fff; --p-primary-color:#3485bb; color-scheme:dark; }
        ${styles}${STANDALONE_STYLES}
        body { margin:0; } #host { display:block; width:450px; height:100vh; padding:16px; }
      </style>
      <div id="host" class="vnccs-unicanvas vnccs-uc-standalone"><div class="vnccs-uc-left">
        <p>Presets</p>${control}<p>Custom</p>${control}
      </div></div>
      <script type="module">
        import { installInferenceScaleEdit, inferenceScaleMegapixels, inferenceScaleFromMegapixels,
          INFERENCE_SCALE_MP_MIN, INFERENCE_SCALE_MP_MAX, INFERENCE_SCALE_MP_STEP } from "/scale_edit.mjs";
        const NUMERIC_SETTINGS = new Set(["inference_scale"]), MODEL_MEMORY_ASSET_FIELDS = {};
        class Host {
          constructor() {
            this.standalone=true; this.container=document.querySelector("#host"); this.left=this.container.firstElementChild;
            this.settings={inference_scale:1}; this.bbox={width:1024,height:1024}; this.saves=0;
            ${listeners}
          }
          parseNumericInput(input) { return Number(input.value); }
          formatSettingNumber(value) { return String(value); }
          syncSettingsToWidget() { this.saves++; }
          clearInputHistoryMarker() {} requestRender() {}
          getGridSize() { return 8; }
          roundToMultiple(value, grid) { return Math.round(value/grid)*grid; }
          ${methods}
        }
        window.widget=new Host(); widget.syncInferenceControls(); installInferenceScaleEdit(widget);
      </script>` });
  });
  await page.goto("http://inference-scale.test/");
  const sliders = page.locator('[data-setting="inference_scale"]');
  const labels = page.locator("[data-inference-size]");
  for (const slider of await sliders.all()) {
    await expect(slider).toHaveAttribute("min", "1");
    await expect(slider).toHaveAttribute("max", "4");
    await expect(slider).toHaveAttribute("step", "0.1");
  }
  await sliders.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(labels).toHaveText(["1.1 MP", "1.1 MP"]);
  await expect(sliders.last()).toHaveValue("1.1");
  const bounds = await sliders.first().boundingBox();
  await page.mouse.move(bounds.x+8, bounds.y+bounds.height/2);
  await page.mouse.down();
  await page.mouse.move(bounds.x+bounds.width*0.7, bounds.y+bounds.height/2, { steps:5 });
  const dragged = Number(await sliders.first().inputValue());
  expect(dragged).toBeGreaterThan(2);
  await expect(labels).toHaveText([`${dragged.toFixed(1)} MP`, `${dragged.toFixed(1)} MP`]);
  await expect(sliders.last()).toHaveValue(String(dragged));
  expect(await page.evaluate(() => widget.settings.inference_scale**2)).toBeCloseTo(dragged, 10);
  await page.mouse.up();
  await sliders.first().focus();
  await page.keyboard.press("End");
  await expect(labels).toHaveText(["4.0 MP", "4.0 MP"]);
  expect(await page.evaluate(() => widget.getInferenceSize())).toEqual({ width:2048, height:2048 });
  await labels.first().dblclick();
  const exact = page.getByRole("textbox", { name:"Inference scale", exact:true });
  await exact.fill("1,35");
  await expect(labels.last()).toHaveText("1.4 MP");
  await expect(sliders.last()).toHaveValue("1.4");
  await exact.press("Escape");
  await expect(labels).toHaveText(["4.0 MP", "4.0 MP"]);
  await labels.first().dblclick();
  await exact.fill("1.5");
  await exact.press("Enter");
  await expect(labels).toHaveText(["1.5 MP", "1.5 MP"]);
  await expect(sliders.first()).toHaveValue("1.5");
  expect(await page.evaluate(() => widget.getInferenceSize())).toEqual({ width:1256, height:1256 });
  await page.screenshot({ path:testInfo.outputPath("after.png") });
});
