// Regenerates VNCCS_UNICANVAS_VERSION in web/vnccs_unicanvas.js from the newest
// mtime across the UniCanvas web files. Run it after editing anything under web/
// that the widget loads (directly or through the import graph); the staleness
// gate in the entry file then hard-syncs any open tab on the next probe.
// Usage: node scripts/bump_unicanvas_version.mjs
import { readdir, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const entryPath = path.join(webDir, "vnccs_unicanvas.js");
const versionMarker = /const VNCCS_UNICANVAS_VERSION = "([^"]*)";/;
const relevant = (name) => /^vnccs_(unicanvas|custom_select|pose_studio)/.test(name) && /\.(js|mjs)$/.test(name);

async function newestMtime(dir) {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) continue;
    if (!relevant(entry.name)) continue;
    const info = await stat(full);
    newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
}

const mtime = await newestMtime(webDir);
if (!mtime) {
  console.error("No UniCanvas web files found under", webDir);
  process.exit(1);
}
const version = String(Math.floor(mtime));

const source = await readFile(entryPath, "utf8");
if (!versionMarker.test(source)) {
  console.error("VNCCS_UNICANVAS_VERSION marker missing from", entryPath);
  process.exit(1);
}
const current = source.match(versionMarker)[1];
if (current === version) {
  console.log("Version already up to date:", version);
  process.exit(0);
}
let next = source.replace(versionMarker, `const VNCCS_UNICANVAS_VERSION = "${version}";`);
// Keep the cache-busting query on every local module import in sync with the
// version constant, so a bumped entry always pulls fresh modules.
next = next.replace(/(from "\.\/vnccs_[^"?]+)\?v=\d+/g, `$1?v=${version}`);
await writeFile(entryPath, next, "utf8");
console.log("Bumped VNCCS_UNICANVAS_VERSION:", current, "->", version, "(imports re-versioned)");
