import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { STANDALONE_STYLES } from "../../web/unicanvas/standalone_theme.mjs";

test.setTimeout(20000);

const source = await readFile(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const styles = source.match(/const STYLES = `([\s\S]*?)`;/)[1];
const cropMethod = source.slice(source.indexOf("  cloneCanvasCrop("), source.indexOf("  expandCanvasCrop("));
const buttonMethod = source.slice(source.indexOf("  _button("), source.indexOf("  get editingBlocked()"));
const outputMethods = source.slice(source.indexOf("  downloadBlob("), source.indexOf("  startDrawProgressPolling("));
const progressMarkup = source.match(/this\.generationProgress\.innerHTML = `([\s\S]*?)`;/)[1];

async function fixture(page, kind = "raster", clipboard = "success") {
  page.on("pageerror", error => { throw error; });
  const origin = `${clipboard === "insecure" ? "http" : "https"}://layer-actions.test`;
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/scripts/app.js")) return route.fulfill({ contentType:"text/javascript", body:"export const app = {};" });
    const prefix = "/extensions/VNCCS_Utils/web/";
    if (path.startsWith(prefix)) return route.fulfill({ contentType:"text/javascript",
      body:await readFile(new URL(`../../web/${path.slice(prefix.length)}`, import.meta.url), "utf8") });
    if (path.startsWith("/vnccs/unicanvas/save_output")) throw new Error("Layer actions must not save on the server");
    return route.fulfill({ contentType:"text/html", body:`<!doctype html><style>
      :root { --base-background:#171717; --interface-panel-surface:#252525; --secondary-background:#333;
        --interface-stroke:#4e4e4e; --base-foreground:#fff; --muted-foreground:#aaa; --p-primary-color:#60a5fa; }
      ${styles}${STANDALONE_STYLES}
      body { margin:0; } #host { width:700px; height:550px; display:block; }
      .vnccs-uc-generation-progress { height:34px; } .vnccs-uc-layer-menu { color:var(--uc-text); }
    </style><div id="host" class="vnccs-unicanvas vnccs-uc-standalone">
      <div class="vnccs-uc-generation-progress">${progressMarkup}</div>
      <div id="layers"><button data-layer-id="image">Layer 2</button></div>
    </div><script type="module">
      import { installUniCanvasLayerTools } from '/extensions/VNCCS_Utils/web/unicanvas/layer_tools.mjs';
      import { showUniCanvasToast, ensureUniCanvasModeStyles } from '/extensions/VNCCS_Utils/web/unicanvas/modes.mjs';
      ensureUniCanvasModeStyles();
      const nativeCanvas = (size) => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgba(200, 100, 50, .5)'; ctx.fillRect(0, 0, size, size);
        return canvas;
      };
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 6;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgba(20, 40, 60, .5)'; ctx.fillRect(1, 1, 2, 2);
      window.layer = { id:'image', name:'Layer 2', type:'raster', canvas };
      ${kind === "hires" ? "layer.hiresCanvas = nativeCanvas(4); layer.hiresRect = { x:0, y:0, width:2, height:2 };" : ""}
      ${kind === "panorama" ? "layer.panoramaCanvas = nativeCanvas(8);" : ""}
      const prototype = (class { ${cropMethod}${buttonMethod}${outputMethods} }).prototype;
      window.widget = Object.assign(Object.create(prototype), {
        container:document.querySelector('#host'), layerList:document.querySelector('#layers'), layers:[layer],
        generationProgress:document.querySelector('.vnccs-uc-generation-progress'), settings:{},
        panorama:${kind === "panorama" ? "{}" : "null"},
        getLayerAlphaBounds:() => ({ x:1, y:1, width:2, height:2 }), configureImageContext:ctx => ctx,
        _eventAbortController:new AbortController(),
      });
      window.encodingFinished = false;
      const originalToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, type) {
        setTimeout(() => originalToBlob.call(this, blob => {
          window.encodingFinished = true; callback(${clipboard === "encoding-failed" ? "null" : "blob"});
        }, type), 50);
      };
      ${clipboard === "insecure" ? "" : `Object.defineProperty(navigator, 'clipboard', { configurable:true, value:${clipboard === "unsupported" ? "undefined" : `{
        async write(items) {
          window.writeStartedBeforeEncoding = !window.encodingFinished;
          if (!window.writeStartedBeforeEncoding) throw new DOMException('User gesture expired', 'NotAllowedError');
          ${clipboard === "denied" ? "throw new DOMException('Clipboard permission denied', 'NotAllowedError');" : ""}
          const blob = await items[0].getType('image/png');
          const image = await createImageBitmap(blob);
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
          window.copiedImage = { width:image.width, height:image.height, pixel:[...ctx.getImageData(0, 0, 1, 1).data] };
        }
      }`}});`}
      installUniCanvasLayerTools(widget);
      window.ready = true;
    </script>` });
  });
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => window.ready, null, { timeout:5000 });
  await page.getByRole("button", { name:"Layer 2", exact:true }).click({ button:"right" });
}

