import { defaultState, normalizeState, mergeText, readEditor, removeBlock, promptId, randomSeed, EditHistory, CONDITION_OPERATORS, MAX_PROMPT_OUTPUTS, hasCycle } from "./state.mjs";
import { ensureStyles } from "./styles.mjs";
import { installCustomSelects } from "../shared/custom_select.mjs";
import { DocumentStorage } from "./storage.mjs";
import { readPromptResponse } from "./response.mjs";
import { syncPromptOutputs } from "./outputs.mjs";
import { blockRows, blockSourceMode } from "./block_source.mjs";
import { promptSnapshot, promptSignature, openPromptState, mergeCategories } from "./prompt_library.mjs";
import { LibraryActions } from "./library_actions.mjs";

const CARD_SELECTOR = "[data-block-id], [data-condition], [data-multi-prompt]";

function libraryCardKey(block, legacy = false) {
    const mode = block.mode ?? (/^\s*\{\s*@/.test(block.text) ? "cycle" : "random");
    return JSON.stringify(legacy ? [block.name, block.text, mode]
        : [block.name, block.text, mode, block.color, block.category?.toLowerCase() ?? ""]);
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export class PromptDesignerWidget {
    constructor(node, api) {
        this.node = node;
        this.api = api;
        this.events = new AbortController();
        this.libraryActions = new LibraryActions();
        this.events.signal.addEventListener("abort", () => this.libraryActions.close(false), { once: true });
        this.history = new EditHistory();
        this.revision = 0;
        this.blockRevision = 0;
        this.scroll = new Map();
        ensureStyles();
        this.container = element("div", "vnccs-pd");
        const workspace = this.workspace = element("div", "vnccs-pd-workspace");
        const library = this.library = element("aside", "vnccs-pd-library");
        this.libraryView = "blocks";
        this.libraryTabs = element("div", "vnccs-pd-library-tabs");
        this.libraryTabs.setAttribute("role", "tablist");
        this.libraryTabs.setAttribute("aria-label", "Library contents");
        for (const [view, label] of [["blocks", "Blocks"], ["prompts", "Prompts"]]) {
            const button = this.button(label, () => this.setLibraryView(view));
            button.dataset.view = view; button.setAttribute("role", "tab"); this.libraryTabs.append(button);
        }
        this.on(this.libraryTabs, "keydown", event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const view = event.key === "Home" ? "blocks" : event.key === "End" ? "prompts" : this.libraryView === "blocks" ? "prompts" : "blocks";
            this.setLibraryView(view);
            [...this.libraryTabs.children].find(button => button.dataset.view === view).focus({ preventScroll: true });
        });
        library.append(this.libraryTabs);
        this.libraryCategory = "";
        this.categories = element("div", "vnccs-pd-categories");
        this.categories.setAttribute("aria-label", "Library categories");
        this.categoryName = element("input");
        this.categoryName.placeholder = "Category name"; this.categoryName.maxLength = 128;
        this.categoryName.setAttribute("aria-label", "New category name");
        this.categoryForm = element("div", "vnccs-pd-category-form");
        this.categoryForm.hidden = true;
        this.categoryForm.append(this.categoryName, this.button("Add", () => this.addCategory()),
            this.button("Cancel", () => { this.categoryForm.hidden = true; }));
        this.search = element("input");
        this.search.type = "search";
        this.search.placeholder = "Search blocks…";
        this.search.setAttribute("aria-label", "Search saved blocks");
        this.list = element("div", "vnccs-pd-list");
        this.list.id = `vnccs-pd-library-${promptId()}`; this.list.setAttribute("role", "tabpanel");
        for (const button of this.libraryTabs.children) {
            button.id = `${this.list.id}-${button.dataset.view}`; button.setAttribute("aria-controls", this.list.id);
        }
        this.libraryHint = element("div", "vnccs-pd-hint", "Drag into the prompt. Click to edit.");
        this.libraryAction = this.button("+ New block", () => this.libraryView === "prompts" ? this.editPromptDetails() : this.newBlock());
        library.append(this.categories, this.categoryForm, this.search, this.list, this.libraryHint, this.libraryAction);
        this.libraryResize = element("div", "vnccs-pd-library-resize");
        this.libraryResize.tabIndex = 0;
        this.libraryResize.setAttribute("role", "separator");
        this.libraryResize.setAttribute("aria-orientation", "vertical");
        this.libraryResize.setAttribute("aria-label", "Resize block library");
        this.libraryResize.setAttribute("aria-valuemin", "240");
        this.libraryResize.setAttribute("aria-valuenow", "460");
        library.append(this.libraryResize);
        this.installPanelResize(library, this.libraryResize, "library");
        const editing = element("section", "vnccs-pd-editing");
        const toolbar = element("div", "vnccs-pd-toolbar");
        this.tabs = element("div", "vnccs-pd-tabs");
        this.tabs.setAttribute("role", "tablist");
        this.tabs.setAttribute("aria-label", "Prompt documents");
        this.undo = this.button("Undo", () => this.moveHistory("undo"));
        this.redo = this.button("Redo", () => this.moveHistory("redo"));
        const savePrompt = this.button("Save Prompt Template", () => this.editPromptDetails());
        savePrompt.classList.add("primary");
        this.blockSearch = element("input", "vnccs-pd-block-search");
        this.blockSearch.type = "search";
        this.blockSearch.placeholder = "Search in block…";
        this.blockSearch.setAttribute("aria-label", "Search block variants");
        toolbar.append(this.tabs, this.undo, this.redo, savePrompt);
        this.main = element("div", "vnccs-pd-doc");
        this.main.id = `vnccs-pd-main-${promptId()}`;
        this.main.setAttribute("role", "tabpanel");
        this.main.append(element("div", "vnccs-pd-hint", "Main prompt · Double-click a block or press Enter to open its tab"));
        this.editor = element("div", "vnccs-pd-editor");
        this.editor.contentEditable = "true";
        this.editor.spellcheck = false;
        this.editor.setAttribute("role", "textbox");
        this.editor.setAttribute("aria-multiline", "true");
        this.editor.setAttribute("aria-label", "Main prompt editor");
        this.conditionSuggestion = this.button("Tab · Insert if condition", () => this.insertCondition());
        this.conditionSuggestion.classList.add("vnccs-pd-condition-suggestion");
        this.conditionSuggestion.setAttribute("aria-keyshortcuts", "Tab");
        this.conditionSuggestion.hidden = true;
        this.conditionPanel = element("fieldset", "vnccs-pd-condition-panel");
        this.conditionPanel.hidden = true;
        this.conditionPanel.append(element("legend", null, "Edit condition"));
        const conditionRow = element("div", "vnccs-pd-condition-row");
        const field = (label, control) => {
            const wrapper = element("label", null, label);
            wrapper.append(control);
            return wrapper;
        };
        this.conditionSource = element("div", "vnccs-pd-editor vnccs-pd-condition-source");
        this.conditionSource.setAttribute("aria-label", "Drop the block to check here");
        this.installConditionSourceInteractions(this.conditionSource, () => this.applyCondition(false));
        this.on(this.conditionSource, "dragover", event => {
            if (!event.dataTransfer.types.includes("application/x-vnccs-prompt-block")) return;
            event.preventDefault(); event.dataTransfer.dropEffect = "copy";
        });
        this.on(this.conditionSource, "drop", event => {
            event.preventDefault();
            const id = event.dataTransfer.getData("application/x-vnccs-prompt-block");
            if (!this.state.blocks.some(block => block.id === id)) return;
            this.conditionSource.value = id;
            this.conditionSource.replaceChildren(this.chip(id));
            this.applyCondition(false);
        });
        this.conditionOperator = element("select");
        const emptyOperator = element("option", null, "Choose condition…"); emptyOperator.value = "";
        emptyOperator.disabled = true; emptyOperator.hidden = true; emptyOperator.selected = true;
        this.conditionOperator.append(emptyOperator);
        for (const [value, label] of Object.entries(CONDITION_OPERATORS)) {
            const option = element("option", null, label);
            option.value = value;
            this.conditionOperator.append(option);
        }
        this.conditionValue = element("input");
        this.conditionValue.maxLength = 64 * 1024;
        conditionRow.append(field("If block", this.conditionSource), field("Condition", this.conditionOperator), field("Comparison text", this.conditionValue));
        this.conditionExtraRows = element("div", "vnccs-pd-condition-extra-rows");
        const conditionTools = element("div", "vnccs-pd-tools");
        conditionTools.append(this.button("+ AND", () => this.addConditionClause("and")),
            this.button("+ OR", () => this.addConditionClause("or")));
        this.conditionOutput = element("div", "vnccs-pd-editor vnccs-pd-variant-editor");
        this.conditionElseOutput = element("div", "vnccs-pd-editor vnccs-pd-variant-editor");
        for (const [editor, label] of [[this.conditionOutput, "Then output"], [this.conditionElseOutput, "Else output (optional)"]]) {
            editor.contentEditable = "true"; editor.spellcheck = false;
            editor.setAttribute("role", "textbox");
            editor.setAttribute("aria-multiline", "true");
            editor.setAttribute("aria-label", `${label} text and blocks`);
            editor.dataset.placeholder = "Write text or drop blocks";
            this.installPromptInteractions(editor);
            this.on(editor, "input", () => { this.clearCardSelection(); this.applyCondition(false); });
            this.on(editor, "pointerup", () => {
                const selection = window.getSelection();
                if (selection?.rangeCount && editor.contains(selection.anchorNode)) editor.savedCaret = selection.getRangeAt(0).cloneRange();
            });
            this.on(editor, "paste", event => {
                event.preventDefault(); this.insertNode(document.createTextNode(event.clipboardData.getData("text/plain")), editor);
            });
            this.on(editor, "beforeinput", event => {
                if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
                    event.preventDefault(); this.insertNode(document.createTextNode("\n"), editor);
                } else if (["historyUndo", "historyRedo"].includes(event.inputType)) {
                    event.preventDefault(); this.moveHistory(event.inputType === "historyUndo" ? "undo" : "redo");
                }
            });
        }
        this.conditionPanel.append(conditionRow, this.conditionExtraRows, conditionTools,
            element("div", "vnccs-pd-hint", "AND is evaluated before OR. Checks use the nearest block insertion on the left, or the next insertion if none precedes If."),
            field("Then insert", this.conditionOutput), field("Else insert (optional)", this.conditionElseOutput),
            this.button("Apply condition", () => this.applyCondition()),
            this.button("Close", () => this.closeCondition()));
        this.main.append(this.conditionSuggestion);
        this.multiPanel = element("fieldset", "vnccs-pd-multi-panel");
        this.multiPanel.hidden = true;
        this.multiPanel.append(element("legend", null, "Multi-prompt"),
            element("div", "vnccs-pd-hint", "Each row replaces this fragment in its own output. Rows with the same number share an output."));
        this.multiRows = element("div", "vnccs-pd-multi-rows");
        this.multiPanel.append(this.multiRows, this.button("+ Add output", () => this.addMultiVariant()),
            this.button("Done", () => this.closeMultiPrompt()));
        this.main.append(this.editor,
            element("div", "vnccs-pd-hint", "Drop a block at the cursor · Type if, then Tab for a condition · Ctrl/Cmd+Z to undo"));
        const tools = element("div", "vnccs-pd-tools");
        tools.setAttribute("role", "toolbar"); tools.setAttribute("aria-label", "Prompt tools");
        this.ifTool = this.button("If", () => this.insertCondition(false));
        const multiTool = this.button("Multi-prompt", () => this.insertMultiPrompt());
        for (const button of [this.ifTool, multiTool]) this.on(button, "pointerdown", event => event.preventDefault());
        tools.append(this.ifTool, multiTool);
        this.main.append(tools);
        this.blockDoc = element("div", "vnccs-pd-doc");
        this.blockDoc.id = `vnccs-pd-block-${promptId()}`;
        this.blockDoc.setAttribute("role", "tabpanel");
        const blockHead = element("div", "vnccs-pd-doc-head");
        this.blockName = element("input");
        this.blockName.maxLength = 128;
        this.blockName.setAttribute("aria-label", "Block name");
        blockHead.append(this.blockName,
            this.button("Insert into prompt", () => this.insertBlock(this.state.activeTab)),
            this.button("Delete block", () => this.confirmLibraryDelete("block", this.activeBlock())));
        const variantsHead = element("div", "vnccs-pd-variants-head");
        this.blockStatus = element("span", "vnccs-pd-status");
        this.blockStatus.setAttribute("role", "status");
        this.variantsTitle = element("div", "vnccs-pd-heading", "Variants");
        variantsHead.append(this.variantsTitle, this.blockStatus);
        this.variants = element("ol", "vnccs-pd-variants");
        this.variants.setAttribute("aria-label", "Ready block variants");
        this.variants.setAttribute("role", "list");
        this.blockRaw = element("textarea", "vnccs-pd-editor vnccs-pd-source-text");
        this.blockRaw.hidden = true;
        this.blockRaw.spellcheck = false;
        this.blockRaw.maxLength = 64 * 1024;
        this.blockRaw.setAttribute("aria-label", "Block source text");
        this.blockDoc.append(blockHead, variantsHead, this.variants, this.blockRaw,
            element("div", "vnccs-pd-hint", "Dynamic Prompts: {~a|b|c} random · {@a|b|c} cycle · {2$$a|b|c} multiple"));
        editing.append(toolbar, this.main, this.blockDoc);
        this.inspector = element("aside", "vnccs-pd-inspector");
        this.inspector.hidden = true;
        this.inspector.setAttribute("aria-label", "Inspector");
        this.inspectorResize = element("div", "vnccs-pd-inspector-resize");
        this.inspectorResize.tabIndex = 0;
        this.inspectorResize.setAttribute("role", "separator");
        this.inspectorResize.setAttribute("aria-orientation", "vertical");
        this.inspectorResize.setAttribute("aria-label", "Resize inspector");
        this.inspectorResize.setAttribute("aria-valuemin", "240");
        this.inspectorResize.setAttribute("aria-valuenow", "310");
        this.inspector.append(this.inspectorResize);
        this.installPanelResize(this.inspector, this.inspectorResize, "inspector");
        const inspectorHead = element("div", "vnccs-pd-inspector-head");
        this.inspectorTitle = element("div", "vnccs-pd-heading", "Inspector");
        inspectorHead.append(this.inspectorTitle, this.button("Close", () => this.closeInspector()));
        this.cardPanel = element("div", "vnccs-pd-card-panel");
        this.cardPanel.hidden = true;
        this.blockView = element("div", "vnccs-pd-editor-modes");
        this.blockView.value = "variants";
        this.blockView.setAttribute("role", "group");
        this.blockView.setAttribute("aria-label", "Editor mode");
        for (const [value, label] of [["variants", "Variants"], ["text", "Text"]]) {
            const button = this.button(label, () => this.setBlockView(value));
            button.dataset.view = value;
            this.blockView.append(button);
        }
        this.blockMode = element("select");
        for (const [value, label] of [["random", "Random"], ["cycle", "Cycle"]]) {
            const option = element("option", null, label); option.value = value; this.blockMode.append(option);
        }
        this.blockColor = element("input");
        this.blockColor.type = "color";
        this.blockCategory = element("select");
        this.categoryColor = element("input"); this.categoryColor.type = "color";
        this.categoryColorField = field("Category color", this.categoryColor);
        this.cardPanel.append(field("Editor mode", this.blockView), field("Sampling mode", this.blockMode),
            field("Category", this.blockCategory), field("Card color", this.blockColor),
            this.button("Use category color", () => this.setBlockPreference("color", undefined)),
            this.categoryColorField, field("Search variants", this.blockSearch));
        this.promptPanel = element("div", "vnccs-pd-card-panel"); this.promptPanel.hidden = true;
        this.promptName = element("input"); this.promptName.maxLength = 128; this.promptName.placeholder = "Prompt name";
        this.promptCategory = element("select");
        this.promptColor = element("input"); this.promptColor.type = "color";
        this.promptSave = this.button("Save Prompt Template", () => this.saveLibraryPrompt());
        this.promptSaveCopy = this.button("Save as new", () => this.saveLibraryPrompt(true));
        this.promptDelete = this.button("Delete Prompt Template", () => this.confirmLibraryDelete("prompt", this.editingSavedPrompt));
        this.promptDelete.hidden = true;
        this.promptPanel.append(field("Name", this.promptName), field("Category", this.promptCategory), field("Prompt color", this.promptColor),
            this.promptSave, this.promptSaveCopy, this.promptDelete);
        this.inspector.append(inspectorHead, this.cardPanel, this.conditionPanel, this.multiPanel, this.promptPanel);
        workspace.append(library, editing, this.inspector);
        const preview = element("section", "vnccs-pd-preview");
        const previewHead = element("div", "vnccs-pd-preview-head");
        this.status = element("span", "vnccs-pd-status");
        this.status.hidden = true;
        this.status.setAttribute("role", "status");
        this.copy = this.button("Copy", async () => {
            try { await navigator.clipboard.writeText(this.output.textContent); }
            catch { this.setStatus("Clipboard unavailable. Select the preview text to copy it.", true); }
        });
        previewHead.append(element("div", "vnccs-pd-heading", "Final prompt"), this.status);
        this.output = element("pre", "vnccs-pd-output");
        this.output.tabIndex = 0;
        this.output.setAttribute("aria-label", "Resolved prompt preview");
        this.outputSelect = element("select");
        this.outputSelect.setAttribute("aria-label", "Preview output");
        this.outputSelect.hidden = true;
        previewHead.append(this.outputSelect, this.copy);
        this.on(this.outputSelect, "change", () => this.showResolvedPrompts(this.resolvedPrompts, Number(this.outputSelect.value)));
        preview.append(previewHead, this.output);
        const footer = element("div", "vnccs-pd-footer");
        const seedLabel = element("label", null, "Seed");
        this.seed = element("input", "vnccs-pd-seed");
        this.seed.inputMode = "numeric";
        this.seed.maxLength = 20;
        seedLabel.append(this.seed);
        const afterLabel = element("label", null, "After generate");
        this.after = element("select");
        for (const [value, label] of [["randomize", "Randomize"], ["fixed", "Keep seed"]]) {
            const option = element("option", null, label);
            option.value = value;
            this.after.append(option);
        }
        afterLabel.append(this.after);
        const shuffle = this.button("Shuffle preview", () => {
            if (hasCycle(this.state)) this.state.cycleIndex = Math.max(0, this.state.cycleIndex ?? -1) + 1;
            this.state.seed = randomSeed();
            this.seed.value = this.state.seed;
            this.commit();
        });
        shuffle.classList.add("primary", "vnccs-pd-shuffle");
        footer.append(seedLabel, afterLabel, shuffle);
        this.container.append(workspace, preview, footer);
        this.on(this.list, "scroll", () => this.savePanelScroll(this.list));
        for (const panel of [this.cardPanel, this.conditionPanel, this.multiPanel, this.promptPanel]) {
            this.on(panel, "scroll", () => {
                if (!panel.hidden && !this.inspector.hidden) this.savePanelScroll(panel, this.inspectorScrollKey);
            });
        }
        this.selects = installCustomSelects(this.container);
        this.on(this.search, "input", () => {
            this.renderLibrary();
            clearTimeout(this.libraryTimer);
            this.libraryTimer = setTimeout(() => {
                if (this.libraryView === "prompts") this.loadSavedPrompts();
                else { this.loadLibraryCards(); this.loadLibraryCards(true); }
            }, 200);
        });
        for (const control of [this.promptName, this.promptCategory, this.promptColor]) {
            this.on(control, control === this.promptCategory ? "change" : "input", () => this.savePromptDetails());
        }
        this.on(this.blockSearch, "input", () => {
            if (this.blockVariants) this.renderBlockVariants(this.blockVariants);
        });
        this.on(this.blockRaw, "input", () => this.saveBlockSource(this.blockRaw.value));
        this.on(this.editor, "input", event => {
            this.clearCardSelection();
            this.state.parts = readEditor(this.editor);
            if (this.editingMultiPrompt && !this.editor.contains(this.editingMultiPrompt)) this.closeMultiPrompt(false);
            if (this.editingCondition && !this.editor.contains(this.editingCondition)) this.closeCondition(false);
            this.commit("prompt");
            if (!event.isComposing) { this.rememberCaret(); this.updateConditionSuggestion(); }
        });
        this.on(this.editor, "keyup", () => { this.rememberCaret(); this.updateConditionSuggestion(); });
        this.on(this.editor, "pointerup", () => { this.rememberCaret(); this.updateConditionSuggestion(); });
        this.on(this.conditionSuggestion, "pointerdown", event => event.preventDefault());
        for (const control of [this.conditionOperator, this.conditionValue]) {
            this.on(control, control === this.conditionValue ? "input" : "change", () => this.applyCondition(false));
        }
        this.on(this.blockMode, "change", () => this.setBlockPreference("mode", this.blockMode.value));
        this.on(this.blockColor, "input", () => this.setBlockPreference("color", this.blockColor.value));
        this.on(this.blockCategory, "change", () => this.setBlockPreference("category", this.blockCategory.value));
        this.on(this.categoryColor, "input", () => this.setCategoryColor());
        this.on(this.categoryName, "keydown", event => {
            if (event.key === "Enter") { event.preventDefault(); this.addCategory(); }
        });
        this.installPromptInteractions(this.editor);
        this.on(this.editor, "paste", event => {
            event.preventDefault();
            this.insertNode(document.createTextNode(event.clipboardData.getData("text/plain")));
        });
        this.on(this.editor, "beforeinput", event => {
            if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
                event.preventDefault();
                this.insertNode(document.createTextNode("\n"));
            } else if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
                event.preventDefault();
                this.moveHistory(event.inputType === "historyUndo" ? "undo" : "redo");
            }
        });
        this.on(this.blockName, "input", () => {
            const block = this.activeBlock();
            if (!block) return;
            this.renameLibraryBlock(block, this.blockName.value);
        });
        this.on(this.seed, "input", () => { this.state.seed = this.seed.value; this.commit("seed"); });
        this.on(this.after, "change", () => { this.state.afterGenerate = this.after.value; this.persist(); });
        this.on(this.container, "keydown", event => {
            event.stopPropagation();
            if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
                && !event.isComposing && this.editor.contains(event.target) && !this.conditionSuggestion.hidden) {
                event.preventDefault();
                this.insertCondition();
            } else if ((event.ctrlKey || event.metaKey) && !event.altKey && ["z", "y"].includes(event.key.toLowerCase())) {
                event.preventDefault();
                this.moveHistory(event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo");
            } else if (!event.isComposing && this.selectedCard && this.selectedEditor?.contains(this.selectedCard)
                && (this.selectedCard.contains(event.target) || event.target === this.selectedEditor)
                && ["Enter", "Delete", "Backspace"].includes(event.key)) {
                event.preventDefault();
                if (event.key === "Enter") this.openSelectedCard();
                else this.deleteSelectedCard();
            } else if (event.target.dataset?.blockId && event.key === "Enter") {
                event.preventDefault(); this.openBlock(event.target.dataset.blockId);
            }
        });
        this.on(this.container, "paste", event => event.stopPropagation());
        this.on(this.container, "pointerdown", event => { if (event.button !== 1) event.stopPropagation(); });
        this.on(this.container, "wheel", event => event.stopPropagation(), { passive: true });
        if (globalThis.window?.addEventListener) this.on(window, "beforeunload", event => {
            this.documentStorage?.flush();
            if (this.documentStorage?.localError && this.documentStorage?.pending) {
                event.preventDefault(); event.returnValue = "";
            }
        });
        // Constructors run before ComfyUI applies widgets_values; never write defaults here.
        this.loadFromNode(true);
    }

    on(target, type, listener, options = {}) {
        target.addEventListener(type, listener, { ...options, signal: this.events.signal });
    }

    button(label, action) {
        const button = element("button", null, label);
        button.type = "button";
        this.on(button, "click", action);
        return button;
    }

    clearCardSelection() {
        this.selectedCard?.classList.remove("selected");
        this.selectedCard?.setAttribute("aria-pressed", "false");
        this.selectedCard = null;
        this.selectedEditor = null;
    }

    selectCard(card, editor, focus = true) {
        this.clearCardSelection();
        this.selectedCard = card;
        this.selectedEditor = editor;
        card.classList.add("selected");
        card.setAttribute("aria-pressed", "true");
        if (focus) { window.getSelection()?.removeAllRanges(); card.focus({ preventScroll: true }); }
    }

    openSelectedCard() {
        const card = this.selectedCard;
        if (card?.dataset.multiPrompt) this.editMultiPrompt(card);
        else if (card?.dataset.condition) this.editCondition(card);
        else if (card?.dataset.blockId) this.openBlock(card.dataset.blockId);
    }

    savePromptEditor(editor) {
        this.syncEditorLineEnd(editor);
        if (editor === this.editor) {
            if (this.editingCondition && !editor.contains(this.editingCondition)) this.closeCondition(false);
            if (this.editingMultiPrompt && !editor.contains(this.editingMultiPrompt)) this.closeMultiPrompt(false);
            this.state.parts = readEditor(editor);
            this.commit();
        } else if (editor.dataset.inlineConditionOutput) this.saveInlineCondition(editor.closest("[data-condition]"));
        else if (editor === this.conditionOutput || editor === this.conditionElseOutput) this.applyCondition(false);
        else this.saveMultiPrompt();
    }

    deleteSelectedCard() {
        const card = this.selectedCard, editor = this.selectedEditor;
        if (!card || !editor?.contains(card)) return;
        const range = document.createRange();
        range.setStartBefore(card); range.collapse(true);
        this.clearCardSelection();
        card.remove();
        editor.focus({ preventScroll: true });
        this.selectRange(range);
        if (editor === this.editor) this.caret = range.cloneRange(); else editor.savedCaret = range.cloneRange();
        this.savePromptEditor(editor);
    }

    installConditionSourceInteractions(source, save) {
        source.tabIndex = 0;
        const cardAt = target => target.closest?.("[data-block-id]");
        this.on(source, "click", event => {
            event.stopPropagation();
            const card = cardAt(event.target);
            if (card && source.contains(card)) this.selectCard(card, source);
            else this.clearCardSelection();
        });
        this.on(source, "focusin", event => {
            event.stopPropagation();
            const card = cardAt(event.target);
            if (card && source.contains(card)) this.selectCard(card, source, false);
        });
        this.on(source, "dblclick", event => {
            event.stopPropagation();
            const card = cardAt(event.target);
            if (!card || !source.contains(card)) return;
            event.preventDefault(); this.selectCard(card, source); this.openSelectedCard();
        });
        this.on(source, "keydown", event => {
            if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || this.selectedEditor !== source
                || !this.selectedCard || !source.contains(this.selectedCard) || !["Enter", "Delete", "Backspace"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            if (event.key === "Enter") this.openSelectedCard();
            else {
                this.clearCardSelection(); source.replaceChildren(); source.value = "";
                source.focus({ preventScroll: true }); save();
            }
        });
        this.on(source, "dragstart", event => {
            const id = source.querySelector("[data-block-id]")?.dataset.blockId;
            if (!id) { event.preventDefault(); return; }
            event.stopPropagation(); this.promptDrag = null;
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("application/x-vnccs-prompt-block", id);
        });
    }

    installPromptInteractions(editor) {
        this.syncEditorLineEnd(editor);
        this.on(editor, "input", () => this.syncEditorLineEnd(editor));
        const cardAt = target => {
            const card = (target.nodeType === 1 ? target : target.parentElement)?.closest(CARD_SELECTOR);
            return card && editor.contains(card) ? card : null;
        };
        this.on(editor, "keydown", event => {
            if (event.isComposing || event.target.closest?.("input, textarea, select")) return;
            if (event.key === " " && !event.ctrlKey && !event.metaKey && !event.altKey
                && this.selectedEditor === editor && editor.contains(this.selectedCard)
                && (event.target === editor || this.selectedCard.contains(event.target))) {
                event.preventDefault(); event.stopPropagation();
                const range = document.createRange(); range.setStartAfter(this.selectedCard); range.collapse(true);
                this.selectRange(range);
                this.insertNode(document.createTextNode(" "), editor);
                return;
            }
            if (!["Delete", "Backspace"].includes(event.key)) return;
            const selection = window.getSelection();
            if (!selection?.rangeCount || selection.isCollapsed || !editor.contains(selection.anchorNode)
                || !editor.contains(selection.focusNode)) return;
            const range = selection.getRangeAt(0).cloneRange();
            const startCard = cardAt(range.startContainer), endCard = cardAt(range.endContainer);
            // Keep atomic cards when a text selection only reaches into their boundary.
            if (startCard) range.setStartAfter(startCard);
            if (endCard) range.setEndBefore(endCard);
            event.preventDefault(); event.stopPropagation();
            this.clearCardSelection();
            range.deleteContents(); range.collapse(true);
            editor.focus({ preventScroll: true }); this.selectRange(range);
            if (editor === this.editor) this.caret = range.cloneRange(); else editor.savedCaret = range.cloneRange();
            this.savePromptEditor(editor);
        });
        this.on(editor, "click", event => {
            const card = cardAt(event.target);
            const selection = window.getSelection();
            if (card && selection?.rangeCount && !selection.isCollapsed
                && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) {
                const range = selection.getRangeAt(0), cardRange = document.createRange();
                cardRange.selectNode(card);
                if (range.compareBoundaryPoints(Range.START_TO_START, cardRange) < 0
                    || range.compareBoundaryPoints(Range.END_TO_END, cardRange) > 0) {
                    this.clearCardSelection(); return;
                }
            }
            if (card) this.selectCard(card, editor);
            else this.clearCardSelection();
        });
        this.on(editor, "dblclick", event => {
            const card = cardAt(event.target);
            if (!card) return;
            event.preventDefault();
            this.selectCard(card, editor);
            this.openSelectedCard();
        });
        this.on(editor, "focusin", event => {
            const card = cardAt(event.target);
            if (card) this.selectCard(card, editor, false);
        });
        this.on(editor, "dragstart", event => {
            const card = cardAt(event.target);
            const handle = event.target.closest?.(".vnccs-pd-condition-handle");
            if (card?.dataset.condition && !handle) { event.preventDefault(); return; }
            const selection = window.getSelection();
            const range = !handle && selection?.rangeCount && !selection.isCollapsed
                && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)
                ? selection.getRangeAt(0).cloneRange() : null;
            if (range && (!card || range.intersectsNode(card))) {
                const start = cardAt(range.startContainer);
                const end = cardAt(range.endContainer);
                if (start) range.setStartBefore(start);
                if (end) range.setEndAfter(end);
                this.clearCardSelection();
                this.promptDrag = { editor, range };
            } else if (card) {
                this.selectCard(card, editor, false);
                this.promptDrag = { editor, card };
            } else return;
            event.dataTransfer.effectAllowed = "copyMove";
            event.dataTransfer.setData("application/x-vnccs-prompt-fragment", "move");
            if (this.promptDrag.card?.dataset.blockId) event.dataTransfer.setData("application/x-vnccs-prompt-block", this.promptDrag.card.dataset.blockId);
            event.dataTransfer.setData("text/plain", this.promptDrag.card?.textContent ?? this.promptDrag.range.toString());
        });
        this.on(editor, "dragover", event => {
            const types = event.dataTransfer.types;
            if (!types.includes("application/x-vnccs-prompt-fragment") && !types.includes("application/x-vnccs-prompt-block") && !types.includes("text/plain")) return;
            event.preventDefault();
            if (types.includes("application/x-vnccs-prompt-fragment") && !this.promptDrag) { event.dataTransfer.dropEffect = "none"; return; }
            if (this.promptDrag && this.promptDrag.editor !== editor && !this.promptDrag.card?.dataset.blockId) { event.dataTransfer.dropEffect = "none"; return; }
            event.dataTransfer.dropEffect = this.promptDrag?.editor === editor ? "move" : "copy";
            editor.classList.add("dragging");
            const range = this.rangeAt(event.clientX, event.clientY, editor);
            if (range) {
                if (editor === this.editor) this.caret = range; else editor.savedCaret = range;
                this.selectRange(range);
            }
        });
        this.on(editor, "dragleave", () => editor.classList.remove("dragging"));
        this.on(editor, "drop", event => {
            event.preventDefault();
            editor.classList.remove("dragging");
            const drag = this.promptDrag?.editor === editor ? this.promptDrag : null;
            const copiedCard = this.promptDrag?.card?.dataset.blockId;
            if (event.dataTransfer.types.includes("application/x-vnccs-prompt-fragment") && !drag && !copiedCard) return;
            const range = this.rangeAt(event.clientX, event.clientY, editor);
            if (!range) return;
            let node, last;
            if (drag) {
                const source = drag.range ?? document.createRange();
                if (drag.card) {
                    if (!editor.contains(drag.card)) return;
                    source.selectNode(drag.card);
                }
                if (source.comparePoint(range.startContainer, range.startOffset) === 0) return;
                node = source.extractContents();
                last = node.lastChild;
            } else {
                const id = event.dataTransfer.getData("application/x-vnccs-prompt-block");
                node = this.state.blocks.some(block => block.id === id) ? this.chip(id)
                    : document.createTextNode(event.dataTransfer.getData("text/plain"));
                last = node;
            }
            if (!last) return;
            range.insertNode(node); range.setStartAfter(last); range.collapse(true);
            this.promptDrag = null;
            this.clearCardSelection();
            editor.focus({ preventScroll: true });
            this.selectRange(range);
            if (editor === this.editor) this.caret = range.cloneRange(); else editor.savedCaret = range.cloneRange();
            if (drag?.card) this.selectCard(drag.card, editor, false);
            this.savePromptEditor(editor);
        });
        this.on(editor, "dragend", () => {
            if (this.promptDrag?.range) this.selectRange(this.promptDrag.range);
            this.promptDrag = null;
            editor.classList.remove("dragging");
        });
    }

    dataWidget() { return this.node.widgets?.find(widget => widget.name === "node_state"); }
    activeBlock() { return this.state.blocks.find(block => block.id === this.state.activeTab); }

    setBlockView(view) {
        const block = this.activeBlock();
        if (!block) return;
        this.scroll.set(block.id, { ...this.scroll.get(block.id), view,
            ...(!this.blockRaw.hidden ? { top: this.blockRaw.scrollTop, left: this.blockRaw.scrollLeft,
                start: this.blockRaw.selectionStart, end: this.blockRaw.selectionEnd } : {}) });
        this.blockView.value = view;
        this.renderBlockVariants();
        (view === "text" ? this.blockRaw : this.variants.querySelector(".vnccs-pd-variant-text"))?.focus({ preventScroll: true });
    }

    installPanelResize(panel, handle, side) {
        const direction = side === "library" ? 1 : -1;
        let drag;
        this.on(handle, "pointerdown", event => {
            if (event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            drag = { pointerId: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width,
                scale: this.container.getBoundingClientRect().width / this.container.offsetWidth };
            handle.setPointerCapture(event.pointerId);
        });
        this.on(handle, "pointermove", event => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            this.setPanelWidth(side, (drag.width + direction * (event.clientX - drag.x)) / drag.scale);
        });
        const finish = event => { if (drag?.pointerId === event.pointerId) drag = null; };
        this.on(handle, "pointerup", finish); this.on(handle, "pointercancel", finish);
        this.on(handle, "keydown", event => {
            if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            const scale = this.container.getBoundingClientRect().width / this.container.offsetWidth;
            this.setPanelWidth(side, panel.getBoundingClientRect().width / scale + direction * (event.key === "ArrowRight" ? 20 : -20));
        });
    }

    setPanelWidth(side, width) {
        const otherWidth = side === "library" ? this.inspector.hidden ? 0 : this.inspector.offsetWidth : this.library.offsetWidth;
        const maximum = Math.max(240, Math.min(4096, this.workspace.clientWidth - otherWidth - 240));
        width = Math.round(Math.min(maximum, Math.max(240, width)));
        this.node.properties ??= {};
        this.node.properties[side === "library" ? "promptDesignerLibraryWidth" : "promptDesignerInspectorWidth"] = width;
        this.container.style.setProperty(`--pd-${side}-width`, `${width}px`);
        const handle = side === "library" ? this.libraryResize : this.inspectorResize;
        handle.setAttribute("aria-valuenow", String(width));
        handle.setAttribute("aria-valuemax", String(maximum));
        this.node.setDirtyCanvas?.(true, true);
        this.node.graph?.change?.();
    }

    savePanelScroll(panel, key = null) {
        if (this.disposed || this.restoring || this.rendering || this.container.inert) return;
        if (panel === this.list && (this.diskLibraryLoading || this.bundledLibraryLoading)) return;
        this.node.properties ??= {};
        const scroll = this.node.properties.promptDesignerPanelScroll ?? {};
        const previous = key ? scroll.inspector?.[key] : scroll.libraryViews?.[this.libraryView] ?? scroll.library;
        const position = { top: panel.scrollTop, left: panel.scrollLeft };
        if (previous?.top === position.top && previous?.left === position.left) return;
        this.node.properties.promptDesignerPanelScroll = key
            ? { ...scroll, inspector: { ...scroll.inspector, [key]: position } }
            : { ...scroll, library: position, libraryViews: { ...scroll.libraryViews, [this.libraryView]: position } };
        this.node.graph?.change?.();
    }

    categoryDefinitions() {
        const cards = [...this.state.blocks, ...(this.savedCards ?? []), ...(this.defaultCards ?? []), ...(this.savedPrompts ?? [])];
        return mergeCategories(this.state.categories, [...(this.savedCategories ?? []),
            ...cards.filter(card => card.category).map(card => ({ name: card.category }))]);
    }

    setLibraryView(view) {
        this.savePanelScroll(this.list);
        this.libraryView = view;
        this.node.properties.promptDesignerLibraryTab = view;
        this.search.value = ""; this.libraryCategory = "";
        this.renderLibrary(); this.node.graph?.change?.();
        if (view === "prompts") this.loadSavedPrompts();
        else { this.loadLibraryCards(); this.loadLibraryCards(true); }
    }

    refreshPromptCategories() {
        if (!this.promptCategory) return;
        const value = this.promptCategory.value;
        const empty = element("option", null, "Uncategorized"); empty.value = "";
        this.promptCategory.replaceChildren(empty, ...this.categoryDefinitions().map(category => {
            const option = element("option", null, category.name); option.value = category.name; return option;
        }));
        this.promptCategory.value = value;
    }

    ensurePromptTabs() {
        this.promptBaselines ??= new Map();
        this.promptHistories ??= new Map();
        if (!this.state.promptTabs) {
            const details = { ...(this.node.properties?.promptDesignerPromptDetails ?? {}) };
            const tab = { id: promptId(), parts: mergeText(this.state.parts), seed: this.state.seed,
                afterGenerate: this.state.afterGenerate, cycleIndex: this.state.cycleIndex, details, dirty: true };
            this.state.promptTabs = [tab]; this.state.activePrompt = tab.id;
        }
        for (const tab of this.state.promptTabs) {
            if (!tab.dirty && !this.promptBaselines.has(tab.id)) this.promptBaselines.set(tab.id, promptSignature(this.promptTabState(tab), tab.details));
        }
    }

    activePrompt() { return this.state.promptTabs?.find(tab => tab.id === this.state.activePrompt); }

    promptTabState(tab) {
        return { ...this.state, parts: tab.parts, seed: tab.seed, afterGenerate: tab.afterGenerate, cycleIndex: tab.cycleIndex };
    }

    capturePromptTabs() {
        this.ensurePromptTabs();
        Object.assign(this.activePrompt(), { parts: mergeText(this.state.parts), seed: this.state.seed,
            afterGenerate: this.state.afterGenerate, cycleIndex: this.state.cycleIndex });
        for (const tab of this.state.promptTabs) {
            const baseline = this.promptBaselines.get(tab.id);
            tab.dirty = baseline === undefined || baseline !== promptSignature(this.promptTabState(tab), tab.details);
        }
    }

    restorePromptDetails() {
        const details = this.activePrompt()?.details ?? {};
        this.editingSavedPrompt = details.id ? { ...details } : null;
        this.node.properties ??= {};
        this.node.properties.promptDesignerPromptDetails = { ...details };
        this.promptName.value = details.name ?? "";
        this.refreshPromptCategories(); this.promptCategory.value = details.category ?? "";
        this.promptColor.value = details.color ?? "#b8a9e8";
        this.promptSave.textContent = this.activePrompt()?.templateId ? "Save Changes" : "Save Prompt Template";
        this.promptSaveCopy.hidden = !this.activePrompt()?.templateId; this.promptDelete.hidden = !(details.revision > 0);
    }

    switchPrompt(id) {
        if (this.state.activeTab !== "prompt") this.switchTab("prompt");
        this.capturePromptTabs();
        const tab = this.state.promptTabs.find(tab => tab.id === id);
        if (!tab) return;
        this.promptHistories.set(this.state.activePrompt, this.history);
        this.history = this.promptHistories.get(id) ?? new EditHistory();
        this.undo.disabled = !this.history.undoStack.length; this.redo.disabled = !this.history.redoStack.length;
        this.scroll.set(`prompt:${this.state.activePrompt}`, { top: this.editor.scrollTop, left: this.editor.scrollLeft });
        Object.assign(this.state, { parts: mergeText(tab.parts), seed: tab.seed, afterGenerate: tab.afterGenerate,
            cycleIndex: tab.cycleIndex, activePrompt: id, activeTab: "prompt" });
        this.caret = null; this.promptDrag = null;
        this.restorePromptDetails(); this.render(); this.commit(null, false);
        const scroll = this.scroll.get(`prompt:${id}`);
        this.editor.scrollTop = scroll?.top ?? 0; this.editor.scrollLeft = scroll?.left ?? 0;
        this.editor.focus({ preventScroll: true }); this.history.group = null;
    }

    newPrompt() {
        this.capturePromptTabs();
        const tab = { id: promptId(), parts: [], seed: "0", afterGenerate: "randomize", details: {}, dirty: true };
        try { this.state = normalizeState({ ...this.state, promptTabs: [...this.state.promptTabs, tab] }); }
        catch (error) { this.setStatus(error.message, true); return; }
        this.switchPrompt(tab.id);
    }

    closePrompt(id) {
        if (this.promptSaving) { this.setStatus("Wait for the template save to finish before closing a prompt.", true); return; }
        this.capturePromptTabs();
        const tab = this.state.promptTabs.find(tab => tab.id === id);
        if (!tab) return;
        if ((!tab.dirty && tab.details.revision > 0) || !tab.parts.length) { this.removePromptTab(id); return; }
        this.libraryActions.dialog({ title: "Save prompt before closing?",
            message: "This prompt has unsaved work. Closing without saving a template will discard it.",
            value: tab.details.name ?? "", label: "Save", discard: () => this.removePromptTab(id),
            action: async name => {
                const saved = await this.saveLibraryPrompt(false, id, { ...tab.details, name });
                if (!saved) throw new Error(this.status.textContent || "Prompt could not be saved. Your tab is retained.");
                // A later edit during the request must remain open.
                this.capturePromptTabs();
                if (this.state.promptTabs.find(item => item.id === id)?.dirty) throw new Error("Newer edits are still unsaved. Save again before closing.");
                this.removePromptTab(id);
            } });
    }

    removePromptTab(id) {
        const index = this.state.promptTabs.findIndex(tab => tab.id === id);
        if (index < 0) return;
        const active = this.state.activePrompt === id;
        this.state.promptTabs.splice(index, 1); this.promptBaselines.delete(id); this.promptHistories.delete(id); this.scroll.delete(`prompt:${id}`);
        if (!this.state.promptTabs.length) this.state.promptTabs.push({ id: promptId(), parts: [], seed: "0", afterGenerate: "randomize", details: {}, dirty: true });
        if (active) {
            const tab = this.state.promptTabs[Math.min(index, this.state.promptTabs.length - 1)];
            Object.assign(this.state, { activePrompt: tab.id, parts: mergeText(tab.parts), seed: tab.seed,
                afterGenerate: tab.afterGenerate, cycleIndex: tab.cycleIndex, activeTab: "prompt" });
            this.history = this.promptHistories.get(tab.id) ?? new EditHistory();
            this.caret = null; this.restorePromptDetails(); this.render();
        } else this.renderTabs();
        this.commit(null, false);
    }

    editPromptDetails() {
        if (this.state.activeTab !== "prompt") this.switchTab("prompt");
        this.ensurePromptTabs();
        const details = this.node.properties?.promptDesignerPromptDetails ?? {};
        this.promptName.value = details.name ?? "";
        this.refreshPromptCategories(); this.promptCategory.value = details.category ?? this.libraryCategory;
        this.promptColor.value = details.color ?? "#b8a9e8";
        this.promptSave.textContent = this.activePrompt()?.templateId ? "Save Changes" : "Save Prompt Template";
        this.promptSaveCopy.hidden = !this.activePrompt()?.templateId;
        this.promptDelete.hidden = !(this.editingSavedPrompt?.revision > 0);
        this.showInspector(this.promptPanel, "prompt-details", "Inspector · Prompt");
        this.promptName.focus({ preventScroll: true });
    }

    savePromptDetails() {
        this.ensurePromptTabs();
        this.node.properties ??= {};
        const details = this.node.properties.promptDesignerPromptDetails = { ...this.activePrompt().details,
            name: this.promptName.value, category: this.promptCategory.value, color: this.promptColor.value };
        this.activePrompt().details = { ...details };
        this.renderTabs(); this.commit("prompt-details");
    }

    async loadSavedPrompts() {
        const revision = this.promptLibraryRevision = (this.promptLibraryRevision ?? 0) + 1;
        const prompts = [], query = encodeURIComponent(this.search.value);
        try {
            let offset = 0;
            while (true) {
                const response = await this.api.fetchApi(`/vnccs/prompt_designer/prompts?q=${query}&offset=${offset}`);
                const result = await readPromptResponse(response);
                if (this.disposed || revision !== this.promptLibraryRevision) return;
                if (!response.ok) throw new Error(result.error || "Saved prompts could not be read.");
                prompts.push(...result.prompts); offset += result.prompts.length;
                if (!result.prompts.length || offset >= result.total) break;
            }
            this.savedPrompts = prompts; this.renderLibrary(); this.refreshPromptCategories();
        } catch (error) { if (!this.disposed && revision === this.promptLibraryRevision) this.setStatus(error.message, true); }
    }

    async saveLibraryPrompt(asNew = false, tabId = this.state.activePrompt, details = null) {
        if (this.promptSaving || this.restoring || this.restoreError || this.container.inert) return false;
        this.capturePromptTabs();
        const tab = this.state.promptTabs.find(tab => tab.id === tabId) ?? this.activePrompt();
        const metadata = details ?? { name: this.promptName.value, category: this.promptCategory.value, color: this.promptColor.value };
        const name = metadata.name.trim();
        if (!name) { this.setStatus("Enter a prompt name.", true); this.promptName.focus(); return false; }
        let snapshot;
        try { snapshot = promptSnapshot(this.promptTabState(tab)); }
        catch (error) { this.setStatus(error.message, true); return false; }
        const templateId = !asNew && tab.templateId === tab.details.id ? tab.templateId : null;
        const entry = { id: templateId || promptId(),
            revision: templateId ? tab.details.revision : 0,
            name, category: metadata.category ?? "", color: metadata.color ?? "#b8a9e8" };
        const category = this.categoryDefinitions().find(item => item.name === entry.category);
        if (category) snapshot.categories = [...snapshot.categories.filter(item => item.name !== category.name), category];
        const state = { ...snapshot, savedPrompt: { name: entry.name, category: entry.category, color: entry.color } };
        if (!templateId) delete tab.templateId;
        tab.details = { ...entry };
        if (tab.id === this.state.activePrompt) this.restorePromptDetails();
        this.persist();
        const restoreRevision = this.restoreRevision;
        this.promptSaving = true;
        for (const button of [this.promptSave, this.promptSaveCopy, this.promptDelete]) button.disabled = true;
        try {
            const response = await this.api.fetchApi(`/vnccs/prompt_designer/documents/${encodeURIComponent(entry.id)}`, {
                method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state, revision: entry.revision }),
                signal: AbortSignal.timeout(30_000),
            });
            const result = await readPromptResponse(response);
            if (!response.ok) throw new Error(result.error || "Prompt could not be saved.");
            if (!Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error("Invalid prompt save acknowledgement.");
            entry.revision = result.revision;
            if (this.disposed || restoreRevision !== this.restoreRevision) return false;
            const owner = this.state.promptTabs.find(item => item.id === tab.id);
            if (owner?.details.id === entry.id) {
                owner.details.revision = entry.revision;
                this.promptBaselines.set(owner.id, promptSignature(snapshot, entry));
                if (owner.id === this.state.activePrompt) this.restorePromptDetails();
                this.persist(); this.renderTabs();
            }
            const summary = { ...entry, text: snapshot.parts.filter(part => "text" in part).map(part => part.text).join("").slice(0, 160) };
            this.savedPrompts = [...(this.savedPrompts ?? []).filter(prompt => prompt.id !== entry.id), summary];
            this.renderLibrary(); this.setStatus(""); await this.loadSavedPrompts(); return true;
        } catch (error) { if (!this.disposed) this.setStatus(`Prompt was not saved: ${error.message}. Your current edits are retained.`, true); return false; }
        finally {
            this.promptSaving = false;
            for (const button of [this.promptSave, this.promptSaveCopy, this.promptDelete]) button.disabled = false;
        }
    }

    deleteLibraryPrompt(entry = this.editingSavedPrompt) {
        return this.changeLibraryPrompt(entry, null);
    }

    async changeLibraryPrompt(entry, name) {
        if (!entry || entry.revision < 1 || this.promptSaving || this.restoring || this.restoreError || this.container.inert) return false;
        const deleting = name === null;
        const restoreRevision = this.restoreRevision;
        this.promptSaving = true;
        for (const button of [this.promptSave, this.promptSaveCopy, this.promptDelete]) button.disabled = true;
        try {
            const url = `/vnccs/prompt_designer/documents/${encodeURIComponent(entry.id)}`;
            const response = await this.api.fetchApi(url, { signal: AbortSignal.timeout(30_000) });
            const result = await readPromptResponse(response);
            if (!response.ok) throw new Error(result.error || "Template could not be read.");
            if (!Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error("Invalid template revision.");
            let revision = result.revision;
            if (!deleting && !result.state?.savedPrompt) throw new Error("Saved prompt is unavailable.");
            if (result.state?.savedPrompt) {
                if (result.revision !== entry.revision) throw new Error("The template has newer edits. Reopen it before changing it.");
                const state = { ...result.state };
                if (deleting) delete state.savedPrompt;
                else state.savedPrompt = { ...state.savedPrompt, name };
                const saved = await this.api.fetchApi(url, { method: "PUT", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ state, revision: entry.revision }), signal: AbortSignal.timeout(30_000) });
                const acknowledgement = await readPromptResponse(saved);
                if (!saved.ok) throw new Error(acknowledgement.error || "Template could not be changed.");
                if (!Number.isSafeInteger(acknowledgement.revision) || acknowledgement.revision <= entry.revision) throw new Error("Invalid template change acknowledgement.");
                revision = acknowledgement.revision;
            }
            if (this.disposed || restoreRevision !== this.restoreRevision) return true;
            this.promptLibraryRevision = (this.promptLibraryRevision ?? 0) + 1;
            this.savedPromptLoadRevision = (this.savedPromptLoadRevision ?? 0) + 1;
            this.savedPrompts = deleting ? (this.savedPrompts ?? []).filter(prompt => prompt.id !== entry.id)
                : (this.savedPrompts ?? []).map(prompt => prompt.id === entry.id ? { ...prompt, name, revision } : prompt);
            for (const tab of this.state.promptTabs ?? []) {
                if (tab.details.id !== entry.id) continue;
                if (deleting) {
                    delete tab.templateId; delete tab.details.id; delete tab.details.revision; tab.dirty = true; this.promptBaselines.delete(tab.id);
                } else {
                    if (tab.templateId !== entry.id) continue;
                    tab.details.name = name; tab.details.revision = revision;
                    const baseline = this.promptBaselines.get(tab.id);
                    if (baseline) {
                        const snapshot = JSON.parse(baseline); snapshot.details.name = name;
                        this.promptBaselines.set(tab.id, JSON.stringify(snapshot));
                    }
                }
                if (tab.id === this.state.activePrompt) this.restorePromptDetails();
            }
            this.persist(); this.renderTabs(); this.renderLibrary(); this.setStatus("");
            return true;
        } catch (error) {
            if (!this.disposed) this.setStatus(`Template was not ${deleting ? "deleted" : "renamed"}: ${error.message}`, true);
            return false;
        } finally {
            this.promptSaving = false;
            for (const button of [this.promptSave, this.promptSaveCopy, this.promptDelete]) button.disabled = false;
        }
    }

    async openSavedPrompt(entry) {
        const request = this.savedPromptLoadRevision = (this.savedPromptLoadRevision ?? 0) + 1;
        this.ensurePromptTabs();
        const existing = this.state.promptTabs.find(tab => tab.templateId === entry.id);
        if (existing) { this.switchPrompt(existing.id); this.editPromptDetails(); return; }
        const value = this.persisted;
        try {
            const response = await this.api.fetchApi(`/vnccs/prompt_designer/documents/${encodeURIComponent(entry.id)}`);
            const result = await readPromptResponse(response);
            if (this.disposed || this.restoring || this.container.inert || request !== this.savedPromptLoadRevision || value !== this.persisted) return;
            if (!response.ok) throw new Error(result.error || "Prompt could not be opened.");
            if (!result.state?.savedPrompt || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error("Saved prompt is unavailable.");
            this.capturePromptTabs();
            const next = openPromptState(this.state, result.state);
            const details = { ...result.state.savedPrompt };
            details.category = next.categories.find(category => category.name.toLowerCase() === details.category.toLowerCase())?.name ?? details.category;
            const tab = { id: promptId(), templateId: entry.id, parts: next.parts, seed: next.seed, afterGenerate: next.afterGenerate,
                cycleIndex: next.cycleIndex, details: { id: entry.id, revision: result.revision, ...details }, dirty: false };
            // Keep the currently edited prompt intact while importing the template's blocks.
            this.state = normalizeState({ ...this.state, blocks: next.blocks, categories: next.categories,
                promptTabs: [...this.state.promptTabs, tab] });
            this.promptBaselines.set(tab.id, promptSignature(this.promptTabState(tab), tab.details));
            this.switchPrompt(tab.id); this.editPromptDetails();
        } catch (error) { if (!this.disposed && request === this.savedPromptLoadRevision) this.setStatus(error.message, true); }
    }

    cardColor(block) {
        const color = this.categoryDefinitions().find(category => category.name.toLowerCase() === block.category?.toLowerCase())?.color;
        return (this.state.blocks.includes(block) ? block.color : undefined) ?? color ?? block.color ?? "#b8a9e8";
    }

    addCategory() {
        const name = this.categoryName.value.trim();
        if (!name) return;
        const existing = this.categoryDefinitions().find(category => category.name.toLowerCase() === name.toLowerCase());
        try {
            if (!existing) this.state = normalizeState({ ...this.state, categories: [...this.state.categories, { name }] });
        } catch (error) { this.setStatus(error.message, true); return; }
        this.libraryCategory = existing?.name ?? name;
        this.categoryForm.hidden = true; this.categoryName.value = "";
        this.commit(); this.renderLibrary(); this.refreshCardCategories();
        this.refreshPromptCategories();
    }

    refreshCardCategories() {
        const block = this.activeBlock();
        if (!block) return;
        const empty = element("option", null, "Uncategorized"); empty.value = "";
        this.blockCategory.replaceChildren(empty, ...this.categoryDefinitions().map(category => {
            const option = element("option", null, category.name); option.value = category.name; return option;
        }));
        this.blockCategory.value = block.category ?? "";
        this.blockColor.value = this.cardColor(block);
        this.categoryColorField.hidden = !block.category;
        this.categoryColor.value = this.categoryDefinitions().find(category => category.name === block.category)?.color ?? "#b8a9e8";
    }

    setCategoryColor() {
        const name = this.activeBlock()?.category;
        if (!name) return;
        const categories = this.state.categories.filter(category => category.name !== name);
        categories.push({ name, color: this.categoryColor.value });
        try {
            this.state = normalizeState({ ...this.state, categories, blocks: this.state.blocks.map(block => {
                if (block.category !== name) return block;
                const { color, ...inherited } = block;
                return inherited;
            }) });
        } catch (error) { this.setStatus(error.message, true); return; }
        for (const block of this.state.blocks) this.updateChips(block);
        this.renderLibrary(); this.refreshCardCategories(); this.commit(`category-color:${name}`);
    }

    invalidateRestore() {
        this.libraryActions?.close(false);
        this.restoreRevision = (this.restoreRevision ?? 0) + 1;
        this.documentStorage?.dispose();
        this.documentStorage = null;
        this.restoring = true;
        this.container.inert = true;
    }

    async loadFromNode(initial = false) {
        this.libraryActions?.close(false);
        const hidden = this.node.properties?.promptDesignerHiddenBlocks;
        this.deletedLibraryKeys = new Set(Array.isArray(hidden) ? hidden.filter(key => typeof key === "string") : []);
        this.revision++;
        this.copy.disabled = true;
        const raw = this.dataWidget()?.value || "{}";
        if (initial) {
            try { this.state = normalizeState(JSON.parse(raw)); }
            catch { this.state = defaultState(); }
            this.container.inert = true;
            this.render();
            return;
        }
        this.invalidateRestore();
        const restoreRevision = this.restoreRevision;
        this.setStatus("Restoring saved prompt…");
        const storage = new DocumentStorage(this.node, this.api, (message, error) => {
            if (!this.disposed && this.documentStorage === storage) { this.storageStatus = { message, error }; this.setStatus(message, error); }
        });
        this.documentStorage = storage;
        this.persisted = null;
        try { this.state = normalizeState(JSON.parse(raw)); }
        catch (error) {
            this.restoreError = error;
        }
        let restored;
        try { restored = await storage.restore(raw); }
        catch (error) {
            if (this.disposed || restoreRevision !== this.restoreRevision || this.documentStorage !== storage) return;
            this.restoreError = error;
            this.restoring = false;
            this.setStatus(`Could not restore state: ${error.message}. Existing data was retained.`, true);
            return;
        }
        if (this.disposed || restoreRevision !== this.restoreRevision || this.documentStorage !== storage) return;
        this.state = restored;
        this.promptBaselines = new Map();
        this.promptHistories = new Map();
        this.hideInspector();
        this.restoreError = null;
        this.restoring = false;
        this.container.inert = false;
        this.inspectorScroll = new Map();
        this.history = new EditHistory();
        this.libraryView = this.node.properties?.promptDesignerLibraryTab === "prompts" ? "prompts" : "blocks";
        this.editingSavedPrompt = this.node.properties?.promptDesignerPromptDetails?.id ? { ...this.node.properties.promptDesignerPromptDetails } : null;
        this.ensurePromptTabs(); this.restorePromptDetails();
        this.render();
        this.commit(null, false);
        this.loadLibraryCards();
        this.loadLibraryCards(true);
        if (this.libraryView === "prompts") this.loadSavedPrompts();
    }

    async loadLibraryCards(bundled = false) {
        const loadingKey = bundled ? "bundledLibraryLoading" : "diskLibraryLoading";
        this[loadingKey] = true;
        const revisionKey = bundled ? "bundledLibraryRevision" : "diskLibraryRevision";
        const revision = this[revisionKey] = (this[revisionKey] || 0) + 1;
        const cardsKey = bundled ? "defaultCards" : "savedCards";
        const query = encodeURIComponent(this.search.value);
        const cards = [];
        let categories = [];
        try {
            let offset = 0;
            while (true) {
                const response = await this.api.fetchApi(`/vnccs/prompt_designer/${bundled ? "defaults" : "library"}?q=${query}&offset=${offset}`);
                const result = await readPromptResponse(response);
                if (this.disposed || revision !== this[revisionKey]) return;
                if (!response.ok) throw new Error(result.error || "Library could not be read.");
                cards.push(...result.cards.map(block => ({ ...block, id: promptId() })));
                categories = result.categories ?? categories;
                offset += result.cards.length;
                if (!result.cards.length || offset >= result.total) break;
            }
            this[cardsKey] = cards;
            if (!bundled) this.savedCategories = categories;
            this[loadingKey] = false;
            for (const block of this.state.blocks) this.updateChips(block);
            this.renderLibrary();
            this.refreshCardCategories();
            this.refreshPromptCategories();
        } catch (error) { if (!this.disposed && revision === this[revisionKey]) this.setStatus(error.message, true); }
        finally { if (revision === this[revisionKey]) this[loadingKey] = false; }
    }

    useLibraryBlock(block) {
        const current = this.state.blocks.find(item => item.id === block.id);
        if (current) return current;
        const key = libraryCardKey(block);
        const existing = this.state.blocks.find(item => libraryCardKey(item) === key);
        if (existing) return existing;
        const category = this.categoryDefinitions().find(item => item.name.toLowerCase() === block.category?.toLowerCase());
        const copy = { ...block, id: promptId(), ...(category ? { category: category.name } : {}) };
        const categories = mergeCategories(this.state.categories, category ? [category] : []);
        this.state = normalizeState({ ...this.state, categories, blocks: [...this.state.blocks, copy] });
        this.commit();
        return this.state.blocks.find(item => item.id === copy.id);
    }

    render() {
        this.ensurePromptTabs();
        this.rendering = true;
        const width = this.node.properties?.promptDesignerLibraryWidth;
        this.container.style.setProperty("--pd-library-width", `${Number.isFinite(width) ? Math.max(240, Math.min(4096, width)) : 460}px`);
        const inspectorWidth = this.node.properties?.promptDesignerInspectorWidth;
        this.container.style.setProperty("--pd-inspector-width", `${Number.isFinite(inspectorWidth) ? Math.max(240, Math.min(4096, inspectorWidth)) : 310}px`);
        this.libraryResize.setAttribute("aria-valuenow", String(Number.isFinite(width) ? width : 460));
        this.inspectorResize.setAttribute("aria-valuenow", String(Number.isFinite(inspectorWidth) ? inspectorWidth : 310));
        this.clearCardSelection();
        this.closeCondition(false);
        this.closeMultiPrompt(false);
        this.conditionSuggestion.hidden = true;
        const scrollTop = this.editor.scrollTop;
        this.editor.replaceChildren(...this.state.parts.map(part => "text" in part
            ? document.createTextNode(part.text) : part.condition ? this.conditionChip(part.condition)
                : part.multiPrompt ? this.multiPromptChip(part.multiPrompt) : this.chip(part.blockId)));
        this.syncEditorLineEnd(this.editor);
        this.editor.scrollTop = scrollTop;
        this.caret = null;
        this.seed.value = this.state.seed;
        this.after.value = this.state.afterGenerate;
        this.renderLibrary();
        this.showTab();
        this.rendering = false;
    }

    chip(id) {
        const block = this.state.blocks.find(item => item.id === id);
        const chip = element("span", "vnccs-pd-chip", block.name || "Untitled block");
        chip.contentEditable = "false";
        chip.draggable = true;
        chip.dataset.blockId = id;
        chip.tabIndex = 0;
        chip.setAttribute("role", "button");
        chip.setAttribute("aria-label", `Edit block: ${block.name}`);
        chip.title = `Click to select. Double-click or press Enter to edit ${block.name}. Drag to move.`;
        chip.style.setProperty("--pd-chip-color", this.cardColor(block));
        return chip;
    }

    showInspector(panel, key, title) {
        if (!this.inspector) return;
        const scrollKey = typeof key === "string" ? `card:${key}` : panel === this.conditionPanel
            ? `condition:${[...this.editor.querySelectorAll("[data-condition]")].indexOf(key)}`
            : `multi:${[...this.editor.querySelectorAll("[data-multi-prompt]")].indexOf(key)}`;
        const changed = this.inspectorKey !== key || this.inspectorPanel !== panel;
        if (changed) {
            this.hideInspector();
            this.inspectorKey = key;
            this.inspectorPanel = panel;
        }
        this.inspectorScrollKey = scrollKey;
        for (const item of [this.cardPanel, this.conditionPanel, this.multiPanel, this.promptPanel]) item.hidden = item !== panel;
        this.inspectorTitle.textContent = title;
        this.inspector.hidden = false;
        this.workspace.classList.add("has-inspector");
        if (changed) {
            const saved = this.inspectorScroll?.get(key) ?? this.node.properties?.promptDesignerPanelScroll?.inspector?.[scrollKey];
            panel.scrollTop = saved?.top ?? 0;
            panel.scrollLeft = saved?.left ?? 0;
        }
    }

    hideInspector() {
        if (!this.inspector) return;
        if (this.inspectorPanel) {
            this.savePanelScroll(this.inspectorPanel, this.inspectorScrollKey);
            this.inspectorScroll ??= new Map();
            this.inspectorScroll.set(this.inspectorKey, { top: this.inspectorPanel.scrollTop, left: this.inspectorPanel.scrollLeft });
            this.inspectorPanel.hidden = true;
        }
        this.inspectorPanel = null;
        this.inspectorKey = null;
        this.inspector.hidden = true;
        this.workspace.classList.remove("has-inspector");
    }

    closeInspector() {
        this.closeCondition(false);
        this.closeMultiPrompt(false);
        this.hideInspector();
        (this.activeBlock() ? this.blockView.value === "text" ? this.blockRaw : this.variants.querySelector(".vnccs-pd-variant-text") : this.editor)?.focus({ preventScroll: true });
    }

    setBlockPreference(key, value) {
        const block = this.activeBlock();
        if (!block) return;
        try {
            this.state = normalizeState({ ...this.state, blocks: this.state.blocks.map(item => item === block
                ? { ...item, [key]: value, ...(key === "mode" ? { text: blockSourceMode(item.text, value) } : {}) } : item) });
        } catch (error) { this.setStatus(error.message, true); return; }
        this.updateChips(this.activeBlock());
        this.updateLibraryBlock(this.activeBlock());
        if (key === "category") { this.renderLibrary(); this.refreshCardCategories(); }
        if (key === "color") this.blockColor.value = this.cardColor(this.activeBlock());
        this.commit(`${key}:${block.id}`);
        if (key === "mode") this.scheduleBlockPreview();
    }

    saveBlockSource(text, render = false) {
        const block = this.activeBlock();
        if (!block) return;
        try {
            const mode = /^\s*\{\s*@/.test(text) ? "cycle" : /^\s*\{\s*[~!]/.test(text) ? "random" : block.mode;
            this.state = normalizeState({ ...this.state, blocks: this.state.blocks.map(item => item === block ? { ...item, text, ...(mode ? { mode } : {}) } : item) });
            this.blockMode.value = mode ?? "random";
            this.updateChips(this.activeBlock());
            this.updateLibraryBlock(this.activeBlock());
            this.commit(`block:${block.id}`);
            this.scheduleBlockPreview(render);
            return true;
        } catch (error) { this.setStatus(error.message, true); }
    }

    insertVariantText(content, text) {
        const selection = window.getSelection();
        const range = selection?.rangeCount && content.contains(selection.anchorNode) && content.contains(selection.focusNode)
            ? selection.getRangeAt(0) : document.createRange();
        if (!content.contains(range.startContainer)) { range.selectNodeContents(content); range.collapse(false); }
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node); range.setStartAfter(node); range.collapse(true);
        this.selectRange(range);
        content.dispatchEvent(new Event("input", { bubbles: true }));
    }

    updateChips(block) {
        for (const chip of [...this.editor.querySelectorAll("[data-block-id]"), ...(this.multiRows?.querySelectorAll("[data-block-id]") ?? []),
            ...this.conditionSource.querySelectorAll("[data-block-id]"), ...this.conditionOutput.querySelectorAll("[data-block-id]"),
            ...this.conditionElseOutput.querySelectorAll("[data-block-id]"), ...this.conditionExtraRows.querySelectorAll("[data-block-id]")]) {
            if (chip.dataset.blockId !== block.id) continue;
            chip.textContent = block.name || "Untitled block";
            chip.title = `Click to select. Double-click or press Enter to edit ${block.name}. Drag to move.`;
            chip.setAttribute("aria-label", `Edit block: ${block.name}`);
            chip.style.setProperty("--pd-chip-color", this.cardColor(block));
        }
        for (const chip of this.editor.querySelectorAll("[data-condition]")) this.labelCondition(chip, JSON.parse(chip.dataset.condition));
    }

    conditionChip(condition) {
        const chip = element("span", "vnccs-pd-chip vnccs-pd-condition");
        chip.contentEditable = "false";
        chip.draggable = false;
        chip.tabIndex = 0;
        chip.setAttribute("role", "group");
        chip.setAttribute("aria-label", "If condition");
        const handle = element("span", "vnccs-pd-condition-handle", "⠿");
        handle.draggable = true; handle.tabIndex = 0;
        handle.title = "Drag to move the condition";
        handle.setAttribute("role", "button"); handle.setAttribute("aria-label", "Move condition");
        const source = element("span", "vnccs-pd-condition-inline-field vnccs-pd-condition-drop");
        source.dataset.placeholder = "Drop block";
        source.setAttribute("aria-label", "Condition block: drag from the library");
        const operator = element("select", "vnccs-pd-condition-inline-field");
        operator.setAttribute("aria-label", "Condition operator");
        const empty = element("option", null, "Condition…"); empty.value = "";
        empty.disabled = true; empty.hidden = true; empty.selected = true;
        operator.append(empty, ...Object.entries(CONDITION_OPERATORS).map(([value, label]) => {
            const option = element("option", null, label); option.value = value; return option;
        }));
        const value = element("input", "vnccs-pd-condition-inline-field vnccs-pd-condition-value");
        value.placeholder = "Text"; value.maxLength = 64 * 1024;
        value.setAttribute("aria-label", "Condition comparison text");
        const output = element("div", "vnccs-pd-editor vnccs-pd-condition-inline-field vnccs-pd-condition-output");
        const elseOutput = element("div", "vnccs-pd-editor vnccs-pd-condition-inline-field vnccs-pd-condition-output");
        for (const [editor, label] of [[output, "Then output"], [elseOutput, "Else output (optional)"]]) {
            editor.contentEditable = "true"; editor.spellcheck = false;
            editor.dataset.inlineConditionOutput = "true";
            editor.dataset.placeholder = editor === elseOutput ? "Optional" : "Text / block";
            editor.setAttribute("role", "textbox"); editor.setAttribute("aria-multiline", "true");
            editor.setAttribute("aria-label", `${label} text and blocks`);
            this.installPromptInteractions(editor);
            this.on(editor, "input", () => { this.clearCardSelection(); this.saveInlineCondition(chip); });
            this.on(editor, "paste", event => {
                event.preventDefault(); this.insertNode(document.createTextNode(event.clipboardData.getData("text/plain")), editor);
            });
            this.on(editor, "beforeinput", event => {
                if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
                    event.preventDefault(); this.insertNode(document.createTextNode("\n"), editor);
                } else if (["historyUndo", "historyRedo"].includes(event.inputType)) {
                    event.preventDefault(); this.moveHistory(event.inputType === "historyUndo" ? "undo" : "redo");
                }
            });
        }
        const clauses = element("span", "vnccs-pd-condition-clauses");
        chip.conditionControls = { source, operator, value, output, elseOutput, clauses };
        this.installConditionSourceInteractions(source, () => this.saveInlineCondition(chip));
        chip.append(handle, element("span", "vnccs-pd-condition-label", "If"), source, operator, value,
            clauses,
            element("span", "vnccs-pd-condition-label", "Then"), output,
            element("span", "vnccs-pd-condition-label", "Else"), elseOutput);
        for (const field of [source, operator, value, output, elseOutput, clauses]) {
            this.on(field, "focusin", () => {
                if (this.selectedCard === chip) this.clearCardSelection();
                this.conditionRange = null;
                this.conditionSuggestion.hidden = true;
            });
            for (const type of ["click", "dblclick", "focusin", "dragstart", "dragover", "drop", "dragend", "input", "beforeinput", "paste"]) {
                this.on(field, type, event => event.stopPropagation());
            }
        }
        this.on(source, "dragstart", event => {
            const id = source.querySelector("[data-block-id]")?.dataset.blockId;
            if (!id) { event.preventDefault(); return; }
            this.promptDrag = null;
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("application/x-vnccs-prompt-block", id);
        });
        this.on(source, "dragover", event => {
            if (!event.dataTransfer.types.includes("application/x-vnccs-prompt-block")) return;
            event.preventDefault(); event.dataTransfer.dropEffect = "copy";
        });
        this.on(source, "drop", event => {
            event.preventDefault();
            const id = event.dataTransfer.getData("application/x-vnccs-prompt-block");
            if (!this.state.blocks.some(block => block.id === id)) return;
            source.replaceChildren(this.chip(id));
            this.saveInlineCondition(chip);
        });
        this.on(operator, "change", () => this.saveInlineCondition(chip));
        this.on(value, "input", () => this.saveInlineCondition(chip));
        this.labelCondition(chip, condition);
        return chip;
    }

    labelCondition(chip, condition) {
        chip.dataset.condition = JSON.stringify(condition);
        const { source, operator, value, output, elseOutput, clauses } = chip.conditionControls;
        if ((source.querySelector("[data-block-id]")?.dataset.blockId ?? "") !== condition.blockId) {
            source.replaceChildren(...(condition.blockId ? [this.chip(condition.blockId)] : []));
        }
        if (operator.value !== condition.operator) operator.value = condition.operator;
        if (value.value !== condition.value) value.value = condition.value;
        clauses.hidden = !condition.clauses?.length;
        this.syncConditionClauses(clauses, condition.clauses ?? [], chip);
        for (const [editor, branch] of [[output, condition.then], [elseOutput, condition.else ?? { text: "" }]]) {
            const parts = mergeText(branch.parts ?? [branch]);
            if (JSON.stringify(readEditor(editor)) !== JSON.stringify(parts)) {
                editor.replaceChildren(...parts.map(part => "text" in part ? document.createTextNode(part.text) : this.chip(part.blockId)));
                this.syncEditorLineEnd(editor);
                editor.savedCaret = null;
            }
        }
        this.sizeInlineCondition(chip);
        chip.title = "Edit fields here or double-click the If label to open the inspector. Drag the handle to move the condition.";
    }

    sizeInlineCondition(chip) {
        const { source, operator, value, output, elseOutput, clauses } = chip.conditionControls;
        for (const controls of [{ source, operator, value }, ...[...clauses.children].map(row => row.conditionControls)]) {
            const label = CONDITION_OPERATORS[controls.operator.value] ?? "Condition…";
            controls.operator.style.width = `calc(${Math.min(16, label.length)}ch + 24px)`;
            controls.operator.title = label;
            controls.value.style.width = `calc(${Math.max(4, Math.min(12, controls.value.value.length))}ch + 12px)`;
            controls.value.title = controls.value.value;
        }
        for (const editor of [output, elseOutput]) editor.title = readEditor(editor).map(part => part.text
            ?? this.state.blocks.find(block => block.id === part.blockId)?.name ?? "").join("") || "Write text or drop blocks";
    }

    saveInlineCondition(chip) {
        if (!chip || !this.editor.contains(chip)) return;
        const { source, operator, value, output, elseOutput, clauses: clauseRows } = chip.conditionControls;
        const previous = chip.dataset.condition;
        const clauses = [...clauseRows.children].map(row => {
            const { source, operator, value } = row.conditionControls;
            return { join: row.dataset.join, blockId: source.value, operator: operator.value, value: value.value };
        });
        const condition = { blockId: source.querySelector("[data-block-id]")?.dataset.blockId ?? "",
            operator: operator.value, value: value.value, then: this.conditionOutputValue(output), else: this.conditionOutputValue(elseOutput),
            ...(clauses.length ? { clauses } : {}) };
        chip.dataset.condition = JSON.stringify(condition);
        try { this.state = normalizeState({ ...this.state, parts: readEditor(this.editor) }); }
        catch (error) { chip.dataset.condition = previous; this.setStatus(error.message, true); return; }
        this.sizeInlineCondition(chip);
        if (this.editingCondition === chip) {
            this.conditionSource.value = condition.blockId;
            this.conditionSource.replaceChildren(...(condition.blockId ? [this.chip(condition.blockId)] : []));
            this.conditionOperator.value = condition.operator; this.conditionValue.value = condition.value;
            this.syncConditionClauses(this.conditionExtraRows, clauses);
            for (const [editor, inlineEditor] of [[this.conditionOutput, output], [this.conditionElseOutput, elseOutput]]) {
                editor.replaceChildren(...readEditor(inlineEditor).map(part => "text" in part ? document.createTextNode(part.text) : this.chip(part.blockId)));
                this.syncEditorLineEnd(editor);
                editor.savedCaret = null;
            }
        }
        this.commit("condition");
    }

    conditionOutputValue(editor) {
        const parts = readEditor(editor);
        return parts.length === 1 ? parts[0] : parts.length ? { parts } : { text: "" };
    }

    syncConditionClauses(container, clauses, chip = null) {
        if (container.children.length !== clauses.length || clauses.some((clause, index) => container.children[index].dataset.join !== clause.join)) {
            container.replaceChildren(...clauses.map(clause => this.conditionClauseRow(clause, chip)));
            return;
        }
        clauses.forEach((clause, index) => {
            const { source, operator, value } = container.children[index].conditionControls;
            source.value = clause.blockId;
            if ((source.querySelector("[data-block-id]")?.dataset.blockId ?? "") !== clause.blockId) {
                source.replaceChildren(...(clause.blockId ? [this.chip(clause.blockId)] : []));
            }
            if (operator.value !== clause.operator) operator.value = clause.operator;
            if (value.value !== clause.value) value.value = clause.value;
        });
    }

    conditionClauseRow(clause, chip = null) {
        const wrapper = element(chip ? "span" : "div", chip ? "vnccs-pd-condition-inline-clause" : "vnccs-pd-condition-extra");
        wrapper.dataset.join = clause.join;
        const save = () => chip ? this.saveInlineCondition(chip) : this.applyCondition(false);
        const heading = element(chip ? "span" : "div", chip ? "vnccs-pd-condition-label" : "vnccs-pd-tools");
        heading.append(element("strong", null, clause.join.toUpperCase()));
        if (!chip) heading.append(this.button("Remove", () => { wrapper.remove(); save(); }));
        const row = element(chip ? "span" : "div", chip ? "vnccs-pd-condition-inline-check" : "vnccs-pd-condition-row");
        const source = element(chip ? "span" : "div", chip ? "vnccs-pd-condition-drop" : "vnccs-pd-editor vnccs-pd-condition-source");
        this.installConditionSourceInteractions(source, save);
        source.dataset.placeholder = "Drop block";
        source.value = clause.blockId;
        source.setAttribute("aria-label", `${clause.join.toUpperCase()} block: drag from the library`);
        if (clause.blockId) source.append(this.chip(clause.blockId));
        this.on(source, "dragover", event => {
            if (!event.dataTransfer.types.includes("application/x-vnccs-prompt-block")) return;
            event.preventDefault(); event.dataTransfer.dropEffect = "copy";
        });
        this.on(source, "drop", event => {
            event.preventDefault();
            const id = event.dataTransfer.getData("application/x-vnccs-prompt-block");
            if (!this.state.blocks.some(block => block.id === id)) return;
            source.value = id; source.replaceChildren(this.chip(id)); save();
        });
        if (chip) this.on(source, "dragstart", event => {
            if (!source.value) { event.preventDefault(); return; }
            this.promptDrag = null; event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("application/x-vnccs-prompt-block", source.value);
        });
        const operator = element("select");
        const empty = element("option", null, chip ? "Condition…" : "Choose condition…"); empty.value = "";
        empty.disabled = true; empty.hidden = true; empty.selected = true;
        operator.append(empty, ...Object.entries(CONDITION_OPERATORS).map(([value, label]) => {
            const option = element("option", null, label); option.value = value; return option;
        }));
        operator.value = clause.operator; operator.setAttribute("aria-label", "Additional condition operator");
        const value = element("input");
        if (chip) value.classList.add("vnccs-pd-condition-value");
        value.value = clause.value; value.maxLength = 64 * 1024; value.placeholder = chip ? "Text" : "Comparison text";
        value.setAttribute("aria-label", "Additional condition comparison text");
        this.on(operator, "change", save);
        this.on(value, "input", save);
        wrapper.conditionControls = { source, operator, value };
        row.append(source, operator, value); wrapper.append(heading, row);
        return wrapper;
    }

    addConditionClause(join) {
        if (!this.editingCondition) return;
        if (this.conditionExtraRows.children.length >= 64) { this.setStatus("A condition supports up to 64 additional checks.", true); return; }
        this.conditionExtraRows.append(this.conditionClauseRow({ join, blockId: "", operator: "", value: "" }));
        this.applyCondition(false);
    }

    updateConditionSuggestion() {
        const selection = window.getSelection();
        this.conditionRange = null;
        if (selection?.rangeCount && selection.isCollapsed && this.editor.contains(selection.anchorNode)) {
            const range = selection.getRangeAt(0);
            if (range.startContainer.nodeType === 3 && !range.startContainer.parentElement.closest("[data-block-id], [data-condition]")
                && /(?:^|[\s,(])if$/i.test(range.startContainer.textContent.slice(0, range.startOffset))) {
                this.conditionRange = range.cloneRange();
                this.conditionRange.setStart(range.startContainer, range.startOffset - 2);
            }
        }
        this.conditionSuggestion.hidden = !this.conditionRange;
    }

    insertCondition(useSuggestion = true) {
        if (useSuggestion && !this.conditionRange) return;
        const chip = this.conditionChip({ blockId: "", operator: "", value: "", then: { text: "" }, else: { text: "" } });
        if (useSuggestion) this.selectRange(this.conditionRange);
        this.insertNode(chip);
        this.conditionRange = null;
        this.conditionSuggestion.hidden = true;
        this.editCondition(chip);
    }

    editCondition(chip) {
        this.closeMultiPrompt(false);
        this.editingCondition = chip;
        const condition = JSON.parse(chip.dataset.condition);
        this.conditionSource.value = condition.blockId;
        this.conditionSource.replaceChildren(...(condition.blockId ? [this.chip(condition.blockId)] : []));
        this.conditionOperator.value = condition.operator;
        this.conditionValue.value = condition.value;
        this.conditionExtraRows.replaceChildren(...(condition.clauses ?? []).map(clause => this.conditionClauseRow(clause)));
        for (const [editor, branch] of [[this.conditionOutput, condition.then], [this.conditionElseOutput, condition.else ?? { text: "" }]]) {
            editor.replaceChildren(...(branch.parts ?? [branch]).map(part => "text" in part
                ? document.createTextNode(part.text) : this.chip(part.blockId)));
            this.syncEditorLineEnd(editor);
            editor.savedCaret = null;
        }
        this.conditionPanel.hidden = false;
        this.showInspector(this.conditionPanel, chip, "Inspector · If");
        this.conditionSuggestion.hidden = true;
        this.conditionValue.focus({ preventScroll: true });
    }

    applyCondition(close = true) {
        const chip = this.editingCondition;
        if (!chip || !this.editor.contains(chip)) return;
        const clauses = [...this.conditionExtraRows.children].map(row => {
            const { source, operator, value } = row.conditionControls;
            return { join: row.dataset.join, blockId: source.value, operator: operator.value, value: value.value };
        });
        if (close && (!this.conditionSource.value || !this.conditionOperator.value || !this.conditionValue.value.trim()
            || clauses.some(clause => !clause.blockId || !clause.operator || !clause.value.trim()))) {
            this.setStatus("Choose a block, a condition and comparison text.", true); return;
        }
        const condition = { blockId: this.conditionSource.value, operator: this.conditionOperator.value, value: this.conditionValue.value,
            then: this.conditionOutputValue(this.conditionOutput), else: this.conditionOutputValue(this.conditionElseOutput),
            ...(clauses.length ? { clauses } : {}) };
        const previous = JSON.parse(chip.dataset.condition);
        chip.dataset.condition = JSON.stringify(condition);
        try { this.state = normalizeState({ ...this.state, parts: readEditor(this.editor) }); }
        catch (error) { chip.dataset.condition = JSON.stringify(previous); this.setStatus(error.message, true); return; }
        this.labelCondition(chip, condition);
        if (close) this.closeCondition();
        this.commit(close ? null : "condition");
    }

    closeCondition(focus = true) {
        if (this.inspectorPanel === this.conditionPanel) this.hideInspector();
        this.conditionPanel.hidden = true;
        this.editingCondition = null;
        if (focus) this.editor.focus({ preventScroll: true });
    }

    multiPromptChip(multi) {
        const chip = element("span", "vnccs-pd-chip vnccs-pd-multi");
        chip.contentEditable = "false"; chip.tabIndex = 0; chip.draggable = true;
        chip.setAttribute("role", "button"); chip.setAttribute("aria-label", "Edit multi-prompt");
        this.labelMultiPrompt(chip, multi);
        return chip;
    }

    labelMultiPrompt(chip, multi) {
        chip.dataset.multiPrompt = JSON.stringify(multi);
        chip.textContent = `Multi-prompt · ${multi.variants.length} outputs`;
        chip.title = "Click to select. Double-click or press Enter to edit output variants. Drag to move.";
    }

    insertMultiPrompt() {
        const chip = this.multiPromptChip({ variants: [[{ text: "" }], [{ text: "" }]] });
        this.insertNode(chip);
        this.editMultiPrompt(chip);
    }

    editMultiPrompt(chip) {
        this.closeCondition(false);
        this.editingMultiPrompt = chip;
        this.multiPanel.hidden = false;
        this.renderMultiRows();
        this.showInspector(this.multiPanel, chip, "Inspector · Multi-prompt");
    }

    renderMultiRows() {
        const top = this.multiPanel.scrollTop, left = this.multiPanel.scrollLeft;
        const multi = JSON.parse(this.editingMultiPrompt.dataset.multiPrompt);
        multi.variants.forEach((variant, index) => {
            const existing = this.multiRows.children[index];
            const previousEditor = existing?.querySelector(".vnccs-pd-variant-editor");
            if (previousEditor && JSON.stringify(readEditor(previousEditor)) === JSON.stringify(variant)) {
                for (const block of this.state.blocks) this.updateChips(block);
                existing.querySelector(".vnccs-pd-multi-remove").disabled = multi.variants.length <= 2;
                return;
            }
            const row = element("div", "vnccs-pd-multi-row");
            const header = element("div", "vnccs-pd-multi-head");
            const editor = element("div", "vnccs-pd-editor vnccs-pd-variant-editor");
            editor.contentEditable = "true"; editor.spellcheck = false;
            editor.setAttribute("role", "textbox"); editor.setAttribute("aria-multiline", "true");
            editor.setAttribute("aria-label", `Text and blocks for prompt${index + 1}`);
            editor.append(...variant.map(part => "text" in part ? document.createTextNode(part.text) : this.chip(part.blockId)));
            const remove = this.button("Remove variant", () => this.removeMultiVariant(index));
            remove.className = "vnccs-pd-multi-remove";
            remove.disabled = multi.variants.length <= 2;
            header.append(element("span", null, `prompt${index + 1}`), remove);
            row.append(header, editor);
            if (existing) this.multiRows.replaceChild(row, existing); else this.multiRows.append(row);
            this.on(editor, "input", () => { this.clearCardSelection(); this.saveMultiPrompt("multi"); });
            const remember = () => {
                const selection = window.getSelection();
                if (selection?.rangeCount && editor.contains(selection.anchorNode)) editor.savedCaret = selection.getRangeAt(0).cloneRange();
            };
            this.on(editor, "keyup", remember); this.on(editor, "pointerup", remember);
            this.on(editor, "paste", event => {
                event.preventDefault(); this.insertNode(document.createTextNode(event.clipboardData.getData("text/plain")), editor);
            });
            this.on(editor, "beforeinput", event => {
                if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
                    event.preventDefault(); this.insertNode(document.createTextNode("\n"), editor);
                } else if (["historyUndo", "historyRedo"].includes(event.inputType)) {
                    event.preventDefault(); this.moveHistory(event.inputType === "historyUndo" ? "undo" : "redo");
                }
            });
            this.installPromptInteractions(editor);
        });
        while (this.multiRows.children.length > multi.variants.length) this.multiRows.lastElementChild.remove();
        this.multiPanel.scrollTop = top;
        this.multiPanel.scrollLeft = left;
    }

    saveMultiPrompt(group = null) {
        const chip = this.editingMultiPrompt;
        if (!chip || !this.editor.contains(chip)) return;
        const previous = JSON.parse(chip.dataset.multiPrompt);
        const variants = [...this.multiRows.querySelectorAll(".vnccs-pd-variant-editor")].map(readEditor);
        this.labelMultiPrompt(chip, { variants });
        try { this.state = normalizeState({ ...this.state, parts: readEditor(this.editor) }); }
        catch (error) { this.labelMultiPrompt(chip, previous); this.setStatus(error.message, true); return; }
        this.commit(group);
    }

    addMultiVariant() {
        if (!this.editingMultiPrompt) return;
        const multi = JSON.parse(this.editingMultiPrompt.dataset.multiPrompt);
        if (multi.variants.length === MAX_PROMPT_OUTPUTS) { this.setStatus(`Up to ${MAX_PROMPT_OUTPUTS} outputs are supported.`, true); return; }
        multi.variants.push([]);
        this.changeMultiVariants(multi);
    }

    removeMultiVariant(index) {
        const multi = JSON.parse(this.editingMultiPrompt.dataset.multiPrompt);
        if (multi.variants.length <= 2) return;
        if (this.node.outputs?.slice(index).some(output => output.links?.length)) {
            this.setStatus("Disconnect affected output links before removing or renumbering variants.", true); return;
        }
        multi.variants.splice(index, 1);
        this.changeMultiVariants(multi);
    }

    changeMultiVariants(multi) {
        const chip = this.editingMultiPrompt, previous = JSON.parse(chip.dataset.multiPrompt);
        this.labelMultiPrompt(chip, multi);
        try { this.state = normalizeState({ ...this.state, parts: readEditor(this.editor) }); }
        catch (error) { this.labelMultiPrompt(chip, previous); this.setStatus(error.message, true); return; }
        this.renderMultiRows(); this.commit();
    }

    closeMultiPrompt(focus = true) {
        if (this.inspectorPanel === this.multiPanel) this.hideInspector();
        if (this.multiPanel) this.multiPanel.hidden = true;
        this.editingMultiPrompt = null;
        if (focus) this.editor.focus({ preventScroll: true });
    }

    showResolvedPrompts(prompts, index = this.previewIndex ?? 0) {
        this.resolvedPrompts = prompts;
        this.outputScroll ??= new Map();
        this.outputScroll.set(this.previewIndex ?? 0, this.output.scrollTop);
        index = Math.min(index, prompts.length - 1);
        this.previewIndex = index;
        this.output.textContent = prompts[index] ?? "";
        this.output.scrollTop = this.outputScroll.get(index) ?? 0;
        this.outputSelect.replaceChildren(...prompts.map((_, output) => {
            const option = element("option", null, `prompt${output + 1}`); option.value = String(output); return option;
        }));
        this.outputSelect.value = String(index); this.outputSelect.hidden = prompts.length < 2;
    }

    updateLibraryBlock(block) {
        const row = [...this.list.children].find(item => item.dataset.blockId === block.id);
        if (!row) return;
        const order = this.libraryOrder?.get(row.dataset.libraryKey);
        const key = libraryCardKey(block);
        if (order !== undefined) this.libraryOrder.set(key, order);
        row.dataset.libraryKey = key;
        row.querySelector(".vnccs-pd-block-name").textContent = block.name || "Untitled block";
        row.querySelector(".vnccs-pd-excerpt").textContent = block.text || "Empty block";
        row.style.setProperty("--pd-chip-color", this.cardColor(block));
        row.hidden = !block.name.toLowerCase().includes(this.search.value.toLowerCase())
            || (!!this.libraryCategory && block.category?.toLowerCase() !== this.libraryCategory.toLowerCase());
    }

    renderLibrary() {
        if (this.ifTool) this.ifTool.disabled = false;
        for (const button of this.libraryTabs.children) {
            const active = button.dataset.view === this.libraryView;
            button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active));
            button.tabIndex = active ? 0 : -1;
            if (active) this.list.setAttribute("aria-labelledby", button.id);
        }
        this.search.placeholder = this.libraryView === "prompts" ? "Search prompts…" : "Search blocks…";
        this.search.setAttribute("aria-label", this.libraryView === "prompts" ? "Search saved prompts" : "Search saved blocks");
        this.libraryAction.textContent = this.libraryView === "prompts" ? "+ Save Prompt Template" : "+ New block";
        this.libraryHint.textContent = this.libraryView === "prompts" ? "Click a saved prompt to open it." : "Drag into the prompt. Click to edit.";
        const definitions = this.categoryDefinitions();
        if (this.libraryCategory) this.libraryCategory = definitions.find(category => category.name.toLowerCase() === this.libraryCategory.toLowerCase())?.name ?? "";
        this.categories.replaceChildren(...[{ name: "All", value: "" }, ...definitions.map(category => ({ ...category, value: category.name }))].map(category => {
            const button = this.button(category.name, () => { this.libraryCategory = category.value; this.renderLibrary(); });
            button.classList.toggle("active", this.libraryCategory === category.value);
            button.setAttribute("aria-pressed", String(this.libraryCategory === category.value));
            if (category.color) button.style.setProperty("--pd-category-color", category.color);
            return button;
        }), this.button("+ Category", () => { this.categoryForm.hidden = false; this.categoryName.focus(); }));
        const scroll = this.node.properties?.promptDesignerPanelScroll;
        const savedScroll = scroll?.libraryViews?.[this.libraryView] ?? (this.libraryView === "blocks" ? scroll?.library : { top: 0, left: 0 });
        const top = savedScroll?.top ?? this.list.scrollTop;
        this.list.replaceChildren();
        if (this.libraryView === "prompts") {
            for (const prompt of this.savedPrompts ?? []) {
                const row = this.button("", () => this.openSavedPrompt(prompt)); row.className = "vnccs-pd-block";
                row.dataset.promptId = prompt.id;
                this.installLibraryMenu(row, "prompt", prompt);
                const category = definitions.find(item => item.name.toLowerCase() === prompt.category?.toLowerCase());
                row.style.setProperty("--pd-chip-color", prompt.color ?? category?.color ?? "#b8a9e8");
                row.classList.toggle("active", this.activePrompt()?.templateId === prompt.id);
                const copy = element("div", "vnccs-pd-block-copy");
                copy.append(element("div", "vnccs-pd-block-name", prompt.name), element("span", "vnccs-pd-excerpt", prompt.text));
                row.append(copy);
                row.hidden = !prompt.name.toLowerCase().includes(this.search.value.toLowerCase())
                    || (!!this.libraryCategory && prompt.category?.toLowerCase() !== this.libraryCategory.toLowerCase());
                this.list.append(row);
            }
            if (!this.savedPrompts?.length) this.list.append(element("div", "vnccs-pd-hint", "No saved prompts yet."));
            this.list.scrollTop = top;
            this.list.scrollLeft = savedScroll?.left ?? 0;
            return;
        }
        const seen = new Set();
        const localCards = new Map();
        for (const block of this.state.blocks) {
            const key = libraryCardKey(block);
            if (!localCards.has(key) || block.id === this.state.activeTab) localCards.set(key, block);
        }
        const catalogCards = [...(this.savedCards ?? []), ...(this.defaultCards ?? [])]
            // Preserve hidden cards recorded by workflows using the old three-field key.
            .filter(block => !this.deletedLibraryKeys?.has(libraryCardKey(block)) && !this.deletedLibraryKeys?.has(libraryCardKey(block, true)));
        const cards = [...localCards.values(), ...catalogCards];
        this.libraryOrder ??= new Map();
        for (const block of cards) {
            const key = libraryCardKey(block);
            if (!this.libraryOrder.has(key)) this.libraryOrder.set(key, this.libraryOrder.size);
        }
        cards.sort((left, right) => this.libraryOrder.get(libraryCardKey(left)) - this.libraryOrder.get(libraryCardKey(right)));
        for (const block of cards) {
            const key = libraryCardKey(block);
            if (seen.has(key)) continue;
            seen.add(key);
            const row = this.button("", () => {
                try {
                    const selected = this.useLibraryBlock(block);
                    if (selected !== block) this.renderLibrary();
                    this.openBlock(selected.id);
                } catch (error) { this.setStatus(error.message, true); }
            });
            row.className = "vnccs-pd-block";
            row.dataset.blockId = block.id;
            row.dataset.libraryKey = key;
            this.installLibraryMenu(row, "block", block);
            row.style.setProperty("--pd-chip-color", this.cardColor(block));
            row.draggable = true;
            row.title = "Click to edit. Drag into the main prompt. Use Insert into prompt for keyboard insertion.";
            const copy = element("div", "vnccs-pd-block-copy");
            copy.append(element("div", "vnccs-pd-block-name", block.name || "Untitled block"),
                element("span", "vnccs-pd-excerpt", block.text || "Empty block"));
            row.append(element("span", "handle", "⠿"), copy);
            row.hidden = !block.name.toLowerCase().includes(this.search.value.toLowerCase())
                || (!!this.libraryCategory && block.category?.toLowerCase() !== this.libraryCategory.toLowerCase());
            this.on(row, "dragstart", event => {
                event.stopPropagation();
                try {
                    const selected = this.useLibraryBlock(block);
                    row.dataset.blockId = selected.id;
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("application/x-vnccs-prompt-block", selected.id);
                    event.dataTransfer.setData("text/plain", selected.text);
                } catch (error) { event.preventDefault(); this.setStatus(error.message, true); }
            });
            this.list.append(row);
        }
        if (!seen.size) this.list.append(element("div", "vnccs-pd-hint", "No saved blocks. Create your first block below."));
        this.list.scrollTop = top;
        this.list.scrollLeft = savedScroll?.left ?? this.list.scrollLeft;
        this.markLibrarySelection();
    }

    markLibrarySelection() {
        for (const row of this.list.querySelectorAll("[data-block-id]")) {
            row.classList.toggle("active", row.dataset.blockId === this.state.activeTab);
        }
    }

    renderTabs() {
        this.ensurePromptTabs();
        const left = this.tabs.scrollLeft;
        const ids = [...this.state.promptTabs.map(tab => `prompt:${tab.id}`), ...this.state.openTabs];
        for (const tab of [...this.tabs.children]) {
            if (!ids.includes(tab.dataset.tabId) && tab !== this.newPromptButton) tab.remove();
        }
        for (const id of ids) {
            const prompt = this.state.promptTabs.find(tab => `prompt:${tab.id}` === id);
            const block = this.state.blocks.find(item => item.id === id);
            const label = prompt ? prompt.details.name || "Prompt" : block?.name || "Untitled block";
            let tab = [...this.tabs.children].find(item => item.dataset.tabId === id);
            if (!tab) {
                tab = element("div", "vnccs-pd-tab");
                tab.dataset.tabId = id;
                const button = this.button(label, () => prompt ? this.switchPrompt(prompt.id) : this.switchTab(id));
                button.setAttribute("role", "tab");
                button.setAttribute("aria-controls", prompt ? this.main.id : this.blockDoc.id);
                tab.append(button);
                {
                    const close = this.button("×", () => {
                        if (prompt) { this.closePrompt(prompt.id); return; }
                        this.state.openTabs = this.state.openTabs.filter(item => item !== id);
                        if (this.state.activeTab === id) this.switchTab("prompt");
                        else { this.renderTabs(); this.persist(); }
                    });
                    close.className = "close";
                    tab.append(close);
                }
                this.tabs.append(tab);
                if (this.newPromptButton) this.tabs.append(this.newPromptButton);
            }
            const active = prompt ? this.state.activeTab === "prompt" && prompt.id === this.state.activePrompt : id === this.state.activeTab;
            tab.classList.toggle("active", active);
            tab.firstChild.textContent = label;
            tab.firstChild.setAttribute("aria-selected", String(active));
            tab.firstChild.title = prompt?.dirty ? `${label} · Unsaved template changes` : label;
            tab.querySelector(".close")?.setAttribute("aria-label", `Close ${label} tab`);
        }
        if (!this.newPromptButton) {
            this.newPromptButton = this.button("+", () => this.newPrompt());
            this.newPromptButton.setAttribute("aria-label", "New prompt tab"); this.newPromptButton.title = "New prompt tab";
            this.tabs.append(this.newPromptButton);
        }
        this.tabs.scrollLeft = left;
    }

    switchTab(id) {
        if (this.state.activeTab !== "prompt") this.scroll.set(this.state.activeTab, {
            ...this.scroll.get(this.state.activeTab),
            top: this.blockRaw.scrollTop, left: this.blockRaw.scrollLeft,
            start: this.blockRaw.selectionStart, end: this.blockRaw.selectionEnd,
            previewTop: this.variants.childNodes.length ? this.variants.scrollTop : this.scroll.get(this.state.activeTab)?.previewTop ?? 0,
            previewLeft: this.variants.childNodes.length ? this.variants.scrollLeft : this.scroll.get(this.state.activeTab)?.previewLeft ?? 0,
            search: this.blockSearch.value,
        });
        else this.rememberCaret();
        this.state.activeTab = id;
        this.showTab();
        if (id !== "prompt") {
            (this.blockView.value === "text" ? this.blockRaw : this.variants.querySelector(".vnccs-pd-variant-text"))?.focus({ preventScroll: true });
        }
        this.persist();
        this.history.group = null;
    }

    showTab() {
        const block = this.activeBlock();
        this.main.hidden = !!block;
        this.blockDoc.hidden = !block;
        this.closeCondition(false); this.closeMultiPrompt(false);
        if (!block) this.hideInspector();
        if (block) this.conditionSuggestion.hidden = true;
        if (block) {
            this.blockName.value = block.name;
            this.blockMode.value = block.mode ?? (/^\s*\{\s*@/.test(block.text) ? "cycle" : "random");
            this.refreshCardCategories();
            this.showInspector(this.cardPanel, block.id, "Inspector · Card");
            const saved = this.scroll.get(block.id);
            this.blockView.value = saved?.view ?? "variants";
            if (this.blockSearch.dataset.tabId !== block.id) {
                this.blockSearch.value = saved?.search ?? "";
                this.blockSearch.dataset.tabId = block.id;
            }
        }
        this.renderTabs();
        this.markLibrarySelection();
        this.scheduleBlockPreview();
    }

    scheduleBlockPreview(render = true) {
        clearTimeout(this.blockTimer);
        this.blockRequest?.abort();
        this.blockRevision++;
        const block = this.activeBlock();
        if (!block || this.disposed) return;
        if (this.variants.dataset.blockId !== block.id) {
            this.variants.replaceChildren();
            this.variants.dataset.blockId = block.id;
            const saved = this.scroll.get(block.id);
            this.variants.scrollTop = saved?.previewTop ?? 0;
            this.variants.scrollLeft = saved?.previewLeft ?? 0;
        }
        if (render) this.renderBlockVariants();
        this.blockStatus.classList.remove("error");
        this.variants.setAttribute("aria-busy", "true");
        this.blockTimer = setTimeout(() => this.previewBlock(), 200);
    }

    renderBlockVariants() {
        const block = this.activeBlock();
        if (!block) return;
        const parsed = blockRows(block.text);
        this.blockEditRanges = parsed.rows;
        const result = { variants: block.text ? parsed.rows.map(row => row.text) : [] };
        this.blockVariants = result;
        const saved = this.scroll.get(this.state.activeTab) ?? {};
        const raw = this.blockView.value === "text";
        for (const button of this.blockView.children) {
            const selected = button.dataset.view === this.blockView.value;
            button.classList.toggle("active", selected);
            button.setAttribute("aria-pressed", String(selected));
        }
        this.blockRaw.hidden = !raw;
        this.variants.hidden = raw;
        this.variantsTitle.textContent = raw ? "Text" : "Variants";
        this.blockSearch.disabled = raw;
        if (raw) {
            const same = this.blockRaw.dataset.blockId === block.id;
            const start = same ? this.blockRaw.selectionStart : saved.start ?? 0;
            const end = same ? this.blockRaw.selectionEnd : saved.end ?? 0;
            const top = same ? this.blockRaw.scrollTop : saved.top ?? 0;
            const left = same ? this.blockRaw.scrollLeft : saved.left ?? 0;
            if (this.blockRaw.value !== block.text) this.blockRaw.value = block.text;
            this.blockRaw.dataset.blockId = block.id;
            this.blockRaw.setSelectionRange(start, end);
            this.blockRaw.scrollTop = top;
            this.blockRaw.scrollLeft = left;
            this.blockStatus.textContent = result.variants.length ? `${result.variants.length} variants` : "Empty block";
            return;
        }
        let top = this.variants.childNodes.length ? this.variants.scrollTop : saved.previewTop ?? 0;
        let left = this.variants.childNodes.length ? this.variants.scrollLeft : saved.previewLeft ?? 0;
        const query = this.blockSearch.value;
        const pattern = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu") : null;
        if (query && !saved.previewQuery) {
            saved.unfilteredTop = top;
            saved.unfilteredLeft = left;
        } else if (!query && saved.previewQuery) {
            top = saved.unfilteredTop ?? top;
            left = saved.unfilteredLeft ?? left;
        }
        saved.previewQuery = query;
        this.scroll.set(this.state.activeTab, saved);
        const createRow = (text, index, draft = false) => {
            const matches = pattern ? [...text.matchAll(pattern)] : [];
            if (pattern && !matches.length) return null;
            const row = element("li", "vnccs-pd-variant");
            const number = element("span", "vnccs-pd-variant-index", String(index + 1));
            number.setAttribute("aria-hidden", "true");
            const content = element("div", "vnccs-pd-variant-text");
            content.contentEditable = "true";
            content.spellcheck = false;
            content.setAttribute("role", "textbox");
            content.setAttribute("aria-label", `Variant ${index + 1}`);
            content.setAttribute("aria-multiline", "true");
            if (draft) content.dataset.placeholder = "Write a new variant…";
            if (!matches.length) content.textContent = text;
            else {
                let offset = 0;
                for (const match of matches) {
                    content.append(document.createTextNode(text.slice(offset, match.index)), element("mark", "vnccs-pd-match", match[0]));
                    offset = match.index + match[0].length;
                }
                content.append(document.createTextNode(text.slice(offset)));
            }
            this.syncEditorLineEnd(content);
            row.append(number, content);
            this.on(content, "input", event => {
                this.syncEditorLineEnd(content);
                const active = this.activeBlock();
                if (active?.id !== block.id || !this.variants.contains(row)) return;
                const value = readEditor(content).map(part => part.text ?? "").join("");
                if (draft) {
                    if (!value.trim()) return;
                    const current = blockRows(active.text);
                    let source, ranges;
                    if (current.wrapped) {
                        const end = active.text.lastIndexOf("}");
                        source = active.text.slice(0, end) + "|" + value + active.text.slice(end);
                        ranges = [...this.blockEditRanges, { start: end + 1, end: end + 1 + value.length, text: value }];
                    } else {
                        const prefix = active.mode === "cycle" ? "{@" : "{~";
                        source = prefix + (active.text ? active.text + "|" : "") + value + "}";
                        const start = prefix.length + (active.text ? active.text.length + 1 : 0);
                        ranges = [...(active.text ? [{ start: prefix.length, end: prefix.length + active.text.length, text: active.text }] : []),
                            { start, end: start + value.length, text: value }];
                    }
                    if (!this.saveBlockSource(source)) return;
                    draft = false; delete content.dataset.placeholder;
                    this.blockEditRanges = ranges;
                    this.blockVariants = { variants: ranges.map(item => item.text) };
                    this.blockStatus.textContent = `${ranges.length} variants`;
                    this.variants.append(createRow("", ranges.length, true));
                    return;
                }
                if (!value.trim() && !event.isComposing) {
                    const current = blockRows(active.text), removed = current.rows[index];
                    let source = "";
                    if (current.wrapped && current.rows.length > 1) {
                        const start = removed.choiceStart - (index > 0 ? 1 : 0);
                        const end = removed.choiceEnd + (index === 0 ? 1 : 0);
                        source = active.text.slice(0, start) + active.text.slice(end);
                    }
                    const position = [...this.variants.children].indexOf(row);
                    if (!this.saveBlockSource(source)) return;
                    this.renderBlockVariants();
                    const next = (this.variants.children[position] ?? this.variants.lastElementChild)?.querySelector(".vnccs-pd-variant-text");
                    if (next) {
                        next.focus({ preventScroll: true });
                        const caret = document.createRange(); caret.selectNodeContents(next); caret.collapse(true); this.selectRange(caret);
                    } else this.blockSearch.focus({ preventScroll: true });
                    return;
                }
                const range = this.blockEditRanges[index];
                const source = active.text.slice(0, range.start) + value + active.text.slice(range.end);
                const changed = blockRows(source).rows.length !== this.blockEditRanges.length;
                const delta = value.length - (range.end - range.start);
                if (this.saveBlockSource(source, changed) && !changed) {
                    this.blockEditRanges = this.blockEditRanges.map((item, position) => position > index
                        ? { ...item, start: item.start + delta, end: item.end + delta }
                        : position === index ? { ...item, end: item.end + delta, text: value } : item);
                    this.blockVariants = { variants: this.blockEditRanges.map(item => item.text) };
                }
            });
            this.on(content, "paste", event => {
                event.preventDefault();
                const value = event.clipboardData.getData("text/plain");
                if (blockRows(value).wrapped) this.saveBlockSource(value, true);
                else this.insertVariantText(content, value);
            });
            this.on(content, "beforeinput", event => {
                if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) {
                    event.preventDefault(); this.insertVariantText(content, "\n");
                }
            });
            this.on(content, "blur", () => { if (this.activeBlock()?.id === block.id && this.blockSearch.value) this.renderBlockVariants(); });
            return row;
        };
        const rows = (block.text || parsed.wrapped ? result.variants : []).map((text, index) => createRow(text, index)).filter(Boolean);
        this.variants.replaceChildren(...rows);
        if (!query) this.variants.append(createRow("", block.text || parsed.wrapped ? result.variants.length : 0, true));
        this.variants.scrollTop = top;
        this.variants.scrollLeft = left;
        this.blockStatus.textContent = query ? rows.length ? `${rows.length} of ${result.variants.length} variants match`
            : "No matches · Try another search or clear the field"
            : result.variants.length ? `${result.variants.length} variants` : "Empty block";
    }

    async previewBlock() {
        const block = this.activeBlock();
        if (!block || this.disposed) return;
        const revision = this.blockRevision;
        this.blockRequest = new AbortController();
        try {
            const response = await this.api.fetchApi(`/vnccs/prompt_designer/preview?block_id=${encodeURIComponent(block.id)}`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(this.state), signal: this.blockRequest.signal,
            });
            const result = await readPromptResponse(response);
            if (this.disposed || revision !== this.blockRevision) return;
            if (!response.ok) throw new Error(result.error || "Could not parse block variants.");
            this.blockStatus.classList.remove("error");
            if (!this.blockSearch.value) this.blockStatus.textContent = block.text ? `${blockRows(block.text).rows.length} variants` : "Empty block";
        } catch (error) {
            if (!this.disposed && revision === this.blockRevision && error.name !== "AbortError") {
                this.blockStatus.textContent = error.message;
                this.blockStatus.classList.add("error");
            }
        } finally {
            if (!this.disposed && revision === this.blockRevision) this.variants.setAttribute("aria-busy", "false");
        }
    }

    openBlock(id) {
        if (!this.state.blocks.some(block => block.id === id)) return;
        if (!this.state.openTabs.includes(id)) this.state.openTabs.push(id);
        if (this.state.activeTab !== id) this.switchTab(id);
        else this.renderTabs();
    }

    newBlock() {
        if (this.state.blocks.length >= 256) { this.setStatus("The block library supports up to 256 blocks.", true); return; }
        const id = promptId();
        this.state.blocks.push({ id, name: "New block", category: this.libraryCategory, text: "" });
        this.commit();
        this.renderLibrary();
        this.openBlock(id);
        this.blockName.focus();
        this.blockName.select();
    }

    hideLibraryBlock(key) {
        this.deletedLibraryKeys ??= new Set(); this.deletedLibraryKeys.add(key);
        this.node.properties ??= {};
        this.node.properties.promptDesignerHiddenBlocks = [...this.deletedLibraryKeys];
    }

    renameLibraryBlock(block, name) {
        const selected = this.useLibraryBlock(block), key = libraryCardKey(block);
        if ([...(this.savedCards ?? []), ...(this.defaultCards ?? [])].some(item => libraryCardKey(item) === key)) this.hideLibraryBlock(key);
        selected.name = name;
        if (this.state.activeTab === selected.id) this.blockName.value = name;
        this.updateChips(selected); this.updateLibraryBlock(selected); this.renderTabs(); this.commit(`name:${selected.id}`);
        return true;
    }

    installLibraryMenu(row, kind, item) {
        const open = event => this.libraryActions.menu(event, row, [
            ["Edit", () => {
                try {
                    if (kind === "prompt") this.openSavedPrompt(item);
                    else { const block = this.useLibraryBlock(item); this.renderLibrary(); this.openBlock(block.id); }
                } catch (error) { this.setStatus(error.message, true); }
            }],
            ["Rename", () => this.libraryActions.dialog({ title: kind === "prompt" ? "Rename prompt template" : "Rename block",
                message: `Choose a new name for “${item.name}”.`, value: item.name,
                action: async name => {
                    const changed = kind === "prompt" ? await this.changeLibraryPrompt(item, name) : this.renameLibraryBlock(item, name);
                    if (!changed) throw new Error(this.status.textContent || "The card could not be renamed.");
                    this.renderLibrary();
                } })],
            ["Delete", () => this.confirmLibraryDelete(kind, item)],
        ]);
        this.on(row, "contextmenu", open);
        this.on(row, "keydown", event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) open(event); });
    }

    confirmLibraryDelete(kind, item) {
        if (!item) return;
        this.libraryActions.dialog({ title: kind === "prompt" ? "Delete prompt template" : "Delete block",
            message: `Delete “${item.name}” from the library?`, action: async () => {
                const changed = kind === "prompt" ? await this.deleteLibraryPrompt(item) : this.deleteBlock(item);
                if (!changed) throw new Error(this.status.textContent || "The card could not be deleted.");
            } });
    }

    deleteBlock(block = this.activeBlock()) {
        if (!block) return false;
        const key = libraryCardKey(block);
        try {
            for (const item of this.state.blocks.filter(item => libraryCardKey(item) === key)) removeBlock(this.state, item.id);
        }
        catch (error) { this.setStatus(error.message, true); return false; }
        this.hideLibraryBlock(key);
        this.commit();
        this.render();
        return true;
    }

    rememberCaret() {
        const selection = window.getSelection();
        if (selection?.rangeCount && this.editor.contains(selection.anchorNode) && this.editor.contains(selection.focusNode)) {
            this.caret = selection.getRangeAt(0).cloneRange();
            const anchor = this.caret.startContainer;
            const chip = (anchor.nodeType === 1 ? anchor : anchor.parentElement)?.closest?.("[data-block-id], [data-condition], [data-multi-prompt]");
            if (chip && this.caret.collapsed) { this.caret.setStartAfter(chip); this.caret.collapse(true); }
        }
    }

    selectRange(range) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    }

    syncEditorLineEnd(editor) {
        for (const child of [...editor.children]) if (child.dataset.pdCaretEnd) child.remove();
        if (editor.classList.contains("vnccs-pd-condition-output")) return;
        // Trailing text newlines need a final BR to display the empty caret line.
        if (readEditor(editor).at(-1)?.text?.endsWith("\n")) {
            const end = element("br"); end.dataset.pdCaretEnd = "true";
            editor.append(end);
        }
    }

    rangeAt(x, y, editor = this.editor) {
        let range = document.caretRangeFromPoint?.(x, y);
        if (!range && document.caretPositionFromPoint) {
            const position = document.caretPositionFromPoint(x, y);
            if (position) { range = document.createRange(); range.setStart(position.offsetNode, position.offset); range.collapse(true); }
        }
        const hit = document.elementFromPoint?.(x, y);
        const anchor = range?.startContainer;
        let chip = hit?.closest?.(CARD_SELECTOR);
        if (!chip || !editor.contains(chip)) chip = (anchor?.nodeType === 1 ? anchor : anchor?.parentElement)?.closest?.(CARD_SELECTOR);
        if (chip && editor.contains(chip)) {
            // The enclosing If is atomic in the prompt, but not in its own output editor.
            for (let outer = chip.parentElement?.closest(CARD_SELECTOR); outer && editor.contains(outer); outer = chip.parentElement?.closest(CARD_SELECTOR)) chip = outer;
        } else {
            chip = null;
            const first = editor.firstChild;
            if (first?.matches?.(CARD_SELECTOR)) {
                const rect = first.getBoundingClientRect();
                if (x < rect.left && y >= rect.top && y <= rect.bottom) chip = first;
            }
        }
        if (chip) {
            range ??= document.createRange();
            const rect = chip.getBoundingClientRect();
            if (x < (rect.left + rect.right) / 2) range.setStartBefore(chip);
            else range.setStartAfter(chip);
            range.collapse(true);
        }
        return range && editor.contains(range.startContainer) ? range : null;
    }

    insertNode(node, editor = this.editor) {
        this.clearCardSelection();
        let range = editor === this.editor ? this.caret : editor.savedCaret;
        const selection = window.getSelection();
        if (selection?.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) range = selection.getRangeAt(0);
        if (!range || !editor.contains(range.startContainer)) {
            range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
        }
        range.deleteContents();
        range.insertNode(node);
        range.setStartAfter(node); range.collapse(true);
        if (editor === this.editor) this.caret = range.cloneRange(); else editor.savedCaret = range.cloneRange();
        editor.focus({ preventScroll: true });
        this.selectRange(range);
        this.savePromptEditor(editor);
    }

    insertBlock(id) {
        if (this.state.activeTab !== "prompt") this.switchTab("prompt");
        this.insertNode(this.chip(id));
    }

    persist() {
        if (this.restoreError || this.restoring || this.container?.inert) return;
        try { this.capturePromptTabs(); normalizeState(this.state); }
        catch (error) {
            if (this.saved) { this.state = normalizeState(JSON.parse(this.saved)); this.render(); }
            this.setStatus(`${error.message} Last valid edit was retained.`, true);
            return;
        }
        const value = JSON.stringify(this.state);
        const widget = this.dataWidget();
        if (widget) widget.value = value;
        const changed = value !== this.persisted;
        syncPromptOutputs(this.node, this.state);
        if (this.documentStorage && changed) this.documentStorage.write(value);
        this.persisted = value;
        this.saved = value;
        this.node.setDirtyCanvas?.(true, true);
        if (changed) this.node.graph?.change?.();
        return value;
    }

    commit(group = null, record = true) {
        const before = this.saved;
        const value = this.persist();
        if (!value) return false;
        if (record && before && value !== before) this.history.record(before, value, group);
        this.undo.disabled = !this.history.undoStack.length;
        this.redo.disabled = !this.history.redoStack.length;
        this.schedulePreview();
        return true;
    }

    moveHistory(direction) {
        const command = this.history.move(direction);
        if (!command) return;
        const previous = normalizeState(JSON.parse(direction === "undo" ? command.before : command.after));
        const expected = normalizeState(JSON.parse(direction === "undo" ? command.after : command.before));
        if (this.state.promptTabs) {
            // Undo belongs to this prompt; retain drafts and blocks opened in other tabs.
            const activePrompt = this.state.activePrompt;
            const current = this.activePrompt(), restored = previous.promptTabs?.find(tab => tab.id === activePrompt) ?? current;
            previous.promptTabs = this.state.promptTabs.map(tab => tab.id === activePrompt ? { ...restored } : tab);
            previous.activePrompt = activePrompt;
            const inactive = this.state.promptTabs.filter(tab => tab.id !== activePrompt);
            const protectedBlocks = new Set(inactive.flatMap(tab => promptSnapshot(this.promptTabState(tab)).blocks.map(block => block.id)));
            const protectedCategories = new Set([...this.state.blocks.filter(block => protectedBlocks.has(block.id)).map(block => block.category),
                ...inactive.map(tab => tab.details.category)]);
            for (const [name, key, protectedKeys] of [["blocks", "id", protectedBlocks], ["categories", "name", protectedCategories]]) {
                const items = new Map(this.state[name].map(item => [item[key], item]));
                const targets = new Map(previous[name].map(item => [item[key], item]));
                const sources = new Map(expected[name].map(item => [item[key], item]));
                for (const id of new Set([...targets.keys(), ...sources.keys()])) {
                    const target = targets.get(id), source = sources.get(id), item = items.get(id);
                    if (target && source && item) {
                        const updated = { ...item };
                        for (const field of new Set([...Object.keys(target), ...Object.keys(source)])) {
                            if (target[field] === source[field] || item[field] !== source[field]) continue;
                            if (Object.hasOwn(target, field)) updated[field] = target[field]; else delete updated[field];
                        }
                        items.set(id, updated);
                    } else if (item === source || (item && source && Object.keys({ ...item, ...source }).every(field => item[field] === source[field]))) {
                        if (target) items.set(id, target); else if (!protectedKeys.has(id)) items.delete(id);
                    }
                }
                previous[name] = [...items.values()];
            }
        }
        this.state = normalizeState(previous);
        this.ensurePromptTabs(); this.restorePromptDetails();
        this.render();
        this.commit(null, false);
    }

    prepareForQueue() {
        if (this.restoring || this.container?.inert) throw new Error("Prompt Designer state restoration is not complete.");
        if (this.restoreError) throw this.restoreError;
        if (hasCycle(this.state)) {
            const cycleIndex = (this.state.cycleIndex ?? -1) + 1;
            if (!Number.isSafeInteger(cycleIndex)) throw new Error("Cycle position is too large.");
            this.state.cycleIndex = cycleIndex;
        }
        if (this.state.afterGenerate === "randomize") {
            this.state.seed = randomSeed();
            this.seed.value = this.state.seed;
        }
        this.commit(null, false);
        return this.persist();
    }

    serializeForPrompt() {
        if (this.restoring || this.container?.inert) throw new Error("Prompt Designer state restoration is not complete.");
        if (this.restoreError) throw this.restoreError;
        return this.persist();
    }

    setStatus(message, error = false) {
        this.status.hidden = !error;
        this.status.textContent = error ? message : "";
        this.status.classList.toggle("error", error);
    }

    schedulePreview() {
        this.revision++;
        this.copy.disabled = true;
        if (this.restoreError) { this.setStatus(`Could not restore state: ${this.restoreError.message}`, true); return; }
        this.setStatus("Updating preview…");
        if (this.previewFrame || this.previewBusy || this.disposed) return;
        this.previewFrame = requestAnimationFrame(() => { this.previewFrame = null; this.preview(); });
    }

    async preview() {
        const revision = this.revision;
        this.previewBusy = true;
        this.request = new AbortController();
        try {
            const response = await this.api.fetchApi("/vnccs/prompt_designer/preview", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(this.state), signal: this.request.signal,
            });
            const result = await readPromptResponse(response);
            if (this.disposed || revision !== this.revision) return;
            if (!response.ok) throw new Error(result.error || "Preview failed.");
            this.showResolvedPrompts(result.prompts ?? [result.prompt]);
            this.copy.disabled = false;
            const saved = this.storageStatus;
            this.setStatus(saved?.message ?? "Live preview · Waiting for disk save", saved?.error ?? false);
        } catch (error) {
            if (!this.disposed && revision === this.revision && error.name !== "AbortError") this.setStatus(error.message, true);
        } finally {
            this.previewBusy = false;
            if (!this.disposed && revision !== this.revision) this.schedulePreview();
        }
    }

    dispose() {
        this.documentStorage?.dispose();
        this.disposed = true;
        this.revision++;
        cancelAnimationFrame(this.previewFrame);
        this.request?.abort();
        clearTimeout(this.blockTimer);
        clearTimeout(this.libraryTimer);
        this.blockRequest?.abort();
        this.events.abort();
        this.selects.disconnect();
    }
}
