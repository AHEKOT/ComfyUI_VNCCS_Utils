import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entrySource = await readFile(path.join(root, "web/vnccs_unicanvas.js"), "utf8");
const initSource = await readFile(path.join(root, "__init__.py"), "utf8");

test("staleness gate: the entry auto-reloads when served code differs from the running one", () => {
  assert.match(entrySource, /const VNCCS_UNICANVAS_VERSION = "\d+";/, "the entry must carry a numeric file version");
  assert.match(entrySource, /fetch\(import\.meta\.url, \{ cache: "no-store" \}\)/,
    "the gate must fetch the served entry bypassing the cache");
  assert.ok(entrySource.includes("servedVersion === VNCCS_UNICANVAS_VERSION") && entrySource.includes("location.reload()"),
    "the gate must compare the served version against the running one and reload on mismatch");
  assert.match(entrySource, /sessionStorage\.setItem\(guardKey, String\(Date\.now\(\)\)\)/,
    "the reload must be guarded against loops via sessionStorage");
  assert.match(entrySource, /sessionStorage\.removeItem\(guardKey\)/,
    "matching versions must clear the reload guard");
  assert.match(entrySource, /setInterval\(checkStaleness, 90000\)/,
    "the gate must re-probe periodically so open tabs pick up new files");
});

test("build info: commit id and file version are exposed to the settings popover and console", () => {
  assert.match(initSource, /@PromptServer\.instance\.routes\.get\("\/vnccs\/unicanvas\/build_info"\)/,
    "the backend must expose the build_info route");
  assert.match(initSource, /git", "rev-parse", "--short", "HEAD"/,
    "the build info must carry the git commit id");
  const settings = entrySource.slice(entrySource.indexOf("openUniCanvasSettings() {"), entrySource.indexOf("openUniCanvasSettings() {") + 8000);
  assert.match(settings, /vnccs-uc-build-info/, "the settings popover must show the build identity");
  assert.match(settings, /\/vnccs\/unicanvas\/build_info/, "the popover must read the build_info route");
  assert.match(entrySource, /\[VNCCS UniCanvas\] build /, "extension setup must log the build identity");
});

test("entry-level history shield: stale cached modules cannot leak Ctrl+Z/Y to the graph", () => {
  const shieldStart = entrySource.indexOf("Self-contained safety net for the history keys");
  const shieldEnd = entrySource.indexOf("})();", entrySource.indexOf("}, true);", shieldStart));
  const shield = entrySource.slice(shieldStart, shieldEnd);
  assert.match(shield, /window\.addEventListener\("keydown"/, "the shield must listen on window keydown");
  assert.match(shield, /\}, true\);/, "the shield must listen in the capture phase");
  assert.match(shield, /key !== "z" && key !== "y"/, "the shield must claim only Z/Y");
  assert.match(shield, /closest\?\.\("input, textarea, select, \[contenteditable\]"\)/,
    "the shield must spare text fields");
  assert.match(shield, /querySelector\("\.vnccs-uc2-fullscreen-portal"\)/,
    "the shield must gate on the fullscreen portal marker");
  assert.match(shield, /classList\.contains\("vnccs-unicanvas-standalone-mode"\)/,
    "the shield must gate on the standalone body class");
  assert.match(shield, /stopImmediatePropagation\(\)/, "the shield must stop the key");
  assert.ok(!/import /.test(shield), "the shield must be dependency-free");
});

test("local module imports carry the cache-busting version query", () => {
  const version = entrySource.match(/const VNCCS_UNICANVAS_VERSION = "(\d+)"/)[1];
  const imports = [...entrySource.matchAll(/from "\.\/(vnccs_[^"?]+)(\?v=(\d+))?"/g)];
  assert.ok(imports.length >= 14, "expected the full local import graph to be versioned");
  for (const [, path, query, v] of imports) {
    assert.ok(query, `import of ${path} must carry ?v=`);
    assert.equal(v, version, `import of ${path} must match the current version constant`);
  }
});

test("deleting any layer records history so undo restores it", () => {
  const del = entrySource.slice(entrySource.indexOf("  deleteLayer(id) {"), entrySource.indexOf("  deleteLayer(id) {") + 1200);
  assert.ok(/this\.recordHistoryBefore\(\);/.test(del),
    "deleteLayer must snapshot before removing the layer");
  assert.ok(!/type === "pose"[\s\S]{0,120}?recordHistoryBefore/.test(del),
    "history recording must not be limited to pose layers");
});
