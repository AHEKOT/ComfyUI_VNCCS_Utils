import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  UNICANVAS_HELP_TOOLTIP_ID,
  UNICANVAS_HELP_TOOLTIP_Z_INDEX,
  installUniCanvasHelpTooltips,
} from "../web/vnccs_unicanvas_help.mjs";

const mainSource = await readFile(new URL("../web/vnccs_unicanvas.js", import.meta.url), "utf8");
const panelSource = await readFile(new URL("../web/vnccs_unicanvas_qwen21.mjs", import.meta.url), "utf8");

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.className = "";
    this.id = "";
    this.textContent = "";
    this.hidden = false;
    this.isConnected = false;
    this.ownerDocument = null;
    this.rect = { left: 0, top: 0, width: 0, height: 0 };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { child.isConnected = true; this.children.push(child); return child; }
  closest(selector) {
    if (selector !== ".vnccs-uc-help") return null;
    return this.className.split(/\s+/).includes("vnccs-uc-help") ? this : null;
  }
  getBoundingClientRect() {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
}

// Minimal document/window pair: the layer only needs head/body, listeners and rects.
// The module keeps one layer per page, so the whole file shares this harness.
const listeners = new Map();
const elements = [];
const doc = {
  head: new FakeElement("head"),
  body: new FakeElement("body"),
  createElement(tag) { const el = new FakeElement(tag); el.ownerDocument = doc; elements.push(el); return el; },
  getElementById(id) { return elements.find((el) => el.id === id) || null; },
  addEventListener(type, handler) { (listeners.get(type) || listeners.set(type, []).get(type)).push(handler); },
};
globalThis.window = {
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener(type, handler) { (listeners.get(type) || listeners.set(type, []).get(type)).push(handler); },
};
installUniCanvasHelpTooltips(doc);

const fire = (type, event) => { for (const handler of listeners.get(type) || []) handler(event); };
const helpIcon = (tip, rect) => {
  const icon = new FakeElement("span");
  icon.ownerDocument = doc;
  icon.className = "vnccs-uc-help";
  icon.dataset.tip = tip;
  icon.rect = rect;
  return icon;
};
const layer = () => elements.find((el) => el.id === UNICANVAS_HELP_TOOLTIP_ID) || null;
// Simulate the measured size of the wrapped tooltip text.
const measure = (width, height) => { layer().rect = { left: 0, top: 0, width, height }; };

test("a hovered help icon drives one body-level, viewport-pinned tooltip layer", () => {
  const icon = helpIcon("Runs the Viggle 6-step turbo LoRA", { left: 300, top: 500, width: 14, height: 14 });
  fire("pointerover", { target: icon });
  const tip = layer();
  assert.ok(tip, "the tooltip layer must be created on the first hover");
  assert.ok(doc.body.children.includes(tip), "the layer lives on body, outside every scrolling sidebar");
  assert.equal(tip.textContent, "Runs the Viggle 6-step turbo LoRA");
  assert.equal(tip.hidden, false);
  measure(220, 44);
  fire("pointerover", { target: icon });
  // Above the icon, centered on it: icon center 307 minus half of the 220px tip.
  assert.equal(tip.style.top, "448px");
  assert.equal(tip.style.left, "197px");
  fire("pointerover", { target: new FakeElement("div") });
  assert.equal(tip.hidden, true, "leaving the icon hides the tooltip");
});

test("the tooltip flips below the icon and clamps at the viewport edges", () => {
  const nearTop = helpIcon("Tooltip for a control at the top of the sidebar", { left: 40, top: 12, width: 14, height: 14 });
  fire("pointerover", { target: nearTop });
  const tip = layer();
  measure(220, 44);
  fire("pointerover", { target: nearTop });
  assert.equal(tip.style.top, "34px", "with no room above, the tooltip opens below the icon");
  assert.equal(tip.style.left, "8px", "the left edge stays inside the viewport margin");
  const nearRight = helpIcon("A tip near the right edge of a wide sidebar panel", { left: 1180, top: 400, width: 14, height: 14 });
  fire("pointerover", { target: nearRight });
  assert.equal(tip.style.left, "972px", "1200 - 220 (measured) - 8 (margin)");
  assert.ok(Number.parseFloat(tip.style.top) + 44 <= 800 - 8, "the tooltip never leaves the viewport below");
});

test("scrolling a sidebar hides the tooltip instead of stranding it", () => {
  const icon = helpIcon("Parameters hint", { left: 100, top: 300, width: 14, height: 14 });
  fire("pointerover", { target: icon });
  assert.equal(layer().hidden, false);
  fire("scroll", {});
  assert.equal(layer().hidden, true);
  fire("pointerover", { target: icon });
  fire("pointerdown", {});
  assert.equal(layer().hidden, true);
});

test("the layer stylesheet is fixed, transparent to pointers and ranked between shells and dialogs", () => {
  const style = elements.find((el) => el.tagName === "STYLE");
  assert.ok(style, "the module injects its own layer stylesheet");
  assert.ok(style.textContent.includes("position:fixed"), "a fixed layer is never clipped by a sidebar");
  assert.ok(style.textContent.includes("pointer-events:none"), "the tooltip never blocks the UI");
  assert.ok(style.textContent.includes(`z-index:${UNICANVAS_HELP_TOOLTIP_Z_INDEX}`));
  assert.ok(UNICANVAS_HELP_TOOLTIP_Z_INDEX > 2147482000, "above the fullscreen portal");
  assert.ok(UNICANVAS_HELP_TOOLTIP_Z_INDEX > 2147481000, "above the standalone shell");
  assert.ok(UNICANVAS_HELP_TOOLTIP_Z_INDEX < 2147484000, "below the dialogs the shells raise");
});

test("no CSS pseudo-element tooltip can be clipped by a sidebar any more", () => {
  for (const [name, source] of [["main", mainSource], ["panel", panelSource]]) {
    assert.doesNotMatch(source, /\.vnccs-uc-help:hover::after/, `${name}: the hover ::after tooltip must be gone`);
    assert.ok(source.includes("data-tip"), `${name}: help icons still carry their tip text`);
  }
  assert.match(mainSource, /import \{ installUniCanvasHelpTooltips \} from "\.\/vnccs_unicanvas_help\.mjs(\?v=\d+)?"/, "the entry must import the shared tooltip layer");
  assert.match(mainSource, /installUniCanvasHelpTooltips\(\);/, "the extension setup must install the tooltip layer");
});

test("help icons no longer double up with a native title tooltip", () => {
  assert.match(panelSource, /help\.dataset\.tip = QWEN21_HELP_TEXTS\[key\] \|\| "";/, "the panel icons set data-tip");
  assert.doesNotMatch(panelSource, /help\.title = QWEN21_HELP_TEXTS/, "the panel icons must not set a native title");
  assert.match(mainSource, /helpBtn\.dataset\.tip = hint;/, "the Steps hint icon sets data-tip");
  assert.doesNotMatch(mainSource, /helpBtn\.title = hint;/, "the Steps hint icon must not set a native title");
});
