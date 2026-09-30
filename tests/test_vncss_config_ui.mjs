import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// All regexes avoid literal line breaks so the suite stays CRLF-tolerant on
// Windows checkouts (see tests/test_unicanvas_frontend.mjs for the contrast).
const widget = await readFile(new URL("../web/vnccs_config.js", import.meta.url), "utf8");
const ui = await readFile(new URL("../web/vnccs_config_ui.mjs", import.meta.url), "utf8");

function region(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `region start not found: ${startMarker}`);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, `region end not found: ${endMarker}`);
    return source.slice(start, end);
}

test("the widget layout is elastic (container query + collapsible sections + scrollable stack)", () => {
    assert.ok(ui.includes("container-type: inline-size"), "the shared root must be a size container");
    assert.ok(/@container\s*\(max-width/.test(ui), "container queries must adapt the rows");
    assert.ok(ui.includes("vnccs-cfg-section-body"), "collapsible section bodies must exist");
    const stack = region(widget, "this.loraList.style.overflowY", "this._updateStackBadge();");
    assert.ok(/maxHeight/.test(stack), "long LoRA stacks must scroll instead of stretching the node");
});

test("strength uses paired slider+number with live input and dblclick reset", () => {
    assert.ok(/type = "range"/.test(ui) && /type = "number"/.test(ui), "the pair must be range + number");
    const pair = region(ui, "for (const control of [range, number])", "return {");
    assert.ok(pair.includes('addEventListener("input"'), "visible value updates from every input event");
    assert.ok(pair.includes('addEventListener("dblclick"'), "double-click must reset the value");
    assert.ok(widget.includes("clip_strength"), "per-entry clip strength must be wired");
    assert.ok(widget.includes("createSliderNumber("), "strength controls come from the shared pair primitive");
});

test("reference inputs appear one at a time up to the 10-image family limit", () => {
    assert.ok(widget.includes("REFERENCE_LIMIT = 10"), "the family limit is 10 references");
    const sync = region(widget, "_syncReferenceInputs() {", "renderReferenceSlots();");
    assert.ok(sync.includes("previousConnected"), "socket N+1 requires socket N to be connected");
    assert.ok(sync.includes("shouldExist && index === -1"), "missing sockets are added only when revealed");
    assert.ok(sync.includes("this.node.removeInput(index)"), "hidden sockets are removed again");
    assert.ok(widget.includes("renderReferenceSlots()"), "the slot chips re-render with the sockets");
});

test("connection status dots cover model, clip, vae and audio_vae", () => {
    assert.ok(widget.includes('["model", "clip", "vae", "audio_vae"]'), "the four plumbing inputs get status dots");
    const dots = region(widget, "refreshConnectionStatus() {", "onGraphConnectionsChanged");
    assert.ok(dots.includes("input?.link != null"), "a dot is on only when the socket has a link");
    assert.ok(widget.includes("onConnectionsChange"), "status refreshes from graph connection changes");
});

test("the LoRA picker scales: search, folders, recents and bulk actions", () => {
    assert.ok(widget.includes("Filter by name"), "a name filter must exist");
    assert.ok(widget.includes("optgroup"), "LoRA folders group the picker options");
    assert.ok(widget.includes("vnccs-config-recent-loras"), "recent LoRAs power new-row defaults");
    for (const action of ["enable-all", "disable-all", "sort", "clear-all"]) {
        assert.ok(widget.includes('"' + action + '"'), "bulk action exists: " + action);
    }
    assert.ok(widget.includes("installCustomSelects"), "native selects stay on the shared custom selector");
});

test("the VNCSS Config node never shrinks below 300 px", () => {
    assert.ok(widget.includes("MIN_NODE_WIDTH = 300"), "the node must enforce a 300 px minimum width");
    assert.ok(widget.includes("originalOnResize"), "manual resizes must be clamped too");
});