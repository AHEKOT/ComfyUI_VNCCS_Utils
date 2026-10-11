import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { STANDALONE_STYLES } from "../../web/unicanvas/standalone_theme.mjs";
import { openUnicanvas } from "./helpers/app.mjs";

const widgetSource = await readFile(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const poseSource = await readFile(new URL("../../web/vnccs_pose_studio.js", import.meta.url), "utf8");
const originalStyles = source => source.match(/const STYLES = `([\s\S]*?)`;/)[1];
const scaleMethod = widgetSource.slice(widgetSource.indexOf("  updateMainUIScale() {"), widgetSource.indexOf("  canvasPointFromEvent(e) {"));

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

for (const [width, height] of [[900,1000], [1600,1000], [3440,1000], [1366,600], [1024,500], [1280,360]]) {
  test(`CSS fixture: responsive standalone density and node isolation at ${width}×${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
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
      <div class="vnccs-uc-stage-wrap"><canvas class="vnccs-uc-stage"></canvas><div class="vnccs-uc-tools">${Array.from({length:10}, (_,i) => `<button class="vnccs-uc-icon ${i === 0 ? "active" : ""}" title="Tool ${i+1}"><svg viewBox="0 0 24 24"><path d="M4 4l16 16"/></svg></button>`).join("")}</div></div>
      <div class="vnccs-uc-side"><div class="vnccs-uc-pose-side"><div class="vnccs-ps-section"><div class="vnccs-ps-section-header">Pose</div><button class="vnccs-ps-btn primary">Apply</button></div></div></div>
    </div><div id="node" class="vnccs-unicanvas" style="--vnccs-uc-ui-scale:2.5"><div class="vnccs-uc-left">${controls}</div></div>
    <script>
      class Host { ${scaleMethod} }
      const widget = window.widget = new Host();
      widget.standalone = true; widget.container = document.querySelector('#tab');
      widget.stageWrap = widget.container.querySelector('.vnccs-uc-stage-wrap'); widget.tools = widget.container.querySelector('.vnccs-uc-tools');
      widget.updateMainUIScale();
      new ResizeObserver(() => widget.updateMainUIScale()).observe(widget.container);
      new ResizeObserver(() => widget.updateMainUIScale()).observe(widget.stageWrap);
    </script>`);

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
        scale:Number(document.querySelector('#tab').style.getPropertyValue('--vnccs-uc-ui-scale')),
        toolScale:Number(document.querySelector('#tab').style.getPropertyValue('--vnccs-uc-toolbar-scale')),
        stage:rect('#tab .vnccs-uc-stage-wrap'), toolbar:rect('#tab .vnccs-uc-tools'),
        tools:[...document.querySelectorAll('#tab .vnccs-uc-tools button')].map(el => { const r=el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}; }),
        toolOverflow:widget.tools.scrollHeight - widget.tools.clientHeight,
      };
    });
    const sidebarWidth = width <= 1100 ? 240 : 280;
    expect(geometry.left.width).toBeCloseTo(sidebarWidth * 1.2 * geometry.scale, 1);
    expect(geometry.right.width).toBeCloseTo(sidebarWidth * geometry.scale, 1);
    expect(geometry.scale).toBeLessThanOrEqual(1);
    if (height <= 600) expect(geometry.scale).toBeLessThan(1);
    for (const [a, b] of [[geometry.button, geometry.batch], [geometry.seed, geometry.dice], [geometry.input, geometry.select]]) {
      expect(a.height).toBeCloseTo(28 * geometry.scale, 1);
      expect(b.height).toBeCloseTo(28 * geometry.scale, 1);
      expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
    }
    expect(geometry.tool.width).toBeCloseTo(64 * geometry.toolScale, 1);
    expect(geometry.tool.height).toBeCloseTo(64 * geometry.toolScale, 1);
    expect(geometry.toolOverflow).toBeLessThanOrEqual(1);
    expect(geometry.stage.width).toBeGreaterThan(width * 0.35);
    for (const tool of geometry.tools) {
      expect(tool.top).toBeGreaterThanOrEqual(geometry.stage.y);
      expect(tool.bottom).toBeLessThanOrEqual(geometry.stage.y + geometry.stage.height);
      expect(tool.left).toBeGreaterThanOrEqual(geometry.stage.x);
      expect(tool.right).toBeLessThanOrEqual(geometry.stage.x + geometry.stage.width);
    }
    expect(geometry.left.y + geometry.left.height).toBeLessThanOrEqual(height + 1);
    expect(geometry.right.y + geometry.right.height).toBeLessThanOrEqual(height + 1);
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
    await page.locator("#tab .vnccs-uc-tools button").first().hover();
    await expect(page.locator("#tab .vnccs-uc-tools button").first()).toHaveCSS("background-color", "rgb(85, 85, 85)");
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
    if (width === 1600) {
      await page.evaluate(() => {
        widget.view = { x:123, y:-45, scale:0.8 };
        const stack = document.querySelector('#tab .vnccs-uc-stack');
        const spacer = document.createElement('div'); spacer.style.minHeight = '1200px'; stack.append(spacer);
        stack.scrollTop = 100;
      });
      await page.locator('#tab .vnccs-uc-batch-input').fill('3');
      for (const nextHeight of [600, 360, 1000]) {
        await page.setViewportSize({ width:1600, height:nextHeight });
        await expect.poll(() => page.evaluate(() => Number(widget.container.style.getPropertyValue('--vnccs-uc-ui-scale'))))
          .toBe(nextHeight < 900 ? 0.75 : 1);
        await expect.poll(() => page.evaluate(() => widget.tools.classList.contains('vnccs-uc-tools-compact'))).toBe(nextHeight === 360);
        await expect(page.locator('#tab .vnccs-uc-batch-input')).toHaveValue('3');
        expect(await page.evaluate(() => document.querySelector('#tab .vnccs-uc-stack').scrollTop)).toBe(100);
        expect(await page.evaluate(() => widget.view)).toEqual({ x:123, y:-45, scale:0.8 });
        expect(await page.evaluate(() => {
          const stage=widget.stageWrap.getBoundingClientRect();
          return [...widget.tools.children].every(tool => {
            const r=tool.getBoundingClientRect(); return r.top >= stage.top && r.bottom <= stage.bottom;
          });
        })).toBe(true);
      }
    }
  });
}

test("live standalone: density stays capped when the workspace grows", async ({ page }) => {
  await openUnicanvas(page);
  const root = page.locator(".vnccs-uc2-standalone-shell .vnccs-unicanvas");
  await expect(root).toHaveClass(/vnccs-uc-standalone/);
  for (const viewport of [{ width:1600, height:1000 }, { width:3440, height:1440 }]) {
    await page.setViewportSize(viewport);
    await expect(root.locator(".vnccs-uc-left")).toHaveCSS("width", "336px");
    await expect(root.locator(".vnccs-uc-tools .vnccs-uc-icon").first()).toHaveCSS("height", "64px");
    await expect(root.locator(".vnccs-uc-draw-control .primary")).toHaveCSS("height", "28px");
  }
  await expect(page.locator(".vnccs-unicanvas-sidebar-icon")).toHaveClass(/pi-images/);
  await expect(page.locator(".vnccs-unicanvas-sidebar-icon")).toHaveCSS("background-image", "none");
});
