import { test, expect } from "@playwright/test";
import { sampleState } from "../helpers/prompt_designer_dom.mjs";

async function openDesigner(page) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.app?.graph && window.LiteGraph, null, { timeout: 60_000 });
    for (let index = 0; index < 3; index++) await page.keyboard.press("Escape");
    await page.evaluate(() => {
        window.app.graph.clear();
        const node = window.LiteGraph.createNode("VNCCS_PromptDesigner");
        if (!node) throw new Error("VNCCS Prompt Designer is not registered.");
        node.pos = [40, 70];
        window.app.graph.add(node);
        window.__promptDesignerTestNode = node;
    });
    const root = page.locator(".vnccs-pd").first();
    await expect(root).toBeVisible();
    await page.waitForFunction(() => !window.__promptDesignerTestNode.promptDesigner.container.inert);
    await page.evaluate(state => {
        const widget = window.__promptDesignerTestNode.promptDesigner;
        widget.state = state; widget.render(); widget.commit();
    }, sampleState());
    return root;
}

async function sourceEditor(root) {
    await root.getByRole("button", { name: "Text", exact: true }).click();
    return root.getByRole("textbox", { name: "Block source text" });
}
async function savedOnDisk(page) {
    await expect.poll(() => page.evaluate(() => window.__promptDesignerTestNode.properties.promptDesigner.dirty)).toBe(false);
}

test("the first Enter after typing or paste shows the new caret line and saves one newline", async ({ page }) => {
    const root = await openDesigner(page);
    const editor = root.getByRole("textbox", { name: "Main prompt editor", exact: true });
    const lastLine = () => editor.evaluate(editor => {
        const range = document.createRange(); range.selectNodeContents(editor);
        return [...range.getClientRects()].at(-1).top - editor.getBoundingClientRect().top;
    });
    const savedText = () => page.evaluate(() => JSON.parse(window.__promptDesignerTestNode.widgets.find(w => w.name === "node_state").value)
        .parts.map(part => part.text ?? "").join(""));
    for (const source of ["typed", "pasted"]) {
        await editor.fill(source === "typed" ? "first line" : "");
        if (source === "pasted") await editor.evaluate(editor => {
            const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "first line");
            editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
        });
        const firstLine = await lastLine();
        await page.keyboard.press("Enter");
        expect(await lastLine()).toBeGreaterThan(firstLine + 20);
        expect(await savedText()).toBe("first line\n");
        await page.keyboard.press("Shift+Enter");
        expect(await lastLine()).toBeGreaterThan(firstLine + 40);
        expect(await savedText()).toBe("first line\n\n");
        await page.keyboard.type("next");
        expect(await savedText()).toBe("first line\n\nnext");
        await page.keyboard.press("Backspace");
        expect(await savedText()).toBe("first line\n\nnex");
    }
});

