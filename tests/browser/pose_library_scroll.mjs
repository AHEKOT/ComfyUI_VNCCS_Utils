// Production widget, Three.js and morph worker; only ComfyUI services and library entries are fixtures.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(new URL("../e2e/package.json", import.meta.url))("playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const html = `<!doctype html><meta charset="utf-8"><title>Pose Library scroll regression</title>
<style>body{margin:20px;background:#202024}#host{border:2px solid #555;box-sizing:content-box;transform-origin:top left}header{height:28px;color:white;background:#303036;padding-left:10px}#mount{height:calc(100% - 28px);padding:0 10px 10px;box-sizing:border-box;display:flex}#mount>div{flex:1;min-width:0}</style>
<div id="host"><header>VNCCS Pose Studio · 761</header><div id="mount"></div></div>
<script type="module">
import '/web/vnccs_pose_studio.js';
import {app} from '/scripts/app.js';
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
window.ready=true;
</script>`;

export async function capturePoseLibraryScroll({ executablePath, output = join(root, "tests/e2e/evidence/pose-library-scroll"), exercise, beforeLoad } = {}) {
    await mkdir(output, { recursive: true });
    const errors = [], report = [];
    let poses = [], rejectDelete = false;
    const resetPoses = () => {
        poses = Array.from({ length: 100 }, (_, index) => ({
            name: `Standing ${String(index + 1).padStart(3, "0")}`, repository: "local_user_poses",
            category: "Standing", tags: ["test"], asset_type: index % 2 ? "animation" : "pose", has_preview: false,
        }));
    };
    resetPoses();
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
                body = "export const api={addEventListener(){},fetchApi:(url,options)=>fetch(url,options)};";
                type = "text/javascript";
            } else if (url.pathname.startsWith("/web/")) {
                const path = resolve(root, "." + decodeURIComponent(url.pathname));
                assert.ok(path.startsWith(join(root, "web") + sep));
                body = await readFile(path); type = mime[extname(path)] || "application/octet-stream";
            } else if (url.pathname === "/vnccs/pose_library/list") body = JSON.stringify({ poses });
            else if (url.pathname.startsWith("/vnccs/pose_library/get/")) body = JSON.stringify({ pose: { prompt: "Standing naturally" } });
            else if (url.pathname.startsWith("/vnccs/pose_library/delete/")) {
                assert.equal(request.method, "DELETE");
                if (rejectDelete) { response.writeHead(409, { "Content-Type": type }).end('{"error":"Delete rejected"}'); return; }
                const name = decodeURIComponent(url.pathname.split("/").at(-1));
                poses = poses.filter(pose => pose.name !== name);
                body = '{"status":"ok"}';
            } else if (url.pathname === "/vnccs/pose_library/repositories/auto_refresh"
                || url.pathname.includes("upload")) body = "{}";
            else if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
            else throw new Error(`Unexpected fixture request: ${url.pathname}`);
            response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
        } catch (error) { errors.push(String(error)); response.writeHead(500).end(String(error)); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"],
            ...(executablePath ? { executablePath } : {}) });
        const page = await browser.newPage({ viewport: { width: 1900, height: 1400 } });
        page.on("pageerror", error => errors.push(String(error)));
        await page.route("**/*", route => {
            const url = new URL(route.request().url());
            return url.origin === origin || ["blob:", "data:"].includes(url.protocol) ? route.continue() : route.abort();
        });
        await beforeLoad?.(page);
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.ready);
        await page.evaluate(() => setup());
        await page.waitForFunction(() => widget.viewer?.isInitialized() && !widget._modelLoadPromise);
        if (exercise) {
            await exercise(page, output);
            assert.deepEqual(errors, []);
            await page.evaluate(() => node.onRemoved());
            return;
        }
        const settle = async () => {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.waitForFunction(() => !widget._uiScaleCommitTimer && !widget._libraryResizeFrame);
        };
        const measure = () => page.evaluate(() => ({
            scrollTop: widget.libraryGrid.scrollTop,
            maxScroll: widget.libraryGrid.scrollHeight - widget.libraryGrid.clientHeight,
            selected: widget.librarySelectedName,
            bounds: Object.fromEntries(["#host", "#mount", ".vnccs-pose-studio", ".vnccs-ps-left", ".vnccs-ps-center",
                ".vnccs-ps-right-sidebar", ".vnccs-ps-library-modal", ".vnccs-ps-library-modal-header",
                ".vnccs-ps-library-toolbar", ".vnccs-ps-library-categories", ".vnccs-ps-library-modal-grid",
                ".vnccs-ps-library-inspector"].map(selector => {
                const element = document.querySelector(selector), rect = element.getBoundingClientRect();
                return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                    overflowX: element.scrollWidth - element.clientWidth }];
            })),
        }));
        const confirmDelete = async () => {
            await page.locator(".vnccs-ps-library-delete").click();
            await page.locator(".vnccs-ps-modal-overlay:not(.vnccs-ps-library-overlay) .danger").click();
        };
        for (const [width, height, scale] of [[900, 740, 1], [760, 680, 0.75], [1400, 950, 1.25]]) {
            resetPoses();
            await page.evaluate(([width, height, scale]) => {
                widget._closeLibraryModal?.(); node.setSize([width, height]); node.onResize(node.size);
                document.querySelector("#host").style.transform = `scale(${scale})`;
                widget.scheduleMainUIScaleCommit({ force: true }); widget.showLibraryModal();
            }, [width, height, scale]);
            await page.waitForFunction(() => widget.libraryGrid.children.length === 100);
            await page.evaluate(() => {
                widget.libraryActiveCategory = "Standing";
                widget.librarySearchInput.value = "test";
                widget.renderLibrary(); widget.selectLibraryPose(widget.libraryPoses[45]);
            });
            await page.waitForSelector(".vnccs-ps-library-delete");
            await settle();
            await page.evaluate(() => {
                const item = widget.libraryGrid.querySelector(".selected"), grid = widget.libraryGrid;
                const scale = grid.getBoundingClientRect().height / grid.clientHeight;
                grid.scrollTop += (item.getBoundingClientRect().top - grid.getBoundingClientRect().top) / scale + 25;
            });
            await settle();
            for (let deletion = 0; deletion < 3; deletion++) {
                const before = await measure();
                assert.ok(before.scrollTop > 1000, "the library is scrolled well past the first rows");
                await confirmDelete();
                await page.waitForFunction(count => widget.libraryGrid.children.length === count, 99 - deletion);
                await settle();
                const after = await measure();
                assert.ok(Math.abs(after.scrollTop - before.scrollTop) <= 1,
                    `deletion preserves scroll: ${before.scrollTop} -> ${after.scrollTop}`);
                assert.deepEqual(after.bounds, before.bounds, "deletion preserves the grid, inspector and full-node layout");
                assert.match(after.selected, new RegExp(`Standing 0${47 + deletion}$`));
                assert.deepEqual(await page.evaluate(() => [widget.libraryActiveCategory, widget.librarySearchInput.value]), ["Standing", "test"]);
                report.push({ width, height, scale, deletion, ...after });
            }
            const beforeRefresh = await measure();
            await page.evaluate(() => widget.refreshLibrary(false));
            await settle();
            assert.deepEqual(await measure(), beforeRefresh, "metadata refresh preserves position and layout");
            const host = beforeRefresh.bounds["#host"];
            for (const [selector, rect] of Object.entries(beforeRefresh.bounds)) {
                assert.ok(rect.width > 0 && rect.height > 0, `${selector} remains visible`);
                assert.ok(rect.x >= host.x - 1 && rect.x + rect.width <= host.x + host.width + 1, `${selector} fits the node width`);
                assert.ok(rect.y >= host.y - 1 && rect.y + rect.height <= host.y + host.height + 1, `${selector} fits the node height`);
            }
            await page.locator("#host").screenshot({ path: join(output, width === 900 ? "after.png" : `after-${width}.png`) });
        }
        const beforeCancel = await measure();
        await page.locator(".vnccs-ps-library-delete").click();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.deepEqual(await measure(), beforeCancel, "cancelling deletion preserves position and selection");
        rejectDelete = true;
        await confirmDelete();
        await page.getByRole("button", { name: "OK", exact: true }).click();
        rejectDelete = false;
        assert.deepEqual(await measure(), beforeCancel, "a rejected deletion preserves position and selection");

        await page.evaluate(() => widget.selectLibraryPose(widget.libraryPoses.at(-1)));
        await page.waitForSelector(".vnccs-ps-library-delete");
        await settle();
        await page.evaluate(() => { widget.libraryGrid.scrollTop = widget.libraryGrid.scrollHeight; });
        const beforeLast = await measure();
        await confirmDelete();
        await page.waitForFunction(() => widget.libraryGrid.children.length === 96);
        await settle();
        const afterLast = await measure();
        assert.equal(afterLast.scrollTop, afterLast.maxScroll, "deleting the bottom row clamps to the new bottom");
        assert.deepEqual(afterLast.bounds, beforeLast.bounds, "deleting the last item keeps the inspector open");
        assert.match(afterLast.selected, /Standing 099$/);
        report.push({ state: "last item", ...afterLast });

        await page.locator(".vnccs-ps-library-search").fill("Standing 099");
        await page.waitForFunction(() => widget.getFilteredLibraryPoses().length === 1 && widget.libraryGrid.children.length === 1);
        await confirmDelete();
        await page.waitForSelector(".vnccs-ps-library-empty");
        assert.equal(await page.evaluate(() => widget.librarySelectedName), null);
        assert.equal(await page.evaluate(() => widget.libraryGrid.scrollTop), 0);
        assert.match(await page.locator(".vnccs-ps-library-empty").textContent(), /No library items match/);
        report.push({ state: "last search result" });

        poses = [poses[0]];
        await page.evaluate(async () => {
            widget.librarySearchInput.value = ""; await widget.refreshLibrary(false);
            widget.selectLibraryPose(widget.libraryPoses[0]);
        });
        await page.waitForSelector(".vnccs-ps-library-delete");
        await confirmDelete();
        await page.waitForFunction(() => widget.libraryPoses.length === 0);
        assert.equal(await page.evaluate(() => widget.librarySelectedName), null);
        assert.match(await page.locator(".vnccs-ps-library-empty").textContent(), /No saved poses or animations/);
        report.push({ state: "empty library" });
        assert.deepEqual(errors, []);
        await writeFile(join(output, "after.geometry.json"), JSON.stringify(report, null, 2));
        console.log(`Pose Library: ${report.length} deletion/geometry checks passed. ${output}`);
        await page.evaluate(() => node.onRemoved());
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await capturePoseLibraryScroll({ executablePath: process.argv[2], output: process.argv[3] });
}
