import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { STANDALONE_STYLES } from "../../web/unicanvas/standalone_theme.mjs";
import { openUnicanvas } from "./helpers/app.mjs";

const widgetSource = await readFile(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const poseSource = await readFile(new URL("../../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const originalStyles = source => source.match(/const STYLES = `([\s\S]*?)`;/)[1];

// Exercise the actual CSS cascade without a ComfyUI server or model dependencies.
const controls = `
  <div class="vnccs-uc-draw-control"><button class="vnccs-uc-btn primary">Generate</button><input class="vnccs-uc-input vnccs-uc-batch-input" value="1"></div>
  <div class="vnccs-uc-side-control vnccs-uc-denoise-control"><span>Denoise</span><input class="vnccs-uc-range" type="range"><input class="vnccs-uc-input" value="0.65"></div>
  <div class="vnccs-uc-section vnccs-uc-parameters-section"><div class="vnccs-uc-section-head">Parameters</div><div class="vnccs-uc-stack">
    <label class="vnccs-uc-field">Prompt<textarea class="vnccs-uc-textarea">A character in a landscape</textarea></label>
    <div class="vnccs-uc-model-tabs"><button class="vnccs-uc-model-tab active">Presets</button><button class="vnccs-uc-model-tab">Custom</button></div>
    <div class="vnccs-uc-model-card turbo missing"><span class="vnccs-uc-model-card-name">Example model</span></div>
    <div class="vnccs-uc-generation-grid"><label class="vnccs-uc-field">Sampler<select class="vnccs-uc-select"><option>Euler</option></select></label><label class="vnccs-uc-field">CFG<input class="vnccs-uc-input" value="1"></label></div>
    <div class="vnccs-uc-seed-row"><input class="vnccs-uc-input" value="42"><button class="vnccs-uc-icon vnccs-uc-seed-dice active">S</button></div>
    <div class="vnccs-uc-layer active locked"><span>Layer</span></div>
  </div></div>`;

for (const width of [900, 1600, 3440]) {
  test(`CSS fixture: native standalone density and node isolation at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(`<style>
      :root { --base-background:#202020; --interface-panel-surface:#282828; --secondary-background:#353535;
        --secondary-background-hover:#444; --interface-panel-selected-surface:#555; --interface-stroke:#4e4e4e;
        --base-foreground:#fff; --muted-foreground:#aaa; --primary-background:#236692; --primary-fg:#fff;
        --p-primary-color:#3485bb; --font-inter:Arial,sans-serif; color-scheme:dark; }
      body { margin:0; }
      #tab { height:100vh; }
      #node { position:absolute; left:-10000px; width:1500px; height:800px; }
      ${originalStyles(widgetSource)}
      ${STANDALONE_STYLES}
      /* Pose Studio injects styles lazily, after the standalone theme. */
      ${originalStyles(poseSource)}
    </style><div id="tab" class="vnccs-unicanvas vnccs-uc-standalone" style="--vnccs-uc-ui-scale:2.5">
      <div class="vnccs-uc-left">${controls}</div>
      <div class="vnccs-uc-bottom"><button class="vnccs-uc-btn">Fit</button></div>
      <div class="vnccs-uc-stage-wrap"><canvas class="vnccs-uc-stage"></canvas><div class="vnccs-uc-tools"><button class="vnccs-uc-icon active"><svg viewBox="0 0 24 24"><path d="M4 4l16 16"/></svg></button></div></div>
      <div class="vnccs-uc-side"><div class="vnccs-uc-pose-side"><div class="vnccs-ps-section"><div class="vnccs-ps-section-header">Pose</div><button class="vnccs-ps-btn primary">Apply</button></div></div></div>
    </div><div id="node" class="vnccs-unicanvas" style="--vnccs-uc-ui-scale:2.5"><div class="vnccs-uc-left">${controls}</div></div>`);

    const geometry = await page.evaluate(() => {
      const rect = selector => { const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height }; };
      const style = selector => { const s = getComputedStyle(document.querySelector(selector)); return { zoom:s.zoom, background:s.backgroundColor, image:s.backgroundImage, color:s.color, font:s.fontSize }; };
      return {
        left:rect("#tab .vnccs-uc-left"), right:rect("#tab .vnccs-uc-side"),
        button:rect("#tab .vnccs-uc-draw-control button"), batch:rect("#tab .vnccs-uc-batch-input"),
        seed:rect("#tab .vnccs-uc-seed-row input"), dice:rect("#tab .vnccs-uc-seed-dice"),
        tool:rect("#tab .vnccs-uc-tools button"), input:rect("#tab .vnccs-uc-generation-grid input"), select:rect("#tab select"),
        root:style("#tab"), node:style("#node"), nodeLeft:style("#node .vnccs-uc-left"),
        primary:style("#tab .primary"), nodePrimary:style("#node .primary"),
        card:style("#tab .vnccs-uc-model-card"), pose:style("#tab .vnccs-ps-section"),
        poseButton:style("#tab .vnccs-ps-btn"), selected:style("#tab .vnccs-uc-layer"),
      };
    });
    const sidebarWidth = width <= 1100 ? 240 : 280;
    expect(geometry.left.width).toBe(sidebarWidth * 1.2);
    expect(geometry.right.width).toBe(sidebarWidth);
    for (const [a, b] of [[geometry.button, geometry.batch], [geometry.seed, geometry.dice], [geometry.input, geometry.select]]) {
      expect(a.height).toBe(28);
      expect(b.height).toBe(28);
      expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
    }
    expect(geometry.tool.width).toBe(32);
    expect(geometry.tool.height).toBe(32);
    expect(geometry.root.font).toBe("12px");
    expect(geometry.primary.image).toBe("none");
    expect(geometry.primary.background).toBe("rgb(35, 102, 146)");
    expect(geometry.card.background).toBe("rgb(40, 40, 40)");
    expect(geometry.pose.background).toBe(geometry.card.background);
    expect(geometry.poseButton.image).toBe("none");
    expect(geometry.selected.background).toBe("rgb(85, 85, 85)");
    expect(geometry.node.font).toBe("11px");
    expect(geometry.nodeLeft.zoom).toBe("2.5");
    expect(geometry.nodePrimary.image).toContain("linear-gradient");
    await page.locator("#tab .vnccs-uc-tools button").hover();
    await expect(page.locator("#tab .vnccs-uc-tools button")).toHaveCSS("background-color", "rgb(85, 85, 85)");
    await page.screenshot({ path:testInfo.outputPath("after.png") });

    // Theme changes update existing controls without replacing their DOM or state.
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--interface-panel-surface", "#fafafa");
      document.documentElement.style.setProperty("--base-foreground", "#111111");
      document.documentElement.style.colorScheme = "light";
    });
    await expect(page.locator("#tab .vnccs-uc-left")).toHaveCSS("background-color", "rgb(250, 250, 250)");
    await expect(page.locator("#tab")).toHaveCSS("color", "rgb(17, 17, 17)");
    await expect(page.locator("#tab .vnccs-uc-batch-input")).toHaveValue("1");
    await expect(page.locator("#node")).toHaveCSS("color", "rgb(232, 232, 240)");
  });
}

test("live standalone: native density stays fixed when the workspace grows", async ({ page }) => {
  await openUnicanvas(page);
  const root = page.locator(".vnccs-uc2-standalone-shell .vnccs-unicanvas");
  await expect(root).toHaveClass(/vnccs-uc-standalone/);
  for (const viewport of [{ width:1600, height:1000 }, { width:3440, height:1440 }]) {
    await page.setViewportSize(viewport);
    await expect(root.locator(".vnccs-uc-left")).toHaveCSS("width", "336px");
    await expect(root.locator(".vnccs-uc-tools .vnccs-uc-icon").first()).toHaveCSS("height", "32px");
    await expect(root.locator(".vnccs-uc-draw-control .primary")).toHaveCSS("height", "28px");
  }
  await expect(page.locator(".vnccs-unicanvas-sidebar-icon")).toHaveClass(/pi-images/);
  await expect(page.locator(".vnccs-unicanvas-sidebar-icon")).toHaveCSS("background-image", "none");
});
