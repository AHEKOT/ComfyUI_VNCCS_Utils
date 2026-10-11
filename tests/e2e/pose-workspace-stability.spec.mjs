import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { STANDALONE_STYLES } from "../../web/unicanvas/standalone_theme.mjs";

const source = await readFile(new URL("../../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const pose = await readFile(new URL("../../web/unicanvas/pose.mjs", import.meta.url), "utf8");
const method = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));
const hostMethods = [
  method(source, "  beginPoseEditSession(layer) {", "  // Leaving the Pose tool"),
  method(source, "  restorePoseEditView(session) {", "  // Save pose"),
  method(source, "  clearToolPreviewOverlay() {", "  drawSamPreview(ctx) {"),
  method(source, "  drawBbox(ctx) {", "  drawResizeOverlay(ctx) {"),
].join("\n");
const layout = method(pose, "    layout() {", "    // The viewport camera renders");
const poseStyles = pose.match(/const styles = `([\s\S]*?)`;/)[1].replace("${POSE_HELP_CSS}", "");

for (const width of [900, 1600]) {
  test(`fixture: embedded pose keeps workspace geometry and bbox (${width}px)`, async ({ page }, testInfo) => {
    test.setTimeout(20000);
    page.on("pageerror", error => { throw error; });
    await page.setViewportSize({ width, height:800 });
    await page.setContent(`<style>
      :root { --base-background:#202020; --interface-panel-surface:#282828; --secondary-background:#353535;
        --interface-stroke:#4e4e4e; --base-foreground:#fff; --muted-foreground:#aaa; --p-primary-color:#3485bb; }
      body { margin:0; } #host { height:100vh; }
      ${source.match(/const STYLES = `([\s\S]*?)`;/)[1]}${STANDALONE_STYLES}${poseStyles}
    </style><div id="host" class="vnccs-unicanvas vnccs-uc-standalone">
      <div class="vnccs-uc-left"><button class="vnccs-uc-btn primary">Generate</button></div>
      <div class="vnccs-uc-bottom"><button class="vnccs-uc-btn">Fit</button></div>
      <div class="vnccs-uc-stage-wrap"><canvas class="vnccs-uc-stage"></canvas><canvas class="vnccs-uc-preview-stage"></canvas>
        <div class="vnccs-uc-tools"><button class="vnccs-uc-icon">Move</button></div></div>
      <div class="vnccs-uc-side"><div class="vnccs-uc-layers-section"><button class="vnccs-uc-btn" id="add-pose">Add pose layer</button></div></div>
    </div><script>
      class Host { ${hostMethods} }
      class Editor { ${layout} }
      const host = window.host = new Host();
      host.standalone=true; host.container=document.querySelector('#host'); host.stageWrap=host.container.querySelector('.vnccs-uc-stage-wrap');
      host.previewCanvas=host.container.querySelector('.vnccs-uc-preview-stage'); host.tool='pose'; host.sam={};
      host.bbox={x:0,y:0,width:160,height:160}; host.view={x:48,y:80,scale:0.73}; host.intendedScale=0.73;
      host.createLayerPixelSnapshot=layer => ({pose:structuredClone(layer.pose)});
      host.centerBbox=()=>{ throw new Error('Unexpected workspace reframing'); };
      host.updateHistoryButtons=host.setStatus=()=>{};
      const layer={id:'pose',visible:true,opacity:1,blendMode:'source-over',pose:{rect:{...host.bbox}}}; host.layers=[layer];
      const editor=host.poseEditor=new Editor(); editor.host=host; editor.layer=layer; editor.visible=false;
      editor.controls=document.createElement('div'); editor.controls.className='vnccs-uc-pose-controls';
      editor.sidePanel=document.createElement('div'); editor.sidePanel.className='vnccs-uc-pose-side'; editor.sidePanel.textContent='Pose settings';
      const root=document.createElement('div'); root.className='vnccs-uc-pose-root';
      const surface=document.createElement('div'); surface.className='vnccs-ps-canvas-wrap'; surface.style.background='#004466';
      root.append(surface,editor.controls); editor.studio={canvasContainer:surface};
      editor.syncSessionViewOffset=editor.refreshCharacterMenu=()=>{}; host.hasOpenStagingPanel=()=>false;
      host.requestRender=()=>{
        host.previewCanvas.width=host.stageWrap.clientWidth; host.previewCanvas.height=host.stageWrap.clientHeight;
        host.updateToolPreviewOverlay();
      };
      document.querySelector('#add-pose').onclick=()=>{
        host.beginPoseEditSession(layer);
        host.stageWrap.append(root); host.container.querySelector('.vnccs-uc-side').append(editor.sidePanel);
        host.container.classList.add('vnccs-uc-pose-active','vnccs-uc-pose-editing');
        editor.visible=true; editor.layout(); host.requestRender();
      };
    </script>`);
    const geometry = () => page.evaluate(() => ({
      view:{...host.view}, intendedScale:host.intendedScale, bbox:{...host.bbox},
      rects:[host.container, host.stageWrap, host.container.querySelector('.vnccs-uc-left'), host.container.querySelector('.vnccs-uc-side'),
        host.container.querySelector('.vnccs-uc-tools')].map(el => { const r=el.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; })
    }));
    const before = await geometry();
    await page.getByRole("button", { name:"Add pose layer", exact:true }).click();
    expect(await geometry()).toEqual(before);
    const stage = await page.locator(".vnccs-uc-stage-wrap").boundingBox();
    expect(await page.locator(".vnccs-ps-canvas-wrap").boundingBox()).toEqual(stage);
    expect(await page.evaluate(() => {
      const overlay=host.previewCanvas, ctx=overlay.getContext('2d');
      return Array.from(ctx.getImageData(48,80,118,2).data).some((value,index) => index%4===3 && value>0);
    })).toBe(true);
    await page.evaluate(() => host.clearToolPreviewOverlay());
    expect(await page.evaluate(() => host.previewCanvas.getContext('2d').getImageData(48,80,118,2).data.some((value,index) => index%4===3 && value>0))).toBe(true);
    await page.screenshot({ path:testInfo.outputPath("after.png") });
    await page.evaluate(() => {
      host.restorePoseEditView(host.poseEditSession); host.poseEditor.visible=false;
      document.querySelector('.vnccs-uc-pose-root').remove(); host.poseEditor.sidePanel.remove();
      host.container.classList.remove('vnccs-uc-pose-active','vnccs-uc-pose-editing');
    });
    expect(await geometry()).toEqual(before);
  });
}
