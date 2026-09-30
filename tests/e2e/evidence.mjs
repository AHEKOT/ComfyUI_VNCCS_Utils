#!/usr/bin/env node
// Evidence capture for UI changes (owner rule): Before/After pairs (same crop,
// same scale, labels exactly "Before"/"After"), standalone After, measured geometry.
import { chromium } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = Object.fromEntries(args.reduce((acc, cur, i) => {
  if (cur.startsWith("--")) acc.push([cur.slice(2), args[i + 1] ?? ""]);
  return acc;
}, []));
const topic = opt.topic || "topic";
const phase = opt.phase || "after"; // before | after | compose
const baseURL = process.env.COMFYUI_URL || "http://localhost:8188";
const outDir = resolve(import.meta.dirname, "evidence", topic);
// Optional: reuse a preinstalled Chromium instead of the version pinned by @playwright/test.
const launchOptions = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};
await mkdir(outDir, { recursive: true });

if (phase === "compose") {
  const before = await readFile(resolve(outDir, "before.png"));
  const after = await readFile(resolve(outDir, "after.png"));
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
  await page.setContent(`<body style="margin:0;background:#111;display:flex;gap:8px;padding:8px;font:700 22px sans-serif;color:#fff">
    <style>img{display:block;max-width:calc(50vw - 16px);height:auto}</style>
    <figure style="margin:0"><figcaption>Before</figcaption><img src="data:image/png;base64,${before.toString("base64")}"></figure>
    <figure style="margin:0"><figcaption>After</figcaption><img src="data:image/png;base64,${after.toString("base64")}"></figure>
  </body>`);
  await page.locator("body").screenshot({ path: resolve(outDir, `${topic}.pair.png`) });
  await page.locator("figure").nth(1).screenshot({ path: resolve(outDir, `${topic}.after.png`) });
  await browser.close();
  console.log(`composed ${topic}.pair.png`);
  process.exit(0);
}

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// The setting is forced here so older builds without the default still show the tab.
await page.request.post(`${baseURL}/api/settings/VNCCS.UniCanvas.StandaloneSidebar`, { data: true }).catch(() => {});
await page.goto(baseURL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
await page.waitForTimeout(2_000);
for (let i = 0; i < 3; i += 1) await page.keyboard.press("Escape");
if (topic === "config-override") {
  // Graph scenario: a VNCSS Config node linked to a UniCanvas node.
  await page.evaluate(() => {
    const { app, LiteGraph } = window;
    app.graph.clear();
    const config = LiteGraph.createNode("VNCCS_Config");
    config.pos = [40, 80];
    app.graph.add(config);
    const canvas = LiteGraph.createNode("VNCCS_UniCanvas");
    canvas.pos = [420, 40];
    app.graph.add(canvas);
    config.connectByType(0, canvas, "VNCSS_CONFIG");
    config.configWidget.state.loras.push({ name: "", strength: 0.8, clip_strength: null, enabled: true });
    config.configWidget.renderLoras();
    app.canvas.ds.offset = [0, 0];
    app.canvas.ds.scale = 1;
    app.graph.setDirtyCanvas(true, true);
  });
  await page.waitForTimeout(4_000);
} else {
  await page
    .locator('[data-testid="vnccs-unicanvas-standalone-tab-button"], .vnccs-unicanvas-sidebar-icon, [data-label="Unicanvas"], button[title="Unicanvas"]')
    .first()
    .click();
  await page.waitForSelector(".vnccs-uc-left", { timeout: 30_000 });
}
if (topic === "pose-editor") {
  // An image layer under the pose, then the pose editor: the new build opens it with the Pose
  // Studio tool, older builds with "Add pose layer".
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('button[title="Import image"]').first().click(),
  ]);
  await chooser.setFiles(resolve(import.meta.dirname, "fixtures", "backdrop.png"));
  await page.waitForTimeout(2_500);
  const poseTool = page.locator('.vnccs-uc-layers-section [title="Add pose layer"]');
  if (await poseTool.count()) await poseTool.click();
  else await page.locator('[title="Add pose layer"]').first().click();
  await page.waitForTimeout(25_000);
}
// Scenario per topic keeps crops identical between before/after (same locator).
const shots = {
  "mannequin-options": ".vnccs-uc-left",
  // The settings topic must frame the corner-bar gear and the popover anchored to
  // it, so it crops the whole widget root - whose geometry is identical in both
  // phases, which keeps the before/after crops aligned.
  "settings-panel": ".vnccs-unicanvas",
  "pose-editor": ".vnccs-unicanvas",
  "config-override": "body",
  "icons": "body",
};
// The settings popover exists only once the gear is clicked. The crop still frames
// the pre-change popover, which the old code parked at the widget's top-left.
if (topic === "settings-panel") await page.locator('[title="Settings"]').first().click();
const target = page.locator(shots[topic] || ".vnccs-uc-left").first();
// Fixed page crops keep both phases aligned where the subject spans several roots.
const clips = {
  icons: { x: 0, y: 0, width: 420, height: 760 },
  "config-override": { x: 0, y: 40, width: 700, height: 960 },
};
if (clips[topic]) await page.screenshot({ path: resolve(outDir, `${phase}.png`), clip: clips[topic] });
else await target.screenshot({ path: resolve(outDir, `${phase}.png`) });
const geometry = await target.evaluate((el, measureSelector) => {
  // Measure what the topic changes: the settings popover. Before the anchoring
  // change it carries no class yet, so fall back to the legacy inline-styled panel.
  const legacy = () => [...document.querySelectorAll(".vnccs-unicanvas > div")].find(
    (node) => node.style.position === "absolute" && (node.textContent || "").startsWith("UniCanvas settings"));
  const subject = (measureSelector ? (document.querySelector(measureSelector) || legacy()) : el) || el;
  const r = subject.getBoundingClientRect();
  const s = getComputedStyle(subject);
  return { x: r.x, y: r.y, width: r.width, height: r.height, fontSize: s.fontSize, zIndex: s.zIndex, background: s.background };
}, {
  "settings-panel": ".vnccs-uc-settings-popover",
  "config-override": ".vnccs-config-ui",
  icons: ".vnccs-uc-tools",
}[topic] || null);
await writeFile(resolve(outDir, `${phase}.geometry.json`), JSON.stringify(geometry, null, 2));
await browser.close();
console.log(`captured ${phase}.png for ${topic}`);
