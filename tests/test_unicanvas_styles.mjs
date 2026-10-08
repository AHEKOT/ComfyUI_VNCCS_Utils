import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { STANDALONE_STYLES } from "../web/unicanvas/standalone_theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Guards the STYLES template literal in web/vnccs_unicanvas.js. A backtick or a
// broken merge inside that literal once made the whole stylesheet evaluate to
// NaN, so the widget rendered completely unstyled while every source-text test
// still passed. These checks parse the literal the way JS actually does.
function readTemplateLiteral(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found: ${marker}`);
  const open = source.indexOf("`", start);
  let i = open + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") break;
    if (ch === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  assert.ok(i < source.length, "template literal never closes");
  return { content: source.slice(open + 1, i), after: source.slice(i + 1) };
}

function assertBalancedBraces(css, label) {
  let depth = 0;
  let inComment = false;
  for (let i = 0; i < css.length; i++) {
    if (!inComment && css[i] === "/" && css[i + 1] === "*") { inComment = true; i++; continue; }
    if (inComment && css[i] === "*" && css[i + 1] === "/") { inComment = false; i++; continue; }
    if (inComment) continue;
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    assert.ok(depth >= 0, `${label}: unexpected closing brace at offset ${i}`);
  }
  assert.equal(depth, 0, `${label}: ${depth} unclosed brace(s)`);
  assert.ok(!inComment, `${label}: unterminated /* comment swallows the stylesheet tail`);
}

test("UniCanvas STYLES template is intact and contains every panel stylesheet", async () => {
  const source = await readFile(path.join(root, "web/vnccs_unicanvas.js"), "utf8");
  const { content, after } = readTemplateLiteral(source, "const STYLES =");
  assert.ok(content.length > 20000, `STYLES collapsed to ${content.length} chars - the template literal terminated early`);
  assertBalancedBraces(content, "STYLES");
  // the literal must end immediately before the style-injection block
  assert.match(after.slice(0, 200), /if\s*\(!document\.getElementById\("vnccs-unicanvas-styles"\)\)/);
  // rules from each parallel stream that once lived outside a broken literal
  for (const rule of [
    ".vnccs-uc-new-canvas",          // top-bar New canvas button (modes stream)
    ".vnccs-uc-psd-row",             // PSD export/import row (sidebar stream)
    ".vnccs-uc-tool-settings-section", // docked tool settings (sidebar stream)
    ".vnccs-uc-settings-popover",    // hard-sized settings popover (sidebar stream)
    ".vnccs-uc-infer-scale",         // inference scale slider (left-panel stream)
    "user-select:none",              // global no-select (left-panel stream)
    "user-select:text",              // selection exceptions (left-panel stream)
  ]) {
    assert.ok(content.includes(rule), `STYLES is missing rule: ${rule}`);
  }
  assert.match(content, /\.vnccs-uc-settings-popover\s*\{[^}]*width:\s*440px/);
});

test("standalone styles use ComfyUI tokens and cannot reach node widgets", () => {
  assertBalancedBraces(STANDALONE_STYLES, "STANDALONE_STYLES");
  // Inspect every selector, including comma-separated groups and rules inside media queries.
  const css = STANDALONE_STYLES.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim();
    if (selector.startsWith("@media")) continue;
    // Remove nested pseudo-class arguments before splitting top-level selector groups.
    let flat = selector;
    while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, "");
    const groups = flat.split(",");
    for (const group of groups) {
      assert.match(group.trim(), /^(\.vnccs-(?:unicanvas\.vnccs-uc-standalone|uc-standalone)|body\.vnccs-unicanvas-standalone-mode)\b/);
    }
  }
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|linear-gradient|Sora/i);
  assert.match(css, /--vnccs-uc-ui-scale:1 !important/);
  for (const token of ["--interface-panel-surface", "--interface-stroke", "--base-foreground", "--secondary-background", "--primary-background"]) {
    assert.ok(css.includes(token), `missing ComfyUI token ${token}`);
  }
});
