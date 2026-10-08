import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const modes = await readFile(new URL("../../web/unicanvas/modes.mjs", import.meta.url), "utf8");
const widgetSource = await readFile(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const widgetStyles = widgetSource.match(/const STYLES = `([\s\S]*?)`;/)[1];
const theme = await readFile(new URL("../../web/unicanvas/standalone_theme.mjs", import.meta.url), "utf8");

for (const location of ["left", "right"]) {
  test(`fixture: native menus and resizable console coexist with standalone (${location} rail)`, async ({ page }, testInfo) => {
    test.setTimeout(20000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width:1200, height:800 });
    await page.route("http://native-chrome.test/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("modes.mjs")) return route.fulfill({ contentType:"text/javascript", body:modes });
      if (path.endsWith("standalone_theme.mjs")) return route.fulfill({ contentType:"text/javascript", body:theme });
      if (path === "/scripts/app.js") return route.fulfill({ contentType:"text/javascript", body:`export const app = {
        extensionManager:{ registerSidebarTab(tab) { window.tab = tab; } }
      };` });
      return route.fulfill({ contentType:"text/html", body:`<!doctype html>
        <style>
          body { margin:0; background:#222; color:white; }
          #overlay { position:absolute; inset:0; z-index:999; pointer-events:none; display:flex; flex-direction:${location === "left" ? "row" : "row-reverse"}; }
          nav { width:56px; flex-shrink:0; pointer-events:auto; background:#333; }
          nav button { display:block; width:56px; height:48px; }
          #splitter { display:flex; flex:1; min-width:0; }
          .side-bar-panel { width:200px; background:#444; pointer-events:auto; }
          #center { display:flex; flex:1; flex-direction:column; }
          .graph-canvas-panel { flex:1; position:relative; }
          .bottom-panel { height:200px; flex-shrink:0; background:#454545; pointer-events:auto; }
          .p-splitter-gutter { height:8px; flex-shrink:0; pointer-events:auto; }
          #help-menu { position:absolute; top:48px; ${location}:56px; width:220px; height:140px; background:#444; pointer-events:auto; }
          #settings { position:fixed; inset:150px; z-index:1000; background:#555; }
          ${widgetStyles}
          .vnccs-uc-left { position:relative; }
          #last-action { position:absolute; bottom:8px; left:8px; }
          [hidden] { display:none !important; }
        </style>
        <div id="overlay">
          <nav class="side-tool-bar-container">
            <button class="side-bar-button-selected" data-testid="vnccs-unicanvas-standalone-tab-button">UniCanvas</button>
            <button id="help" onclick="document.querySelector('#help-menu').hidden=false">Help</button>
            <button id="console" onclick="toggleDock()">Console</button>
            <button id="shortcuts" onclick="toggleDock()">Shortcuts</button>
            <button onclick="document.querySelector('#settings').hidden=false">Settings</button>
            <div id="help-menu" hidden><button id="help-link">Documentation</button></div>
          </nav>
          <div id="splitter"><aside class="side-bar-panel"><div id="mount"></div></aside>
            <div id="side-gutter" class="p-splitter-gutter" style="width:8px;height:auto"></div><div id="center"><div class="graph-canvas-panel"><button id="graph-action">Graph action</button></div>
              <div id="gutter" class="p-splitter-gutter" hidden></div>
              <div class="bottom-panel" hidden><input aria-label="Console input"><button id="close-dock" onclick="toggleDock()">Close dock</button></div>
            </div>
          </div>
        </div>
        <div id="settings" role="dialog" hidden><input aria-label="Setting"><button id="close-settings" onclick="this.parentElement.hidden=true">Close settings</button></div>
        <script>
          function toggleDock() { for (const el of document.querySelectorAll('.bottom-panel, #gutter')) el.hidden = !el.hidden; }
          document.querySelector('#help-link').onkeydown = event => { if (event.key === 'Escape') document.querySelector('#help-menu').hidden=true; };
          window.nativeKeys = [];
          window.addEventListener('keydown', event => nativeKeys.push(event.key));
        </script>
        <script type="module">
          import { registerUniCanvasStandaloneSidebarTab } from '/extensions/utils/unicanvas/modes.mjs';
          class Widget {
            constructor() {
              window.widget=this; this.settings={}; this.layers=[]; this.tool='move'; this.resizeCount=0; this.undoCount=0;
              this.container=document.createElement('div'); this.container.className='vnccs-unicanvas';
              this.container.innerHTML='<div class="vnccs-uc-left"><button id="last-action">Last action</button></div><div class="vnccs-uc-bottom"><button>Fit</button></div><div class="vnccs-uc-stage-wrap"><canvas class="vnccs-uc-stage"></canvas></div><div class="vnccs-uc-side"></div>';
              this.canvas=this.container.querySelector('canvas'); this.side=this.container.querySelector('.vnccs-uc-side');
              this.drawBtn=document.createElement('button'); this.donateLink=document.createElement('a');
            }
            _button(text, cls, callback) { const b=document.createElement('button'); b.textContent=text; b.className=cls; b.onclick=callback; return b; }
            resize() { this.resizeCount++; this.canvas.height=this.canvas.parentElement.clientHeight; } requestRender() {} setStatus() {} dispose() {}
            undo() { this.undoCount++; } redo() {} buildSerializedState() { return { layers:[] }; }
          }
          window.handle=registerUniCanvasStandaloneSidebarTab(Widget);
          tab.render(document.querySelector('#mount'));
        </script>` });
    });
    await page.goto("http://native-chrome.test/");
    const shell = page.locator(".vnccs-uc2-standalone-shell");
    await expect(shell).toBeVisible();
    await expect.poll(() => shell.evaluate(el => el.getBoundingClientRect().height)).toBe(800);
    // Native ancestors can establish a fixed-position containing block below a header.
    await page.locator('#overlay').evaluate(el => { el.style.top='24px'; el.style.transform='translateZ(0)'; });
    await expect.poll(() => shell.evaluate(el => el.getBoundingClientRect().top)).toBe(24);
    await expect.poll(() => shell.evaluate(el => el.getBoundingClientRect().height)).toBe(776);
    await page.locator('#overlay').evaluate(el => { el.style.top='0'; });
    await expect.poll(() => shell.evaluate(el => el.getBoundingClientRect().height)).toBe(800);
    // Native menus overlap the workspace intentionally, and must receive clicks/keys.
    await page.getByRole("button", { name:"Help", exact:true }).click();
    await page.getByRole("button", { name:"Documentation", exact:true }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#help-menu")).toBeHidden();
    await page.getByRole("button", { name:"Settings", exact:true }).click();
    await page.getByRole("textbox", { name:"Setting", exact:true }).fill("value");
    await page.getByRole("button", { name:"Close settings", exact:true }).click();
    await page.getByRole("button", { name:"Console", exact:true }).click();
    await expect.poll(() => shell.evaluate(el => el.getBoundingClientRect().bottom)).toBe(592);
    const workspaceGeometry = () => page.evaluate(() => {
      const rect = el => { const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,bottom:r.bottom,height:r.height}; };
      return { shell:rect(document.querySelector('.vnccs-uc2-standalone-shell')), dock:rect(document.querySelector('.bottom-panel')),
        stage:rect(widget.canvas.parentElement), panels:[widget.container,...widget.container.querySelectorAll('.vnccs-uc-left,.vnccs-uc-side,.vnccs-uc-stage-wrap')].map(rect) };
    });
    const opened=await workspaceGeometry();
    expect(opened.dock.left).toBe(opened.shell.left);
    expect(opened.dock.right).toBe(opened.shell.right);
    for (const panel of opened.panels) expect(panel.bottom).toBe(opened.shell.bottom);
    await page.getByRole("textbox", { name:"Console input", exact:true }).fill("command");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => nativeKeys.includes("Enter"))).toBe(true);
    const beforeResize = await page.evaluate(() => widget.resizeCount);
    // Layout must update while the dock changes, without a window resize or mouse release.
    await page.locator(".bottom-panel").evaluate(el => { el.style.height="300px"; });
    await expect.poll(() => shell.evaluate(el => el.getBoundingClientRect().bottom)).toBe(492);
    await expect.poll(() => page.evaluate(() => widget.resizeCount)).toBeGreaterThan(beforeResize);
    const resized=await workspaceGeometry();
    for (const panel of resized.panels) expect(panel.bottom).toBe(resized.shell.bottom);
    await expect.poll(() => page.locator('canvas').evaluate(el => el.height)).toBe(resized.stage.height);
    await page.locator("#last-action").click();
    expect((await page.locator("#last-action").boundingBox()).y).toBeLessThan(492);
    await page.screenshot({ path:testInfo.outputPath("after.png") });
    await page.getByRole("button", { name:"Close dock", exact:true }).click();
    await expect.poll(() => shell.evaluate(el => el.getBoundingClientRect().height)).toBe(800);
    await page.getByRole("button", { name:"Shortcuts", exact:true }).click();
    await expect.poll(() => shell.evaluate(el => el.getBoundingClientRect().height)).toBe(492);
    await page.getByRole("button", { name:"Close dock", exact:true }).click();
    await page.locator("canvas").click();
    await page.keyboard.press("Control+z");
    expect(await page.evaluate(() => widget.undoCount)).toBe(1);
    await page.evaluate(() => handle.dispose());
    await expect(shell).toHaveCount(0);
    await expect(page.locator("#graph-action")).toBeVisible();
    await expect(page.locator(".side-bar-panel")).toBeVisible();
    await expect(page.locator("#side-gutter")).toBeVisible();
    await page.locator(".bottom-panel").evaluate(el => { el.style.height="250px"; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(errors).toEqual([]);
  });
}
