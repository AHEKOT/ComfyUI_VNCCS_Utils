import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
    findBoundaryEnabledOptionIndex,
    findNextEnabledOptionIndex,
} from "../web/vnccs_custom_select.mjs";


test("custom select keyboard navigation wraps and skips unavailable options", () => {
    const options = [
        { value: "a" },
        { value: "b", disabled: true },
        { value: "c", hidden: true },
        { value: "d" },
    ];

    assert.equal(findNextEnabledOptionIndex(options, 0, 1), 3);
    assert.equal(findNextEnabledOptionIndex(options, 3, 1), 0);
    assert.equal(findNextEnabledOptionIndex(options, 0, -1), 3);
    assert.equal(findBoundaryEnabledOptionIndex(options), 0);
    assert.equal(findBoundaryEnabledOptionIndex(options, true), 3);
    assert.equal(findNextEnabledOptionIndex([{ disabled: true }], 0, 1), -1);
});


test("every first-party native select is covered by the shared custom selector", async () => {
    const webDirectory = new URL("../web/", import.meta.url);
    const files = (await readdir(webDirectory))
        .filter(name => /^vnccs_.*\.(?:js|mjs)$/.test(name))
        .filter(name => name !== "vnccs_custom_select.mjs");
    const nativeSelectPattern = /createElement\(["']select["']\)|<select\b/;
    const uncovered = [];

    for (const name of files) {
        const source = await readFile(new URL(name, webDirectory), "utf8");
        if (nativeSelectPattern.test(source) && !source.includes("installCustomSelects")) uncovered.push(name);
    }

    assert.deepEqual(uncovered, []);
});


test("custom selector keeps the original control and replaces only its popup", async () => {
    const source = await readFile(new URL("../web/vnccs_custom_select.mjs", import.meta.url), "utf8");

    assert.match(source, /select\.addEventListener\("pointerdown", state\.onPointerDown, true\)/);
    assert.match(source, /event\.preventDefault\(\);[\s\S]*toggleCustomSelect\(state\)/);
    assert.match(source, /doc\.body\.appendChild\(menu\)/);
    assert.match(source, /context\.measureText\(optionLabel\(option\)\)\.width/);
    assert.match(source, /longestTextWidth \+ 74/);
    assert.doesNotMatch(source, /\.vnccs-custom-select-option-label\s*\{[\s\S]*text-overflow:\s*ellipsis/);
    assert.doesNotMatch(source, /select\.classList\.(?:add|remove)/);
    assert.doesNotMatch(source, /select\.parentNode\.insertBefore/);
    assert.doesNotMatch(source, /vnccs-custom-select-button/);
    assert.match(source, /interceptSelectProperty\(select, "value"/);
    assert.match(source, /MutationObserverConstructor/);
    assert.match(source, /dispatchEvent\(new EventConstructor\("input", \{ bubbles: true \}\)\)/);
    assert.match(source, /dispatchEvent\(new EventConstructor\("change", \{ bubbles: true \}\)\)/);
    assert.match(source, /aria-haspopup", "listbox"/);
});