test("Prompt Designer saves input, inserts linked blocks and restores workflow state", async ({ page }) => {
    const root = await openDesigner(page);
    await expect(root.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await root.locator('.vnccs-pd-block[data-block-id="clothing"]').click();
    await (await sourceEditor(root)).fill("{~coat|shirt}");
    expect(await page.evaluate(() => JSON.parse(window.__promptDesignerTestNode.widgets.find(w => w.name === "node_state").value)
        .blocks.find(block => block.id === "clothing").text)).toBe("{~coat|shirt}");
    await root.getByRole("tab", { name: "Prompt", exact: true }).click();
    await expect(root.locator('.vnccs-pd-chip[data-block-id="clothing"]')).toHaveText("Clothing");
    await root.getByRole("textbox", { name: "Main prompt editor" }).fill("manual prompt, ");
    await root.locator('.vnccs-pd-block[data-block-id="hair"]').dragTo(root.getByRole("textbox", { name: "Main prompt editor" }));
    await expect(root.locator('.vnccs-pd-chip[data-block-id="hair"]')).toHaveCount(1);
    await page.evaluate(() => {
        const original = window.__promptDesignerTestNode;
        const saved = original.serialize();
        window.app.graph.remove(original);
        const restored = window.LiteGraph.createNode("VNCCS_PromptDesigner");
        window.app.graph.add(restored);
        restored.configure(saved);
        window.__promptDesignerTestNode = restored;
    });
    await expect(root.getByRole("textbox", { name: "Main prompt editor" })).toContainText("manual prompt,");
    await expect(root.locator('.vnccs-pd-chip[data-block-id="hair"]')).toHaveCount(1);
    await savedOnDisk(page);
});

test("page reload retains the latest authored card and a new node can import its disk copy", async ({ page }) => {
    let root = await openDesigner(page);
    await root.locator('.vnccs-pd-block[data-block-id="artists"]').click();
    const name = `Reload card ${Date.now()}`;
    const source = "{~watercolor|ink}\n\nready after reload";
    await root.getByRole("textbox", { name: "Block name" }).fill(name);
    await (await sourceEditor(root)).fill(source);
    await expect(root.locator(".vnccs-pd-inspector")).toBeVisible();
    await root.getByLabel("Sampling mode", { exact: true }).selectOption("cycle");
    await root.getByLabel("Card color", { exact: true }).evaluate(input => {
        input.value = "#f28ab2";
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Reload while the asynchronous disk write can still be pending.
    await page.reload({ waitUntil: "domcontentloaded" });
    root = page.locator(".vnccs-pd").first();
    await expect(root.getByRole("textbox", { name: "Block name" })).toHaveValue(name);
    await expect((await sourceEditor(root))).toHaveValue(source.replace("{~", "{@"));
    await expect(root.getByLabel("Sampling mode", { exact: true })).toHaveValue("cycle");
    await expect(root.getByLabel("Card color", { exact: true })).toHaveValue("#f28ab2");
    await savedOnDisk(page);
    await page.evaluate(() => {
        window.app.graph.clear();
        window.app.graph.add(window.LiteGraph.createNode("VNCCS_PromptDesigner"));
    });
    await root.getByRole("searchbox", { name: "Search saved blocks" }).fill(name);
    await root.locator(".vnccs-pd-list").getByRole("button").filter({ hasText: name }).click();
    await expect((await sourceEditor(root))).toHaveValue(source.replace("{~", "{@"));
    await expect(root.getByLabel("Sampling mode", { exact: true })).toHaveValue("cycle");
    await expect(root.getByLabel("Card color", { exact: true })).toHaveValue("#f28ab2");
});

test("block source shows numbered ready variants, errors and preserves preview scroll", async ({ page }) => {
    const root = await openDesigner(page);
    await root.locator('.vnccs-pd-block[data-block-id="artists"]').click();
    const source = (await sourceEditor(root));
    await source.fill("{~watercolor illustration|ink illustration|cel shading}");
    await root.getByRole("button", { name: "Variants", exact: true }).click();
    await expect(root.locator(".vnccs-pd-variant-text")).toHaveText(["watercolor illustration", "ink illustration", "cel shading", ""]);
    await expect(root.locator(".vnccs-pd-variant-index")).toHaveText(["1", "2", "3", "4"]);
    await root.getByRole("button", { name: "Text", exact: true }).click();
    await source.fill("{~" + Array.from({ length: 100 }, (_, index) => `option ${index}`).join("|") + "}");
    await root.getByRole("button", { name: "Variants", exact: true }).click();
    const variants = root.getByRole("list", { name: "Ready block variants" });
    await expect(root.locator(".vnccs-pd-variant")).toHaveCount(101);
    await variants.evaluate(list => { list.scrollTop = 300; });
    await root.locator('.vnccs-pd-block[data-block-id="hair"]').click();
    await root.getByRole("tab", { name: "Artists", exact: true }).click();
    await expect(root.locator(".vnccs-pd-variant")).toHaveCount(101);
    await expect.poll(() => variants.evaluate(list => list.scrollTop)).toBe(300);
    await root.getByRole("button", { name: "Text", exact: true }).click();
    await source.fill("{~broken");
    await expect(root.locator(".vnccs-pd-variants-head .vnccs-pd-status")).toContainText("Invalid Dynamic Prompts syntax");
    await expect(source).toHaveValue("{~broken");
    await source.fill("{~coat|shirt}");
    await root.getByRole("button", { name: "Variants", exact: true }).click();
    await expect(root.locator(".vnccs-pd-variant-text")).toHaveText(["coat", "shirt", ""]);
    await root.getByRole("button", { name: "Text", exact: true }).click();
    await source.fill("");
    await root.getByRole("button", { name: "Variants", exact: true }).click();
    await expect(root.locator(".vnccs-pd-variants-head .vnccs-pd-status")).toHaveText("Empty block");
});

test("block tabs preserve selection and scroll without duplicating documents", async ({ page }) => {
    const root = await openDesigner(page);
    await root.locator('.vnccs-pd-block[data-block-id="artists"]').click();
    await (await sourceEditor(root)).fill(Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n"));
    await (await sourceEditor(root)).evaluate(editor => {
        editor.setSelectionRange(20, 25);
        editor.scrollTop = 300;
    });
    await root.locator('.vnccs-pd-block[data-block-id="hair"]').click();
    await root.getByRole("tab", { name: "Artists", exact: true }).click();
    await expect.poll(() => root.getByRole("textbox", { name: "Block source text" }).evaluate(editor => ({
        top: editor.scrollTop, start: editor.selectionStart, end: editor.selectionEnd,
    }))).toEqual({ top: 300, start: 20, end: 25 });
    await root.locator('.vnccs-pd-block[data-block-id="artists"]').click();
    await expect(root.getByRole("tab", { name: "Artists", exact: true })).toHaveCount(1);
});

test("block search filters rows, highlights all literal matches and retains original indices", async ({ page }) => {
    const root = await openDesigner(page);
    await root.locator('.vnccs-pd-block[data-block-id="artists"]').click();
    const source = (await sourceEditor(root));
    await source.fill("{~coat|INK, ink, Ink|prefix .* suffix}");
    await root.getByRole("button", { name: "Variants", exact: true }).click();
    await expect(root.locator(".vnccs-pd-variant")).toHaveCount(4);
    const search = root.getByRole("searchbox", { name: "Search block variants" });
    await search.fill("ink");
    await expect(root.locator(".vnccs-pd-variant-index")).toHaveText(["2"]);
    await expect(root.locator(".vnccs-pd-match")).toHaveText(["INK", "ink", "Ink"]);
    await root.locator('.vnccs-pd-block[data-block-id="hair"]').click();
    await expect(search).toHaveValue("");
    await root.getByRole("tab", { name: "Artists", exact: true }).click();
    await expect(search).toHaveValue("ink");
    await expect(root.locator(".vnccs-pd-match")).toHaveCount(3);
    await search.fill(".*");
    await expect(root.locator(".vnccs-pd-variant-index")).toHaveText(["3"]);
    await expect(root.locator(".vnccs-pd-match")).toHaveText([".*"]);
    await search.fill("missing");
    await expect(root.locator(".vnccs-pd-variant")).toHaveCount(0);
    await expect(root.locator(".vnccs-pd-variants-head .vnccs-pd-status")).toContainText("No matches");
    await search.fill("");
    await expect(root.locator(".vnccs-pd-variant-index")).toHaveText(["1", "2", "3", "4"]);
    await expect(root.locator(".vnccs-pd-match")).toHaveCount(0);
    await root.getByRole("button", { name: "Text", exact: true }).click();
    await expect(source).toHaveValue("{~coat|INK, ink, Ink|prefix .* suffix}");
});

test("if completion inserts a condition on Tab, edits it and restores it with the workflow", async ({ page }) => {
    const root = await openDesigner(page);
    await root.locator('.vnccs-pd-block[data-block-id="artists"]').click();
    await (await sourceEditor(root)).fill("{1::red|0::blue}");
    await root.getByRole("tab", { name: "Prompt", exact: true }).click();
    const editor = root.getByRole("textbox", { name: "Main prompt editor" });
    await editor.fill("if");
    await expect(root.getByRole("button", { name: "Tab · Insert if condition" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(root.locator(".vnccs-pd-condition")).toHaveCount(1);
    const panel = root.getByRole("group", { name: "Edit condition" });
    await expect(panel).toBeVisible();
    await root.locator('.vnccs-pd-block[data-block-id="artists"]').dragTo(panel.getByLabel("Drop the block to check here"));
    await panel.getByLabel("Condition", { exact: true }).selectOption("equals");
    await panel.getByLabel("Comparison text", { exact: true }).fill("red");
    await panel.getByRole("textbox", { name: "Then output text and blocks" }).fill("beautiful");
    await panel.getByRole("button", { name: "Apply condition" }).click();
    await expect(root.locator(".vnccs-pd-output")).toHaveText("beautiful");
    await expect(root.locator(".vnccs-pd-condition")).toContainText("beautiful");
    await expect(root.locator(".vnccs-pd-condition").getByLabel("Condition comparison text")).toHaveValue("red");
    await page.evaluate(() => {
        const original = window.__promptDesignerTestNode;
        const saved = original.serialize();
        window.app.graph.remove(original);
        const restored = window.LiteGraph.createNode("VNCCS_PromptDesigner");
        window.app.graph.add(restored);
        restored.configure(saved);
        window.__promptDesignerTestNode = restored;
    });
    await expect(root.locator(".vnccs-pd-condition")).toHaveCount(1);
    await expect(root.locator(".vnccs-pd-output")).toHaveText("beautiful");
    await root.locator(".vnccs-pd-condition-label").filter({ hasText: /^If$/ }).dblclick();
    await expect(panel.getByLabel("Comparison text", { exact: true })).toHaveValue("red");
});

test("prompt tools insert conditions and multiple text/block outputs that survive reload", async ({ page }) => {
    let root = await openDesigner(page);
    const editor = root.getByRole("textbox", { name: "Main prompt editor" });
    await editor.fill("shared\n");
    const tools = root.getByRole("toolbar", { name: "Prompt tools" });
    await tools.getByRole("button", { name: "If", exact: true }).click();
    await expect(root.getByRole("group", { name: "Edit condition" })).toBeVisible();
    await root.getByRole("group", { name: "Edit condition" }).getByRole("button", { name: "Close", exact: true }).click();
    await editor.fill("shared\n");
    await tools.getByRole("button", { name: "Multi-prompt", exact: true }).click();
    const panel = root.getByRole("group", { name: "Multi-prompt", exact: true });
    await panel.getByRole("textbox", { name: "Text and blocks for prompt1" }).fill("1girl, wear ");
    await panel.getByRole("textbox", { name: "Text and blocks for prompt2" }).fill("1man, wear ");
    await root.locator('.vnccs-pd-list [data-block-id="clothing"]').dragTo(panel.getByRole("textbox", { name: "Text and blocks for prompt2", exact: true }));
    await expect.poll(() => page.evaluate(() => window.__promptDesignerTestNode.outputs.map(output => output.name))).toEqual(["prompt", "prompt2"]);
    await root.getByRole("combobox", { name: "Preview output" }).selectOption("1");
    await expect(root.locator(".vnccs-pd-output")).toContainText("shared\n1man, wear ");
    await page.reload({ waitUntil: "domcontentloaded" });
    root = page.locator(".vnccs-pd").first();
    await root.getByRole("button", { name: "Edit multi-prompt", exact: true }).dblclick();
    await expect(root.getByRole("textbox", { name: "Text and blocks for prompt1" })).toHaveText("1girl, wear ");
    await expect(root.getByRole("textbox", { name: "Text and blocks for prompt2" })).toContainText("1man, wear Clothing");
    await root.getByRole("combobox", { name: "Preview output" }).selectOption("1");
    await expect(root.locator(".vnccs-pd-output")).toContainText("shared\n1man, wear ");
});
