const SELECT_STATE = new WeakMap();
const ACTIVE_SELECT_BY_DOCUMENT = new WeakMap();
const STYLE_ID = "vnccs-custom-select-menu-styles";
let customSelectId = 0;


function optionLabel(option) {
    return String(option?.label || option?.textContent || option?.value || "").trim();
}


function optionUnavailable(option) {
    return Boolean(option?.disabled || option?.hidden || option?.parentElement?.disabled);
}


function isSelectElement(element) {
    return String(element?.tagName || "").toUpperCase() === "SELECT";
}


function queueTask(callback) {
    if (typeof queueMicrotask === "function") queueMicrotask(callback);
    else Promise.resolve().then(callback);
}


function cssNumber(value, fallback = 0) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : fallback;
}


function installStyles(doc) {
    if (!doc?.head || doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.vnccs-custom-select-menu {
    position: fixed;
    z-index: 1000000;
    display: flex;
    flex-direction: column;
    gap: 2px;
    box-sizing: border-box;
    max-height: min(70vh, 520px);
    padding: 6px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid rgba(255, 143, 163, .34);
    border-radius: 10px;
    background: #171320;
    color: #e8e8f0;
    box-shadow: 0 16px 44px rgba(0, 0, 0, .58);
    font: 11px 'Sora', -apple-system, BlinkMacSystemFont, sans-serif;
    pointer-events: auto;
}
.vnccs-custom-select-menu--model-manager {
    border-color: #555;
    border-radius: 6px;
    background: #222;
    color: #ddd;
    font-family: sans-serif;
}
.vnccs-custom-select-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 30px;
    padding: 6px 9px;
    box-sizing: border-box;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
}
.vnccs-custom-select-option:hover,
.vnccs-custom-select-option.is-highlighted {
    background: rgba(255, 143, 163, .18);
    color: #ffdce5;
}
.vnccs-custom-select-menu--model-manager .vnccs-custom-select-option:hover,
.vnccs-custom-select-menu--model-manager .vnccs-custom-select-option.is-highlighted {
    background: #3a3a3a;
    color: #fff;
}
.vnccs-custom-select-option:disabled {
    opacity: .38;
    cursor: not-allowed;
}
.vnccs-custom-select-check {
    flex: 0 0 16px;
    width: 16px;
    color: #ff8fa3;
    font-weight: 900;
}
.vnccs-custom-select-menu--model-manager .vnccs-custom-select-check { color: #8f8; }
.vnccs-custom-select-option-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: visible;
    overflow-wrap: anywhere;
    text-overflow: clip;
    white-space: normal;
}
.vnccs-custom-select-group {
    padding: 7px 9px 3px;
    color: #9898a8;
    font-size: .86em;
    font-weight: 800;
    letter-spacing: .06em;
    text-transform: uppercase;
}
`;
    doc.head.appendChild(style);
}


function findPropertyDescriptor(object, property) {
    for (let current = object; current; current = Object.getPrototypeOf(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, property);
        if (descriptor) return descriptor;
    }
    return null;
}


function interceptSelectProperty(select, property, onSet) {
    if (Object.prototype.hasOwnProperty.call(select, property)) return () => {};
    const descriptor = findPropertyDescriptor(select, property);
    if (!descriptor?.get || !descriptor?.set) return () => {};
    try {
        Object.defineProperty(select, property, {
            configurable: true,
            enumerable: descriptor.enumerable,
            get() {
                return descriptor.get.call(this);
            },
            set(value) {
                descriptor.set.call(this, value);
                onSet();
            },
        });
        return () => {
            try { delete select[property]; } catch (_) {}
        };
    } catch (_) {
        return () => {};
    }
}


function interceptShowPicker(select, open) {
    if (typeof select.showPicker !== "function") return () => {};
    const original = Object.getOwnPropertyDescriptor(select, "showPicker");
    try {
        Object.defineProperty(select, "showPicker", {
            configurable: true,
            value: open,
        });
        return () => {
            try {
                if (original) Object.defineProperty(select, "showPicker", original);
                else delete select.showPicker;
            } catch (_) {}
        };
    } catch (_) {
        return () => {};
    }
}


export function findNextEnabledOptionIndex(options, startIndex, direction = 1) {
    const list = Array.from(options || []);
    if (!list.length) return -1;
    const step = direction < 0 ? -1 : 1;
    let index = Number.isInteger(startIndex) ? startIndex : (step > 0 ? -1 : 0);
    for (let count = 0; count < list.length; count++) {
        index = (index + step + list.length) % list.length;
        if (!optionUnavailable(list[index])) return index;
    }
    return -1;
}


export function findBoundaryEnabledOptionIndex(options, fromEnd = false) {
    const list = Array.from(options || []);
    if (fromEnd) {
        for (let index = list.length - 1; index >= 0; index--) {
            if (!optionUnavailable(list[index])) return index;
        }
        return -1;
    }
    return list.findIndex(option => !optionUnavailable(option));
}


function collectMenuEntries(select) {
    const entries = [];
    let optionIndex = 0;
    for (const child of Array.from(select.children || [])) {
        const tagName = String(child.tagName || "").toUpperCase();
        if (tagName === "OPTGROUP") {
            entries.push({ type: "group", label: child.label || "" });
            for (const option of Array.from(child.children || [])) {
                if (String(option.tagName || "").toUpperCase() !== "OPTION") continue;
                entries.push({ type: "option", option, optionIndex });
                optionIndex++;
            }
        } else if (tagName === "OPTION") {
            entries.push({ type: "option", option: child, optionIndex });
            optionIndex++;
        }
    }
    return entries;
}


function measureLongestOptionWidth(doc, options, selectStyle) {
    const fallback = options.reduce((width, option) => (
        Math.max(width, optionLabel(option).length * Math.max(7, cssNumber(selectStyle.fontSize, 11) * .64))
    ), 0);
    try {
        const canvas = doc.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) return fallback;
        context.font = selectStyle.font || [
            selectStyle.fontStyle,
            selectStyle.fontWeight,
            selectStyle.fontSize,
            selectStyle.fontFamily,
        ].filter(Boolean).join(" ");
        return options.reduce((width, option) => (
            Math.max(width, context.measureText(optionLabel(option)).width)
        ), 0);
    } catch (_) {
        return fallback;
    }
}


function positionMenu(state) {
    const { menu, select } = state;
    if (!menu?.isConnected || !select?.isConnected) return;
    const view = select.ownerDocument.defaultView;
    const rect = select.getBoundingClientRect();
    const selectStyle = view.getComputedStyle(select);
    const options = Array.from(select.options || []);
    const longestTextWidth = measureLongestOptionWidth(select.ownerDocument, options, selectStyle);
    const viewportGap = 8;
    // Menu chrome: check (16), gap (8), option padding (18), menu
    // padding/borders (14), plus scrollbar and rounding safety (18).
    const desiredWidth = Math.max(rect.width, Math.min(560, longestTextWidth + 74));
    const width = Math.max(80, Math.min(desiredWidth, view.innerWidth - viewportGap * 2));
    const left = Math.min(Math.max(viewportGap, rect.left), view.innerWidth - viewportGap - width);
    const below = view.innerHeight - rect.bottom - viewportGap;
    const above = rect.top - viewportGap;
    const maxHeight = Math.max(100, Math.min(520, Math.max(below, above)));

    menu.style.left = `${Math.round(left)}px`;
    menu.style.width = `${Math.round(width)}px`;
    menu.style.maxHeight = `${Math.round(maxHeight)}px`;
    menu.style.fontFamily = selectStyle.fontFamily;
    menu.style.fontSize = selectStyle.fontSize;
    menu.style.fontWeight = selectStyle.fontWeight;
    if (below < Math.min(180, maxHeight) && above > below) {
        menu.style.top = "";
        menu.style.bottom = `${Math.round(view.innerHeight - rect.top + 4)}px`;
    } else {
        menu.style.bottom = "";
        menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    }
}


function renderMenuSelection(state) {
    if (!state.menu) return;
    for (const row of state.menu.querySelectorAll(".vnccs-custom-select-option")) {
        const selected = Number(row.dataset.optionIndex) === state.select.selectedIndex;
        row.setAttribute("aria-selected", selected ? "true" : "false");
        const check = row.querySelector(".vnccs-custom-select-check");
        if (check) check.textContent = selected ? "✓" : "";
    }
}


function syncCustomSelect(state) {
    if (state.destroyed) return;
    if (state.select.disabled && state.menu) closeCustomSelect(state);
    else renderMenuSelection(state);
}


function scheduleSync(state) {
    if (state.syncQueued || state.destroyed) return;
    state.syncQueued = true;
    queueTask(() => {
        state.syncQueued = false;
        syncCustomSelect(state);
    });
}


function setHighlightedIndex(state, index, scroll = true) {
    const options = Array.from(state.select.options || []);
    if (index < 0 || index >= options.length || optionUnavailable(options[index])) return;
    state.highlightedIndex = index;
    for (const row of state.menu?.querySelectorAll?.(".vnccs-custom-select-option") || []) {
        const active = Number(row.dataset.optionIndex) === index;
        row.classList.toggle("is-highlighted", active);
        if (active) {
            state.select.setAttribute("aria-activedescendant", row.id);
            if (scroll) row.scrollIntoView({ block: "nearest" });
        }
    }
}


function closeCustomSelect(state, { restoreFocus = false } = {}) {
    if (!state?.menu) return;
    const doc = state.select.ownerDocument;
    const view = doc.defaultView;
    state.menu.remove();
    state.menu = null;
    state.select.setAttribute("aria-expanded", "false");
    if (state.originalAriaControls === null) state.select.removeAttribute("aria-controls");
    else state.select.setAttribute("aria-controls", state.originalAriaControls);
    state.select.removeAttribute("aria-activedescendant");
    doc.removeEventListener("pointerdown", state.onOutsidePointerDown, true);
    view?.removeEventListener("resize", state.onViewportChange, true);
    view?.removeEventListener("scroll", state.onViewportChange, true);
    if (ACTIVE_SELECT_BY_DOCUMENT.get(doc) === state) ACTIVE_SELECT_BY_DOCUMENT.delete(doc);
    if (restoreFocus && state.select.isConnected) state.select.focus({ preventScroll: true });
}


function chooseOption(state, optionIndex) {
    const option = state.select.options?.[optionIndex];
    if (!option || optionUnavailable(option)) return;
    const changed = state.select.selectedIndex !== optionIndex;
    state.select.selectedIndex = optionIndex;
    closeCustomSelect(state, { restoreFocus: true });
    if (!changed) return;
    const EventConstructor = state.select.ownerDocument.defaultView?.Event || Event;
    state.select.dispatchEvent(new EventConstructor("input", { bubbles: true }));
    state.select.dispatchEvent(new EventConstructor("change", { bubbles: true }));
}


function openCustomSelect(state) {
    if (state.destroyed || state.menu || state.select.disabled || !state.select.isConnected) return;
    const doc = state.select.ownerDocument;
    const current = ACTIVE_SELECT_BY_DOCUMENT.get(doc);
    if (current && current !== state) closeCustomSelect(current);

    const menu = doc.createElement("div");
    menu.className = `vnccs-custom-select-menu vnccs-custom-select-menu--${state.config.theme}`;
    menu.id = `${state.id}-menu`;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", state.select.getAttribute("aria-label") || state.select.title || "Options");

    for (const entry of collectMenuEntries(state.select)) {
        if (entry.type === "group") {
            const group = doc.createElement("div");
            group.className = "vnccs-custom-select-group";
            group.textContent = entry.label;
            menu.appendChild(group);
            continue;
        }
        const { option, optionIndex } = entry;
        if (option.hidden) continue;
        const row = doc.createElement("button");
        row.type = "button";
        row.id = `${state.id}-option-${optionIndex}`;
        row.className = "vnccs-custom-select-option";
        row.dataset.optionIndex = String(optionIndex);
        row.disabled = optionUnavailable(option);
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", optionIndex === state.select.selectedIndex ? "true" : "false");

        const check = doc.createElement("span");
        check.className = "vnccs-custom-select-check";
        check.textContent = optionIndex === state.select.selectedIndex ? "✓" : "";
        const label = doc.createElement("span");
        label.className = "vnccs-custom-select-option-label";
        label.textContent = optionLabel(option);
        if (option.style?.color) label.style.color = option.style.color;
        row.append(check, label);
        row.addEventListener("pointerdown", event => {
            event.preventDefault();
            event.stopPropagation();
        });
        row.addEventListener("pointerenter", () => setHighlightedIndex(state, optionIndex, false));
        row.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            chooseOption(state, optionIndex);
        });
        menu.appendChild(row);
    }

    menu.addEventListener("pointerdown", event => event.stopPropagation());
    menu.addEventListener("click", event => event.stopPropagation());
    menu.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
    doc.body.appendChild(menu);
    state.menu = menu;
    state.highlightedIndex = state.select.selectedIndex >= 0
        ? state.select.selectedIndex
        : findBoundaryEnabledOptionIndex(state.select.options);
    state.select.setAttribute("aria-haspopup", "listbox");
    state.select.setAttribute("aria-expanded", "true");
    state.select.setAttribute("aria-controls", menu.id);
    ACTIVE_SELECT_BY_DOCUMENT.set(doc, state);
    positionMenu(state);
    setHighlightedIndex(state, state.highlightedIndex);
    doc.addEventListener("pointerdown", state.onOutsidePointerDown, true);
    doc.defaultView?.addEventListener("resize", state.onViewportChange, true);
    doc.defaultView?.addEventListener("scroll", state.onViewportChange, true);
}


function toggleCustomSelect(state) {
    if (state.menu) closeCustomSelect(state, { restoreFocus: true });
    else openCustomSelect(state);
}


function handleSelectKeyDown(state, event) {
    const options = state.select.options || [];
    if (event.key === "Escape") {
        if (!state.menu) return;
        event.preventDefault();
        event.stopPropagation();
        closeCustomSelect(state, { restoreFocus: true });
        return;
    }
    if (event.key === "Tab") {
        closeCustomSelect(state);
        return;
    }
    if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        if (state.menu && state.highlightedIndex >= 0) chooseOption(state, state.highlightedIndex);
        else openCustomSelect(state);
        return;
    }
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        if (!state.menu) openCustomSelect(state);
        const direction = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
        const start = state.highlightedIndex >= 0 ? state.highlightedIndex : state.select.selectedIndex;
        setHighlightedIndex(state, findNextEnabledOptionIndex(options, start, direction));
        return;
    }
    if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        if (!state.menu) openCustomSelect(state);
        setHighlightedIndex(state, findBoundaryEnabledOptionIndex(options, event.key === "End"));
        return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    const now = Date.now();
    state.typeahead = now - state.typeaheadAt > 700 ? event.key : state.typeahead + event.key;
    state.typeaheadAt = now;
    const query = state.typeahead.toLocaleLowerCase();
    const match = Array.from(options).findIndex(option => (
        !optionUnavailable(option) && optionLabel(option).toLocaleLowerCase().startsWith(query)
    ));
    if (match < 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!state.menu) openCustomSelect(state);
    setHighlightedIndex(state, match);
}


export function enhanceCustomSelect(select, config = {}) {
    if (!isSelectElement(select)) return null;
    const existing = SELECT_STATE.get(select);
    if (existing) return existing.api;
    const doc = select.ownerDocument;
    if (!doc?.createElement) return null;
    installStyles(doc);

    const state = {
        id: `vnccs-custom-select-${++customSelectId}`,
        select,
        config: {
            theme: String(config.theme || "pose-studio").replace(/[^a-z0-9_-]/gi, "-"),
        },
        menu: null,
        highlightedIndex: -1,
        typeahead: "",
        typeaheadAt: 0,
        syncQueued: false,
        destroyed: false,
        propertyCleanups: [],
        mutationObserver: null,
        originalAriaHasPopup: select.getAttribute("aria-haspopup"),
        originalAriaExpanded: select.getAttribute("aria-expanded"),
        originalAriaControls: select.getAttribute("aria-controls"),
        api: null,
    };
    state.onOutsidePointerDown = event => {
        if (event.target === select || state.menu?.contains(event.target)) return;
        closeCustomSelect(state);
    };
    state.onViewportChange = event => {
        if (event?.target === state.menu) return;
        closeCustomSelect(state);
    };
    state.onPointerDown = event => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        select.focus({ preventScroll: true });
        toggleCustomSelect(state);
    };
    state.onClick = event => {
        event.preventDefault();
        event.stopPropagation();
        if (event.detail > 0) return;
        select.focus({ preventScroll: true });
        toggleCustomSelect(state);
    };
    state.onKeyDown = event => handleSelectKeyDown(state, event);
    state.onSourceChange = () => syncCustomSelect(state);

    select.setAttribute("aria-haspopup", "listbox");
    select.setAttribute("aria-expanded", "false");
    select.addEventListener("pointerdown", state.onPointerDown, true);
    if (!doc.defaultView?.PointerEvent) select.addEventListener("mousedown", state.onPointerDown, true);
    select.addEventListener("click", state.onClick, true);
    select.addEventListener("keydown", state.onKeyDown, true);
    select.addEventListener("change", state.onSourceChange);
    select.addEventListener("input", state.onSourceChange);
    state.propertyCleanups.push(
        interceptSelectProperty(select, "value", () => scheduleSync(state)),
        interceptSelectProperty(select, "selectedIndex", () => scheduleSync(state)),
        interceptSelectProperty(select, "disabled", () => scheduleSync(state)),
        interceptShowPicker(select, () => openCustomSelect(state)),
    );

    const MutationObserverConstructor = doc.defaultView?.MutationObserver;
    if (MutationObserverConstructor) {
        state.mutationObserver = new MutationObserverConstructor(() => {
            if (state.menu) closeCustomSelect(state);
            scheduleSync(state);
        });
        state.mutationObserver.observe(select, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["disabled", "hidden", "label", "selected", "title", "value"],
        });
    }

    const restoreAttribute = (name, value) => {
        if (value === null) select.removeAttribute(name);
        else select.setAttribute(name, value);
    };
    const destroy = () => {
        if (state.destroyed) return;
        state.destroyed = true;
        closeCustomSelect(state);
        state.mutationObserver?.disconnect();
        select.removeEventListener("pointerdown", state.onPointerDown, true);
        select.removeEventListener("mousedown", state.onPointerDown, true);
        select.removeEventListener("click", state.onClick, true);
        select.removeEventListener("keydown", state.onKeyDown, true);
        select.removeEventListener("change", state.onSourceChange);
        select.removeEventListener("input", state.onSourceChange);
        for (const cleanup of state.propertyCleanups) cleanup();
        restoreAttribute("aria-haspopup", state.originalAriaHasPopup);
        restoreAttribute("aria-expanded", state.originalAriaExpanded);
        restoreAttribute("aria-controls", state.originalAriaControls);
        select.removeAttribute("aria-activedescendant");
        SELECT_STATE.delete(select);
        config.onDestroy?.(select);
    };
    state.api = {
        select,
        open: () => openCustomSelect(state),
        close: () => closeCustomSelect(state),
        refresh: () => syncCustomSelect(state),
        destroy,
    };
    SELECT_STATE.set(select, state);
    return state.api;
}


export function installCustomSelects(root, config = {}) {
    if (!root?.querySelectorAll) return { refresh() {}, disconnect() {} };
    const selector = config.selector || "select";
    const controls = new Set();
    let disconnected = false;

    const enhance = select => {
        if (disconnected || !isSelectElement(select) || !select.matches(selector)) return;
        const control = enhanceCustomSelect(select, {
            ...config,
            onDestroy: destroyedSelect => {
                for (const item of controls) {
                    if (item.select === destroyedSelect) controls.delete(item);
                }
                config.onDestroy?.(destroyedSelect);
            },
        });
        if (control) controls.add(control);
    };
    const scan = node => {
        if (!node) return;
        if (node.nodeType === 1 && node.matches?.(selector)) enhance(node);
        for (const select of node.querySelectorAll?.(selector) || []) enhance(select);
    };
    scan(root);

    const MutationObserverConstructor = root.ownerDocument?.defaultView?.MutationObserver;
    const observer = MutationObserverConstructor ? new MutationObserverConstructor(records => {
        for (const record of records) {
            for (const node of record.addedNodes) scan(node);
        }
        for (const record of records) {
            for (const node of record.removedNodes) {
                const removed = [];
                if (isSelectElement(node)) removed.push(node);
                removed.push(...(node.querySelectorAll?.("select") || []));
                for (const select of removed) {
                    if (root.contains(select)) continue;
                    SELECT_STATE.get(select)?.api.destroy();
                }
            }
        }
    }) : null;
    observer?.observe(root, { childList: true, subtree: true });

    return {
        refresh() {
            scan(root);
            for (const control of controls) control.refresh();
        },
        disconnect() {
            if (disconnected) return;
            disconnected = true;
            observer?.disconnect();
            for (const control of [...controls]) control.destroy();
            controls.clear();
        },
    };
}
