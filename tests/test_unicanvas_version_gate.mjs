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
