// Production widget, Three.js and morph worker; only ComfyUI services are fixtures.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(new URL("../e2e/package.json", import.meta.url))("playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[3] || join(root, "tests/e2e/evidence/pose-readiness"));
await mkdir(output, { recursive: true });
const uploads = [], errors = [], report = [];
const html = `<!doctype html><meta charset="utf-8"><title>Pose Studio readiness</title>
<style>body{margin:20px;background:#202024}#host{border:2px solid #555;box-sizing:content-box;transform-origin:top left}header{height:28px;color:white;background:#303036;padding-left:10px}#mount{height:calc(100% - 28px);padding:0 10px 10px;box-sizing:border-box;display:flex}#mount>div{flex:1;min-width:0}</style>
<div id="host"><header>VNCCS Pose Studio · 761</header><div id="mount"></div></div>
<script type="module">
import '/web/vnccs_pose_studio.js';
import {app} from '/scripts/app.js';
import {api} from '/scripts/api.js';
const extension=app.extensions.find(e=>e.name==='VNCCS.PoseStudio');extension.setup();
class Node {
 constructor(){this.id=761;this.type='VNCCS_PoseStudio';this.widgets=[{name:'pose_data',value:'{}'}];this.inputs=[];this.outputs=[{type:'IMAGE',name:'images',links:[]}];this.properties={};this.graph=app.graph;}
 setSize(size){this.size=[...size];const host=document.querySelector('#host');host.style.width=size[0]+'px';host.style.height=size[1]+'px';}
 addInput(name,type){this.inputs.push({name,type});}
 addWidget(type,name,value,callback){const w={type,name,value,callback};this.widgets.push(w);return w;}
 addDOMWidget(name,type,element,options){document.querySelector('#mount').append(element);const w={name,type,element,options,_node:this,triggerDraw(){}};this.widgets.push(w);return w;}
 setDirtyCanvas(){}
}
await extension.beforeRegisterNodeDef(Node,{name:'VNCCS_PoseStudio'});
window.saved=JSON.stringify({poses:[{modelRotation:[0,0,0],prompt:'First pose'},{modelRotation:[0,0.3,0],prompt:'Second pose'}],activeTab:1,export:{view_width:256,view_height:256,skin_type:'dummy_white',interface_mode:'studio',debugMode:false,manager_auto_analyze_proportions:false},legacy_fixture:'preserved'});
window.setup=()=>{window.node=new Node();app.graph._nodes=[node];node.onNodeCreated();window.widget=node.studioWidget;node.widgets[0].value=saved;node.onConfigure({});};
window.sync=(event,token)=>api.emit(event,{node_id:'761',sync_token:token,pose_data:{},apply_mode:'manager_proportions'});
window.ready=true;
</script>`;
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url, "http://localhost");
        let body, type = "application/json";
        if (url.pathname === "/") { body = html; type = "text/html"; }
        else if (url.pathname === "/scripts/app.js") {
            body = "export const app={extensions:[],graph:{_nodes:[],getNodeById(id){return this._nodes.find(n=>String(n.id)===String(id))},setDirtyCanvas(){}},registerExtension(e){this.extensions.push(e)}};";
            type = "text/javascript";
        } else if (url.pathname === "/scripts/api.js") {
            body = "const handlers=new Map();export const api={addEventListener:(name,fn)=>handlers.set(name,fn),fetchApi:(url,options)=>fetch(url,options),emit:(name,detail)=>handlers.get(name)({detail})};";
            type = "text/javascript";
        } else if (url.pathname.startsWith("/web/")) {
            const path = resolve(root, "." + decodeURIComponent(url.pathname));
            assert.ok(path.startsWith(join(root, "web") + sep));
            body = await readFile(path); type = mime[extname(path)] || "application/octet-stream";
        } else if (url.pathname === "/vnccs/pose_library/list") body = JSON.stringify({ poses: [] });
        else if (url.pathname === "/vnccs/pose_library/repositories/auto_refresh") body = "{}";
        else if (["/vnccs/pose_sync/upload_capture", "/vnccs/pose_captures_upload", "/vnccs/pose_animation_upload"].includes(url.pathname)) {
            let raw = ""; for await (const chunk of request) raw += chunk;
            if (url.pathname.includes("pose_sync")) uploads.push(JSON.parse(raw));
            body = JSON.stringify({ status: "ok" });
        } else if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
        else throw new Error(`Unexpected fixture request: ${url.pathname}`);
        response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
    } catch (error) { errors.push(String(error)); response.writeHead(500).end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"],
    ...(process.argv[2] ? { executablePath: process.argv[2] } : {}) }).catch(error => { server.close(); throw error; });