test("clipboard write starts during the click and preserves native RGBA pixels", async ({ page }, testInfo) => {
  await fixture(page, "hires");
  await page.getByRole("button", { name:"Copy to clipboard", exact:true }).click();
  await expect.poll(() => page.evaluate(() => window.copiedImage)).toEqual({ width:4, height:4, pixel:[199, 100, 50, 128] });
  expect(await page.evaluate(() => window.writeStartedBeforeEncoding)).toBe(true);
  await expect(page.getByRole("status")).toContainText("Layer copied to clipboard");
  await page.locator("#host").screenshot({ path:testInfo.outputPath("after.png") });
});

for (const failure of ["unsupported", "denied", "insecure"]) {
  test(`clipboard fallback offers native image copy (${failure})`, async ({ page }, testInfo) => {
    await fixture(page, "hires", failure);
    await page.getByRole("button", { name:"Copy to clipboard", exact:true }).click();
    const dialog = page.getByRole("dialog", { name:"Copy image", exact:true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Right-click the image below and choose Copy image");
    const image = dialog.getByRole("img", { name:"Layer 2", exact:true });
    await expect.poll(() => image.evaluate(element => element.naturalWidth)).toBe(4);
    expect(await image.evaluate(element => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles:true, cancelable:true })))).toBe(true);
    if (failure === "insecure") expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    await expect(page.getByRole("status")).toHaveCount(0);
    await page.locator("#host").screenshot({ path:testInfo.outputPath("after.png") });
    const bounds = await dialog.boundingBox();
    await writeFile(testInfo.outputPath("after.geometry.json"), JSON.stringify(bounds, null, 2));
    await page.locator("#host").evaluate(element => { element.style.width = "320px"; element.style.height = "350px"; });
    const geometry = await dialog.evaluate(element => {
      const bounds = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom }; };
      return { dialog:bounds(element), host:bounds(document.querySelector("#host")), close:bounds(element.querySelector("button")) };
    });
    expect(geometry.dialog.x).toBeGreaterThanOrEqual(geometry.host.x);
    expect(geometry.dialog.right).toBeLessThanOrEqual(geometry.host.right);
    expect(geometry.dialog.y).toBeGreaterThanOrEqual(geometry.host.y);
    expect(geometry.dialog.bottom).toBeLessThanOrEqual(geometry.host.bottom);
    expect(geometry.close.bottom).toBeLessThanOrEqual(geometry.dialog.bottom);
    await page.locator("#host").screenshot({ path:testInfo.outputPath("after-narrow.png") });
    await writeFile(testInfo.outputPath("after-narrow.geometry.json"), JSON.stringify(geometry, null, 2));
    await expect(dialog.getByRole("button", { name:"Close", exact:true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(image).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name:"Layer 2", exact:true }).click({ button:"right" });
    await page.getByRole("button", { name:"Copy to clipboard", exact:true }).click();
    await expect(dialog).toBeVisible();
    const url = await image.getAttribute("src");
    await page.evaluate(() => { widget._disposed = true; widget._eventAbortController.abort(); });
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, url)).toBe(true);
  });
}

for (const action of ["Copy to clipboard", "Save image"]) {
  test(`PNG encoding failure is visible (${action})`, async ({ page }) => {
    await fixture(page, "raster", "encoding-failed");
    await page.getByRole("button", { name:action, exact:true }).click();
    await expect(page.getByRole("alert")).toContainText(action === "Save image" ? "Image download failed" : "Clipboard copy failed");
    await expect(page.getByRole("alert")).toContainText("PNG encoding failed");
  });
}

for (const [kind, size, pixel] of [["raster", 2, [20, 40, 60, 128]], ["hires", 4, [199, 100, 50, 128]], ["panorama", 8, [199, 100, 50, 128]]]) {
  test(`Save image downloads the selected layer PNG (${kind})`, async ({ page }) => {
    await fixture(page, kind, kind === "raster" ? "insecure" : "success");
    const downloaded = page.waitForEvent("download", { timeout:5000 });
    await page.getByRole("button", { name:"Save image", exact:true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("Layer 2.png");
    expect(await download.failure()).toBeNull();
    const bytes = await readFile(await download.path());
    const decoded = await page.evaluate(async base64 => {
      const raw = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const image = await createImageBitmap(new Blob([raw], { type:"image/png" }));
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
      return { width:image.width, height:image.height, pixel:[...ctx.getImageData(0, 0, 1, 1).data] };
    }, bytes.toString("base64"));
    expect(decoded).toEqual({ width:size, height:size, pixel });
    await expect(page.getByRole("status")).toContainText("Image downloaded");
  });
}

test("PNG downloads sanitize the layer name", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { layer.name = 'Folder/Layer:2.png'; });
  const downloaded = page.waitForEvent("download", { timeout:5000 });
  await page.getByRole("button", { name:"Save image", exact:true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("Folder_Layer_2.png");
  expect(await download.failure()).toBeNull();
});
