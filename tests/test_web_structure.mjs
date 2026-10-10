import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("version bump picks up nested modules and refreshes their import queries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vnccs-web-version-"));
    try {
        await mkdir(path.join(root, "scripts"));
        await mkdir(path.join(root, "web", "unicanvas"), { recursive: true });
        await mkdir(path.join(root, "web", "pose_studio", "imports"), { recursive: true });
        const script = path.join(root, "scripts", "bump_unicanvas_version.mjs");
        await copyFile(new URL("../scripts/bump_unicanvas_version.mjs", import.meta.url), script);
        const entry = path.join(root, "web", "vnccs_unicanvas.js");
        await writeFile(entry, 'const VNCCS_UNICANVAS_VERSION = "1";\nimport { modes } from "./unicanvas/modes.mjs?v=1";\n');
        await writeFile(path.join(root, "web", "unicanvas", "modes.mjs"), "export const modes = {};\n");
        const nested = path.join(root, "web", "pose_studio", "imports", "video.mjs");
        await writeFile(nested, "export const video = {};\n");
        const newest = new Date(Date.now() + 60_000);
        await utimes(nested, newest, newest);
        const version = String(Math.floor((await stat(nested)).mtimeMs));
        const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        const source = await readFile(entry, "utf8");
        assert.ok(source.includes(`VNCCS_UNICANVAS_VERSION = "${version}"`));
        assert.ok(source.includes(`./unicanvas/modes.mjs?v=${version}`));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
