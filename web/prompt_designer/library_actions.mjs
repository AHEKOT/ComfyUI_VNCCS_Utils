import { promptId } from "./state.mjs";

function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

export class LibraryActions {
    close(restoreFocus = true) {
        const popup = this.popup;
        if (!popup) return;
        this.popup = null;
        popup.events.abort();
        if (popup.element.open) popup.element.close();
        popup.element.remove();
        if (restoreFocus && popup.focus?.isConnected) popup.focus.focus({ preventScroll: true });
    }

    mount(element, focus) {
        this.close(false);
        const events = new AbortController();
        this.popup = { element, focus, events };
        document.body.append(element);
        for (const type of ["pointerdown", "click", "keydown", "paste", "wheel"]) {
            element.addEventListener(type, event => event.stopPropagation(), { signal: events.signal });
        }
        return (target, type, listener, capture = false) => target.addEventListener(type, listener, { signal: events.signal, capture });
    }

    menu(event, anchor, actions) {
        event.preventDefault(); event.stopPropagation();
        const menu = node("div", undefined, "vnccs-pd-library-menu");
        menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Library card actions");
        const on = this.mount(menu, anchor);
        on(menu, "contextmenu", event => { event.preventDefault(); event.stopPropagation(); });
        const buttons = actions.map(([label, action]) => {
            const button = node("button", label); button.type = "button";
            button.setAttribute("role", "menuitem"); button.tabIndex = -1;
            if (label === "Delete") button.className = "danger";
            on(button, "click", () => { this.close(); action(); });
            menu.append(button); return button;
        });
        const rect = anchor.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
        const x = event.clientX || rect.left, y = event.clientY || rect.bottom;
        menu.style.left = `${Math.max(8, Math.min(x, (window.innerWidth || 1024) - (bounds.width || 190) - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, (window.innerHeight || 768) - (bounds.height || 130) - 8))}px`;
        on(document, "pointerdown", event => { if (!menu.contains(event.target)) this.close(); }, true);
        on(menu, "keydown", event => {
            if (["Escape", "Tab"].includes(event.key)) { if (event.key === "Escape") event.preventDefault(); this.close(); return; }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const current = buttons.indexOf(document.activeElement);
            const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
                : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[index].focus({ preventScroll: true });
        });
        buttons[0].focus({ preventScroll: true });
    }

    dialog({ title, message, value, action, label, discard }) {
        const dialog = node("dialog", undefined, "vnccs-pd-library-dialog");
        const focus = document.activeElement, on = this.mount(dialog, focus);
        const heading = node("h2", title); heading.id = `vnccs-pd-dialog-${promptId()}`;
        dialog.setAttribute("aria-labelledby", heading.id);
        const form = node("form"), description = node("p", message), error = node("p", "", "error");
        error.hidden = true; error.setAttribute("role", "alert");
        form.append(heading, description);
        let input;
        if (value !== undefined) {
            input = node("input"); input.value = value; input.required = true; input.maxLength = 128;
            input.setAttribute("aria-label", "New name"); form.append(input);
        }
        const controls = node("div", undefined, "actions"), cancel = node("button", "Cancel"); cancel.type = "button";
        const confirmLabel = label ?? (input ? "Rename" : "Delete");
        const confirm = node("button", confirmLabel, "primary"); confirm.type = "submit";
        const discardButton = discard && node("button", "Discard");
        controls.append(cancel);
        if (discardButton) {
            discardButton.type = "button"; controls.append(discardButton);
            on(discardButton, "click", () => { if (!confirm.disabled) { this.close(); discard(); } });
        }
        controls.append(confirm); form.append(error, controls); dialog.append(form);
        on(cancel, "click", () => this.close());
        on(dialog, "cancel", event => { event.preventDefault(); if (!confirm.disabled) this.close(); });
        on(form, "submit", async event => {
            event.preventDefault();
            if (confirm.disabled) return;
            const name = input?.value.trim();
            if (input && !name) { input.focus(); return; }
            confirm.disabled = true; cancel.disabled = true; if (discardButton) discardButton.disabled = true; error.hidden = true;
            confirm.textContent = label ? "Saving…" : input ? "Renaming…" : "Deleting…";
            try {
                await action(name);
                if (this.popup?.element === dialog) this.close();
            } catch (failure) {
                error.textContent = failure.message; error.hidden = false;
            } finally { confirm.disabled = false; cancel.disabled = false; if (discardButton) discardButton.disabled = false; confirm.textContent = confirmLabel; }
        });
        dialog.showModal();
        (input ?? cancel).focus({ preventScroll: true }); input?.select();
    }
}
