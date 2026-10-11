import { defaultState as emptyState } from "../../web/prompt_designer/state.mjs";

// Test fixtures are explicit; new nodes must never restore these demo cards.
export function sampleState() {
    return { ...emptyState(), blocks: [
        { id: "artists", name: "Artists", text: "{~watercolor illustration|ink illustration|cel shading}" },
        { id: "clothing", name: "Clothing", text: "{~asymmetrical jacket|linen shirt|knit sweater}" },
        { id: "hair", name: "Hair", text: "{~short black hair|long brown hair|white hair}" },
        { id: "pose", name: "Pose", text: "{~standing|sitting|walking}" },
    ], parts: [{ text: "anime style, masterpiece,\n" }, { blockId: "artists" }, { text: ", wear: " },
        { blockId: "clothing" }, { text: ",\n" }, { blockId: "hair" }, { text: ", standing" }] };
}

export const text = textContent => ({ nodeType: 3, textContent, get parentElement() { return this.parentNode; } });
export function dom(tag = "div") {
    const node = {
        nodeType: 1, tagName: tag.toUpperCase(), dataset: {}, attributes: {}, childNodes: [], listeners: new Map(),
        scrollTop: 0, scrollLeft: 0, value: "", hidden: false, clientWidth: 2200, offsetWidth: 460,
        style: { setProperty(name, value) { this[name] = value; } },
        get parentElement() { return this.parentNode; },
        get children() { return this.childNodes.filter(node => node.nodeType === 1); },
        get firstChild() { return this.childNodes[0]; }, get lastChild() { return this.childNodes.at(-1); },
        get lastElementChild() { return this.children.at(-1); },
        get textContent() { return this.childNodes.map(child => child.textContent).join(""); },
        set textContent(value) { this.replaceChildren(...(value === "" ? [] : [text(String(value))])); },
        append(...children) { for (const child of children) { child.remove?.(); child.parentNode = this; this.childNodes.push(child); } },
        remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; },
        replaceChild(child, previous) { child.parentNode = this; this.childNodes[this.childNodes.indexOf(previous)] = child; previous.parentNode = null; },
        replaceChildren(...children) { for (const child of this.childNodes) child.parentNode = null; this.childNodes = []; this.append(...children); },
        setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; },
        matches(selector) {
            return selector.split(",").some(part => {
                part = part.trim();
                if (part.startsWith(".")) return this.className?.split(" ").includes(part.slice(1));
                const data = /^\[data-(.+)\]$/.exec(part);
                if (data) return Object.hasOwn(this.dataset, data[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase()));
                return this.tagName === part.toUpperCase();
            });
        },
        closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest?.(selector) ?? null; },
        addEventListener(type, listener, options = {}) {
            const previous = this.listeners.get(type);
            this.listeners.set(type, event => {
                event ??= {}; event.target ??= this;
                event.preventDefault ??= () => { event.defaultPrevented = true; };
                event.stopPropagation ??= () => { event.stopped = true; };
                previous?.(event); if (!options.signal?.aborted) listener(event);
            });
        },
        dispatchEvent(event) { this.listeners.get(event.type)?.(event); },
        contains(child) { return this === child || this.childNodes.some(node => node === child || node.contains?.(child)); },
        querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
        querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
        focus() { if (globalThis.document) document.activeElement = this; }, select() {},
        showModal() { this.open = true; }, close() { this.open = false; },
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
        getBoundingClientRect() { return { width: this.offsetWidth, left: 0, right: this.offsetWidth }; }, setPointerCapture() {},
    };
    node.classList = {
        contains(value) { return node.className?.split(" ").includes(value) ?? false; },
        add(...values) { node.className = [...new Set([...(node.className?.split(" ").filter(Boolean) ?? []), ...values])].join(" "); },
        remove(...values) { node.className = (node.className?.split(" ") ?? []).filter(value => !values.includes(value)).join(" "); },
        toggle(value, on) { if (on ?? !this.contains(value)) this.add(value); else this.remove(value); },
    };
    return node;
}

export function installDom(t) {
    const previous = ["document", "window"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    const selection = { rangeCount: 0, isCollapsed: true, removeAllRanges() { this.rangeCount = 0; this.isCollapsed = true; },
        addRange(range) { this.rangeCount = 1; this.range = range; this.anchorNode = range.startContainer; this.focusNode = range.endContainer; this.isCollapsed = range.collapsed; },
        getRangeAt() { return this.range; } };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { getSelection: () => selection } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
        ...dom("document"), body: dom("body"),
        getElementById: () => ({}), createElement: dom, createTextNode: text,
        createRange: () => ({
            setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
            setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
            setStartBefore(node) { this.setStart(node.parentNode, node.parentNode.childNodes.indexOf(node)); },
            setStartAfter(node) { this.setStart(node.parentNode, node.parentNode.childNodes.indexOf(node) + 1); },
            setEndBefore(node) { this.setEnd(node.parentNode, node.parentNode.childNodes.indexOf(node)); },
            setEndAfter(node) { this.setEnd(node.parentNode, node.parentNode.childNodes.indexOf(node) + 1); },
            selectNode(node) { this.setStartBefore(node); this.setEndAfter(node); },
            selectNodeContents(node) { this.setStart(node, 0); this.setEnd(node, node.nodeType === 3 ? node.textContent.length : node.childNodes.length); },
            collapse(start) { if (start) this.setEnd(this.startContainer, this.startOffset); else this.setStart(this.endContainer, this.endOffset); this.collapsed = true; },
            cloneRange() { return { ...this }; },
            deleteContents() {
                if (this.startContainer !== this.endContainer) throw new Error("Use an explicit boundary spy for cross-node ranges");
                const node = this.startContainer;
                if (node.nodeType === 3) node.textContent = node.textContent.slice(0, this.startOffset) + node.textContent.slice(this.endOffset);
                else node.childNodes.splice(this.startOffset, this.endOffset - this.startOffset);
            },
            insertNode(node) {
                const parent = this.startContainer;
                if (parent.nodeType !== 1) throw new Error("Use an element insertion boundary in this harness");
                node.parentNode = parent; parent.childNodes.splice(this.startOffset, 0, node);
            },
        }),
    } });
    t.after(() => { for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
    return selection;
}

export function node() {
    return { properties: {}, widgets: [{ name: "node_state", value: "{}" }], outputs: [{ name: "prompt", type: "STRING", links: [] }],
        addOutput(name, type) { this.outputs.push({ name, type, links: [] }); }, removeOutput(index) { this.outputs.splice(index, 1); } };
}
