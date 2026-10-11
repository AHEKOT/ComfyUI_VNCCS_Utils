import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { STANDALONE_STYLES } from "../../web/unicanvas/standalone_theme.mjs";

const source = await readFile(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const styles = source.match(/const STYLES = `([\s\S]*?)`;/)[1];
const markup = source.match(/this\.generationProgress\.innerHTML = `([\s\S]*?)`;/)[1];
const update = source.slice(source.indexOf("  updateGenerationProgress("), source.indexOf("  startDrawProgressPolling("));

for (const [width, standalone, scale] of [[800, true, 1], [1600, true, 1.5], [1200, false, 1]]) {
  test(`fixture: generation progress fills the notification panel (${width}px, standalone ${standalone}, ${scale}x)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height:600 });
    await page.setContent(`<!doctype html><style>
      :root { --base-background:#171717; --interface-panel-surface:#252525; --secondary-background:#333;
        --interface-stroke:#4e4e4e; --base-foreground:#fff; --muted-foreground:#aaa; --p-primary-color:#60a5fa; }
      ${styles}${STANDALONE_STYLES}
      body { margin:0; } #host { width:100vw; height:100vh; --vnccs-uc-ui-scale:${scale}; }
    </style><div id="host" class="vnccs-unicanvas ${standalone ? "vnccs-uc-standalone" : ""}">
      <div class="vnccs-uc-left"></div><div class="vnccs-uc-side"></div>
      <div class="vnccs-uc-bottom">Generation</div>
      <div class="vnccs-uc-generation-progress">${markup}</div><div class="vnccs-uc-stage-wrap"></div>
    </div><script>
      window.widget = new (class { ${update} })();
      widget.generationProgress = document.querySelector('.vnccs-uc-generation-progress');
    </script>`);
    const panel = page.locator(".vnccs-uc-generation-progress");
    const track = page.getByRole("progressbar", { name:"Generation progress" });
    await expect(panel).toBeHidden();
    for (const value of [0.25, 0.5, 1]) {
      await page.evaluate(value => widget.updateGenerationProgress({
        progress:value, message:"Sampling step 3/6 - 1.92 s/it", step:3, steps:6,
      }, true), value);
      await expect(panel).toBeVisible();
      await expect(track).toHaveAttribute("aria-valuenow", String(value * 100));
      await expect(track).toHaveAttribute("aria-valuetext", "Sampling step 3/6 - 1.92 s/it (3/6)");
      await expect(panel.locator(".vnccs-uc-progress-percent")).toHaveText(`${value * 100}%`);
      await expect.poll(async () => panel.evaluate(element => {
        const track = element.querySelector(".vnccs-uc-progress-track").getBoundingClientRect();
        const fill = element.querySelector(".vnccs-uc-progress-fill").getBoundingClientRect();
        return fill.width / track.width;
      })).toBeCloseTo(value, 3);
      const geometry = await panel.evaluate(element => {
        const bounds = selector => {
          const rect = element.querySelector(selector).getBoundingClientRect();
          return { x:rect.x, y:rect.y, width:rect.width, height:rect.height, bottom:rect.bottom, right:rect.right };
        };
        const rect = element.getBoundingClientRect();
        return { panel:{ x:rect.x, width:rect.width, bottom:rect.bottom },
          track:bounds(".vnccs-uc-progress-track"), fill:bounds(".vnccs-uc-progress-fill"),
          label:bounds(".vnccs-uc-progress-label"), percent:bounds(".vnccs-uc-progress-percent"),
          stageTop:document.querySelector(".vnccs-uc-stage-wrap").getBoundingClientRect().top };
      });
      expect(geometry.track.x).toBeCloseTo(geometry.panel.x, 1);
      expect(geometry.track.width).toBeCloseTo(geometry.panel.width, 1);
      expect(geometry.track.height).toBe(4);
      expect(geometry.track.bottom).toBeLessThanOrEqual(geometry.panel.bottom);
      expect(geometry.label.bottom).toBeLessThanOrEqual(geometry.track.y);
      expect(geometry.percent.bottom).toBeLessThanOrEqual(geometry.track.y);
      expect(geometry.label.right).toBeLessThanOrEqual(geometry.percent.x);
      expect(geometry.stageTop).toBeGreaterThanOrEqual(geometry.panel.bottom);
      if (value === 0.5) {
        await panel.screenshot({ path:testInfo.outputPath("after.png") });
        await writeFile(testInfo.outputPath("after.geometry.json"), JSON.stringify(geometry, null, 2));
      }
    }
    await page.emulateMedia({ reducedMotion:"reduce" });
    await page.evaluate(() => widget.updateGenerationProgress({ progress:0.75, message:"Decoding" }, true));
    const reduced = await panel.locator(".vnccs-uc-progress-fill").evaluate(element => ({
      duration:getComputedStyle(element).transitionDuration,
      ratio:element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width,
    }));
    expect(reduced.duration).toBe("0s");
    expect(reduced.ratio).toBeCloseTo(0.75, 3);
    await page.evaluate(() => widget.updateGenerationProgress({ progress:0, message:"Ready" }, false));
    await expect(panel).toBeHidden();
  });
}