const geometry = page => page.evaluate(() => Object.fromEntries(
    ["#host", "#mount", ".vnccs-pose-studio", ".vnccs-ps-left", ".vnccs-ps-center", ".vnccs-ps-right-sidebar", ".vnccs-ps-canvas-wrap"].map(selector => {
        const e = document.querySelector(selector), r = e.getBoundingClientRect();
        return [selector, { x: r.x, y: r.y, width: r.width, height: r.height, overflowX: e.scrollWidth - e.clientWidth }];
    })));
try {
    for (const scenario of ["plain", "sam", "failure"]) {
        const failure = scenario === "failure";
        const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
        const consoleErrors = [];
        page.on("pageerror", error => errors.push(String(error)));
        page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
        let releaseModules;
        const modules = new Promise(resolve => { releaseModules = resolve; });
        await page.route("**/*", async route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin && !["blob:", "data:"].includes(url.protocol)) return route.abort();
            if (url.pathname.endsWith("/OrbitControls.js")) await modules;
            return route.continue();
        });
        if (failure) await page.addInitScript(() => {
            const getContext = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...args) {
                return type.includes("webgl") ? null : getContext.call(this, type, ...args);
            };
        });
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.ready);
        await page.evaluate(event => { setup(); window.execution = sync(event, 'initial'); },
            scenario === "sam" ? "vnccs_apply_sam3d_pose" : "vnccs_req_pose_sync");
        await page.waitForFunction(() => !!widget._modelLoadPromise);
        assert.equal(await page.evaluate(() => widget.viewer.orbit), null);
        assert.equal(await page.evaluate(() => node.widgets[0].value), await page.evaluate(() => saved));
        releaseModules();
        await page.evaluate(() => execution);
        let capture = uploads.at(-1);
        assert.equal(capture?.node_id, "761_initial");
        if (failure) {
            assert.match(capture.sync_error, /viewer initialization failed: Error creating WebGL context/);
            await page.evaluate(() => sync('vnccs_apply_sam3d_pose', 'sam-failed'));
            assert.match(uploads.at(-1).sync_error, /viewer initialization failed: Error creating WebGL context/);
            assert.equal(await page.evaluate(() => node.widgets[0].value), await page.evaluate(() => saved));
            assert.ok(consoleErrors.every(error => !error.includes("enableDamping")));
            await page.locator("#host").screenshot({ path: join(output, "after-init-error.png") });
            report.push({ scenario: "WebGL failure", error: uploads.at(-1).sync_error });
        } else {
            assert.equal(capture.sync_error, undefined);
            assert.equal(capture.captured_images.length, 2);
            assert.equal(capture.legacy_fixture, "preserved");
            assert.equal(await page.evaluate(() => widget.viewer.isInitialized()), true);
            assert.equal(await page.evaluate(() => widget._poseDataRestoreError), null);
            await page.evaluate(async () => { widget.switchTab(0); await sync('vnccs_req_pose_sync', 'tab'); });
            assert.equal(uploads.at(-1).sync_error, undefined);
            // Reopen the exact old bytes after execution has saved newer state.
            await page.evaluate(async () => { node.widgets[0].value=saved;node.onConfigure({});await sync('vnccs_req_pose_sync', 'reopen'); });
            assert.equal(uploads.at(-1).sync_error, undefined);
            for (const [width, height, scale] of scenario === "sam" ? [[900, 740, 1]] : [[900, 740, 1], [760, 680, 0.75], [1400, 950, 1]]) {
                await page.evaluate(([width,height,scale]) => {
                    node.setSize([width,height]);document.querySelector('#host').style.transform='scale('+scale+')';node.onResize(node.size);
                    widget.scheduleMainUIScaleCommit({force:true});
                }, [width,height,scale]);
                await page.waitForTimeout(200);
                const bounds = await geometry(page), host = bounds["#host"];
                for (const [selector, rect] of Object.entries(bounds)) {
                    assert.ok(rect.width > 0 && rect.height > 0, `${selector} has visible dimensions`);
                    assert.ok(rect.x >= host.x - 1 && rect.x + rect.width <= host.x + host.width + 1, `${selector} fits node width`);
                    assert.ok(rect.y >= host.y - 1 && rect.y + rect.height <= host.y + host.height + 1, `${selector} fits node height`);
                }
                const before = await geometry(page);
                await page.evaluate(() => widget.switchTab(widget.activeTab ? 0 : 1));
                assert.deepEqual(await geometry(page), before, "pose selection does not move panels");
                await page.locator("#host").screenshot({ path: join(output, scenario === "sam" ? "after-sam.png" : width === 900 ? "after.png" : `after-${width}.png`) });
                report.push({ scenario, width, height, scale, bounds });
            }
            assert.deepEqual(consoleErrors, []);
        }
        await page.evaluate(() => node.onRemoved());
        await page.close();
    }
    assert.deepEqual(errors, []);
    await writeFile(join(output, "after.geometry.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.length, output }));
} finally { await browser.close(); server.close(); }
