import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const web = new URL("../web/", import.meta.url);
const files = (await readdir(web, { recursive: true })).map(name => name.split(path.sep).join("/"));

test("web root contains only the ComfyUI extension entry points", async () => {
    const entries = files.filter(name => !name.includes("/"));
    const rootFiles = [];
    for (const name of entries) {
        if ((await stat(new URL(name, web))).isFile()) rootFiles.push(name);
    }
    assert.deepEqual(rootFiles.sort(), [
        "vnccs_3d_factory.js", "vnccs_camera_control.js", "vnccs_config.js",
        "vnccs_pose_studio.js", "vnccs_prompt_designer.js", "vnccs_unicanvas.js",
    ]);
    for (const name of rootFiles) {
        assert.match(await readFile(new URL(name, web), "utf8"), /app\.registerExtension\(/, name);
    }
});

test("nested frontend imports, workers, and asset URLs resolve inside the extension or ComfyUI scripts", async () => {
    let checked = 0;
    for (const name of files.filter(name => /\.(?:js|mjs)$/.test(name) && !name.startsWith("vendor/"))) {
        const source = await readFile(new URL(name, web), "utf8");
        const links = [
            ...source.matchAll(/\b(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g),
            ...source.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g),
        ];
        for (const [, relative] of links) {
            const served = new URL(relative, `https://comfy.example/extensions/Utils/${name}`);
            if (relative.includes("/scripts/")) {
                assert.ok(served.pathname.startsWith("/scripts/"), `${name}: ${relative}`);
            } else {
                assert.ok(served.pathname.startsWith("/extensions/Utils/"), `${name}: ${relative}`);
                const local = new URL(relative.split("?")[0], new URL(name, web));
                await assert.doesNotReject(stat(local), `${name}: ${relative}`);
            }
            checked++;
        }
    }
    assert.ok(checked > 100, "the full frontend dependency graph must stay covered");
});
