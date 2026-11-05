// Real creator widget, Pose Studio scene, Three.js and morph worker; ComfyUI services are fixtures.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(new URL("../e2e/package.json", import.meta.url))("playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const html = `<!doctype html><meta charset="utf-8"><title>Pose Library Creator fixture</title>
<style>
body{margin:24px;background:#202024;font:13px system-ui;color:#ddd}
#host{border:2px solid #555;box-sizing:content-box;transform-origin:top left;border-radius:8px;overflow:hidden;background:#25252c}
header{height:30px;background:#35353f;padding:6px 12px;box-sizing:border-box;font-weight:600}
#native{height:410px;padding:8px 14px;box-sizing:border-box;display:grid;gap:4px}
#native label{display:flex;justify-content:space-between;align-items:center;height:22px}
#native input,#native select{width:160px;background:#18181f;color:#eee;border:1px solid #50505c;border-radius:5px;padding:3px}
#mount{height:calc(100% - 440px);padding:0 10px 10px;box-sizing:border-box;display:flex}#mount>div{flex:1;min-width:0}
</style>
<div id="host"><header>VNCCS Pose Library Creator</header><div id="native"></div><div id="mount"></div></div>
<script type="module">
import '/web/vnccs_pose_library_creator.js';
import {app} from '/scripts/app.js';import {api} from '/scripts/api.js';
const extension=app.extensions.find(e=>e.name==='VNCCS.PoseLibraryCreator');extension.setup();
class Node {
 constructor(){this.id=761;this.widgets=[{name:'seed',value:0},{name:'control_after_generate',value:'fixed'},{name:'resolution_scale',value:1},{name:'steps',value:8},{name:'cfg',value:1},{name:'sampler_name',value:'euler'},{name:'scheduler',value:'simple'},{name:'category',value:''},{name:'tags',value:''}];}
 setSize(size){this.size=[...size];const host=document.querySelector('#host');host.style.width=size[0]+'px';host.style.height=size[1]+'px';}
 addDOMWidget(name,type,element,options){document.querySelector('#mount').append(element);const w={name,type,element,options,_node:this};this.widgets.push(w);return w;}
 onExecuted(){this.executed=(this.executed||0)+1;}onConfigure(){this.configured=(this.configured||0)+1;}onRemoved(){this.removed=true;}
}
extension.beforeRegisterNodeDef(Node,{name:'VNCCS_PoseLibraryCreator'});
window.node=new Node();app.graph._nodes=[node];node.onNodeCreated();window.widget=node.poseLibraryCreator;
for(const name of ['model','clip','vae','PoseImage','CharacterImage']){const row=document.createElement('label');row.textContent=name;document.querySelector('#native').append(row);}
for(const w of node.widgets.filter(w=>w.options?.serialize!==false)){const row=document.createElement('label');row.textContent=w.name;row.className='creator-'+w.name+'-control';const input=document.createElement('input');input.value=w.value;input.setAttribute('aria-label',w.name);input.addEventListener('input',()=>{w.value=input.value;});row.append(input);document.querySelector('#native').append(row);}
window.emitStatus=(run,stage,message)=>api.emit('vnccs_pose_library_creator_status',{node_id:'761',run_id:run,stage,message});
window.request=(run,pose)=>({node_id:'761',run_id:run,pose_data:pose,width:256,height:384});
window.ready=true;
</script>`;

export async function capturePoseLibraryCreator({ executablePath, output = join(root, "tests/e2e/evidence/pose-library-creator") } = {}) {
    await mkdir(output, { recursive: true });
    const uploads = [], errors = [], report = [];
    let preview, holdMesh = null, meshStarted = false;
    const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png" };
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, "http://localhost");
            let body, type = "application/json";
            if (url.pathname === "/") { body = html; type = "text/html"; }
            else if (url.pathname === "/scripts/app.js") {
                body = "export const app={extensions:[],graph:{_nodes:[],getNodeById(id){return this._nodes.find(n=>String(n.id)===String(id))},setDirtyCanvas(){}},registerExtension(e){this.extensions.push(e)}};";
                type = "text/javascript";
            } else if (url.pathname === "/scripts/api.js") {
                body = "const handlers=new Map();export const api={apiURL:p=>p,addEventListener:(n,f)=>{if(!handlers.has(n))handlers.set(n,[]);handlers.get(n).push(f)},fetchApi:(u,o)=>fetch(u,o),emit:(n,d)=>Promise.all((handlers.get(n)||[]).map(f=>f({detail:d})))};";
                type = "text/javascript";
            } else if (url.pathname.startsWith("/web/")) {
                const path = resolve(root, "." + decodeURIComponent(url.pathname));
                assert.ok(path.startsWith(join(root, "web") + sep));
                body = await readFile(path); type = mime[extname(path)] || "application/octet-stream";
            } else if (url.pathname === "/vnccs/sam3d/render_mesh_overlay") {
                meshStarted = true;
                if (holdMesh) await holdMesh;
                body = JSON.stringify({ mesh: {} });
            } else if (url.pathname === "/vnccs/pose_sync/upload_capture") {
                let raw = ""; for await (const chunk of request) raw += chunk;
                uploads.push(JSON.parse(raw)); body = '{"status":"ok"}';
            } else if (url.pathname.startsWith("/vnccs/pose_library/preview/")) {
                body = Buffer.from(preview.split(",")[1], "base64"); type = "image/png";
            } else if (url.pathname === "/vnccs/pose_library/list") body = '{"poses":[]}';
            else if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
            else throw new Error(`Unexpected fixture request: ${url.pathname}`);
            response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
        } catch (error) { errors.push(String(error)); response.writeHead(500).end(String(error)); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"],
            ...(executablePath ? { executablePath } : {}) });
        const page = await browser.newPage({ viewport: { width: 1600, height: 1600 } });
        page.on("pageerror", error => errors.push(String(error)));
        await page.route("**/*", route => {
            const url = new URL(route.request().url());
            return url.origin === origin || ["blob:", "data:"].includes(url.protocol) ? route.continue() : route.abort();
        });
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.ready);
        const measure = () => page.evaluate(() => {
            const selectors = ["#host", "#native", ".creator-category-control", ".creator-tags-control", "#mount", ".vnccs-pose-creator", ".vnccs-pose-creator-preview",
                ".vnccs-pose-creator-name", ".vnccs-pose-creator-category", ".vnccs-pose-creator-status"];
            return Object.fromEntries(selectors.map(selector => {
                const e = document.querySelector(selector), r = e.getBoundingClientRect();
                return [selector, { x:r.x, y:r.y, width:r.width, height:r.height, overflowX:e.scrollWidth-e.clientWidth,
                    overflowY:e.scrollHeight-e.clientHeight }];
            }));
        });
        const check = async state => {
            const bounds = await measure(), mount = bounds["#mount"], widget = bounds[".vnccs-pose-creator"];
            for (const [selector, r] of Object.entries(bounds)) {
                assert.ok(r.overflowX <= 1 && r.overflowY <= 1, `${state}: ${selector} overflows ${JSON.stringify(r)}`);
                if (selector.startsWith(".creator-")) {
                    const native = bounds["#native"];
                    assert.ok(r.x >= native.x && r.x + r.width <= native.x + native.width + 1, `${state}: ${selector} fits form width`);
                    assert.ok(r.y >= native.y && r.y + r.height <= native.y + native.height + 1, `${state}: ${selector} fits form height`);
                } else if (selector.startsWith(".vnccs")) {
                    assert.ok(r.x >= mount.x - 1 && r.x + r.width <= mount.x + mount.width + 1, `${state}: ${selector} horizontal bounds`);
                    assert.ok(r.y >= widget.y - 1 && r.y + r.height <= mount.y + mount.height + 1, `${state}: ${selector} vertical bounds`);
                }
            }
            report.push({state, bounds});
        };
        await check("empty");
        await page.locator("#host").screenshot({path:join(output,"after-empty.png")});
        await page.evaluate(() => {
            node.setSize([460,800]);
            node.widgets.find(w=>w.name==='category').value=false;
            node.onConfigure({widgets_values:[0,'fixed',1,8,1,'euler','simple',false]});
        });
        assert.deepEqual(await page.evaluate(()=>[node.size[1],node.widgets.find(w=>w.name==='category').value]),[860,""]);
        const beforeInput = await measure();
        await page.getByLabel('category',{exact:true}).fill('Custom');
        await page.getByLabel('tags',{exact:true}).fill('Standing, Wave, wave');
        await page.getByLabel('tags',{exact:true}).focus();
        await page.evaluate(()=>node.onConfigure({}));
        assert.deepEqual(await measure(),beforeInput,"typing and configuration preserve panel bounds");
        assert.deepEqual(await page.evaluate(()=>node.widgets.filter(w=>['category','tags'].includes(w.name)).map(w=>w.value)),['Custom','Standing, Wave, wave']);
        await check("manual metadata and focus");
        const sam = { joint_names: ["pelvis", "head"], joint_rotations: [
            [[1,0,0],[0,1,0],[0,0,1]], [[1,0,0],[0,0.939693,-0.34202],[0,0.34202,0.939693]],
        ] };
        await page.evaluate(pose => {
            emitStatus('first','recognize','Recognizing the pose with SAM 3D Body');
            emitStatus('first','render','Rendering the reconstructed pose');
            window.renderTask=widget.render(request('first',pose));
        }, sam);
        await page.evaluate(() => renderTask);
        assert.equal(uploads.length,1);
        const capture = uploads[0];
        assert.equal(capture.sync_error,undefined);
        assert.equal(capture.sync_token,"first");
        assert.equal(capture.pose.type,"scene_pose");
        assert.equal(capture.pose.prompt,"");
        assert.equal(capture.pose.characters[0].poses[0].prompt,"");
        assert.equal(capture.captured_images.length,1);
        preview=capture.captured_images[0];
        assert.ok(preview.length>5000,"the real renderer must produce pixels");
        assert.equal(await page.locator('.vnccs-pose-creator-renderer').count(),0);
        await page.evaluate(() => {
            emitStatus('first','describe','Naming and categorizing the generated pose');
            node.onExecuted({pose_library_result:[{run_id:'first',name:'Head Turn',category:'Custom',repository:'local_user_poses'}]});
        });
        await page.waitForFunction(() => !!document.querySelector('.vnccs-pose-creator-preview img')?.complete);
        assert.equal(await page.locator('.vnccs-pose-creator-category').textContent(),'Custom');
        await check("saved");
        await page.locator("#host").screenshot({path:join(output,"after.png")});
        for (const [width,height,scale] of [[360,880,0.65],[460,800,1],[660,900,1.6]]) {
            await page.evaluate(([w,h,s])=>{node.setSize([w,h]);node.onConfigure({});document.querySelector('#host').style.transform='scale('+s+')';},[width,height,scale]);
            await check(`restored ${width}x${height} at ${scale}`);
        }
        await page.evaluate(() => {
            node.setSize([360,980]);document.querySelector('#host').style.transform='scale(1)';
            widget.showResult({run_id:'long',name:'A long pose name '.repeat(5),category:'A long category '.repeat(5),repository:'local_user_poses'});
        });
        await check("long metadata");
        await page.locator("#host").screenshot({path:join(output,"after-long.png")});
        await page.evaluate(() => {
            emitStatus('bad','recognize','Recognizing pose');
            window.renderTask=widget.render(request('bad',{}));
        });
        await page.evaluate(() => renderTask);
        assert.match(uploads.at(-1).sync_error,/Failed to apply/);
        await page.evaluate(() => emitStatus('bad','error','Pose recognition failed. Use an image with one clearly visible person and run the workflow again.'));
        await check("error");
        await page.locator("#host").screenshot({path:join(output,"after-error.png")});
        const uploadCount = uploads.length;
        let releaseMesh;
        holdMesh = new Promise(resolve => { releaseMesh=resolve; });meshStarted=false;
        await page.evaluate(pose => {emitStatus('cancel','recognize','Recognizing pose');window.renderTask=widget.render(request('cancel',pose));},sam);
        for (let i=0;!meshStarted && i<150;i++) await new Promise(resolve=>setTimeout(resolve,100));
        assert.ok(meshStarted);
        await page.evaluate(() => emitStatus('cancel','cancelled','Cancelled. No pose was saved.'));
        releaseMesh();holdMesh=null;
        await page.evaluate(() => renderTask);
        assert.equal(uploads.length,uploadCount,"cancelled render must never publish a late capture");
        assert.equal(await page.locator('.vnccs-pose-creator-renderer').count(),0);
        await page.evaluate(() => {emitStatus('old','done','obsolete');node.onRemoved();});
        assert.equal(await page.locator('.vnccs-pose-creator').count(),0);
        assert.equal(await page.evaluate(()=>node.widgets[0].value),0);
        assert.equal(await page.evaluate(()=>node.removed),true);
        assert.deepEqual(errors,[]);
        await writeFile(join(output,"after.geometry.json"),JSON.stringify({report,checks:["real pose capture","empty prompt","single category","saved preview","manual metadata and focus","legacy restore","restore","stale event","failure","cancellation","disposal"]},null,2));
        console.log(`Pose Library Creator: ${report.length} geometry states, capture/error/cancel checks passed. ${output}`);
    } finally {
        await browser?.close();
        await new Promise(resolve=>server.close(resolve));
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await capturePoseLibraryCreator({executablePath:process.argv[2],output:process.argv[3]});
}
