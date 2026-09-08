/** Bind existing numeric rows without replacing their DOM, focus or scroll. */
export function bindNumericPropertyInputs(root, { descriptors, ref, gesture, read, feedback, prefix = "light." }) {
    const listeners = [];
    let scrub = null;
    const controls = [...root.querySelectorAll("[data-editor-path]")];
    const pathOf = control => prefix && control.dataset.editorPath.startsWith(prefix)
        ? control.dataset.editorPath.slice(prefix.length) : control.dataset.editorPath;
    const listen = (control, event, handler) => {
        control.addEventListener(event, handler);
        listeners.push(() => control.removeEventListener(event, handler));
    };
    const sync = (path, value, source = null) => {
        for (const peer of controls) {
            if (pathOf(peer) !== path) continue;
            // Exact input can extend the convenience window without shrinking it
            // while a pointer is moving. The accepted value stays visible.
            if (peer.type === "range") {
                peer.min = String(Math.min(Number(peer.min), value));
                peer.max = String(Math.max(Number(peer.max), value));
            }
            if (peer !== source) peer.value = String(value);
            peer.removeAttribute("aria-invalid");
            peer.setCustomValidity("");
        }
    };
    const cancel = control => {
        gesture.cancel();
        const path = pathOf(control);
        const value = read(ref, path);
        if (Number.isFinite(value)) sync(path, value);
        feedback("Edit cancelled.");
    };
    for (const control of controls) {
        const path = pathOf(control);
        const descriptor = descriptors[path];
        if (!descriptor) continue;
        listen(control, "input", () => {
            const accepted = gesture.input(ref, descriptor, control.value);
            control.setAttribute("aria-invalid", String(!accepted.valid));
            control.setCustomValidity(accepted.valid ? "" : accepted.message);
            feedback(accepted.message);
            if (accepted.valid) sync(path, accepted.value, accepted.message ? null : control);
        });
        const finish = () => {
            if (control.getAttribute("aria-invalid") === "true") cancel(control);
            else {
                gesture.commit();
                const value = read(ref, path);
                if (Number.isFinite(value)) sync(path, value);
            }
        };
        listen(control, "change", finish);
        listen(control, "blur", finish);
        listen(control, "pointerup", () => { if (control.type === "range") finish(); });
        listen(control, "pointercancel", () => cancel(control));
        listen(control, "lostpointercapture", () => { if (gesture.pending) cancel(control); });
        listen(control, "keydown", event => {
            if (["ArrowUp", "ArrowDown"].includes(event.key) && control.type !== "range") {
                event.preventDefault(); event.stopPropagation();
                const step = descriptor.step * (event.shiftKey ? 0.1 : event.altKey ? 10 : 1);
                const value = read(ref, path) + (event.key === "ArrowUp" ? step : -step);
                const accepted = gesture.input(ref, descriptor, String(value));
                if (accepted.valid) sync(path, accepted.value);
                feedback(accepted.message);
                return;
            }
            if (event.key !== "Escape" && event.key !== "Enter") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") cancel(control);
            else finish();
        });
        listen(control, "keyup", event => {
            if (["ArrowUp", "ArrowDown"].includes(event.key)) finish();
        });
    }
    for (const control of root.querySelectorAll("[data-numeric-scrub]")) {
        const rawPath = control.dataset.numericScrub;
        if (!rawPath) continue;
        const path = prefix && rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
        const descriptor = descriptors[path];
        if (!descriptor) continue;
        const settle = rollback => {
            if (scrub?.control !== control) return;
            const pointerId = scrub.pointerId;
            scrub = null;
            if (rollback) gesture.cancel(); else gesture.commit();
            sync(path, read(ref, path));
            if (control.hasPointerCapture?.(pointerId)) control.releasePointerCapture(pointerId);
        };
        listen(control, "pointerdown", event => {
            if (control.disabled || event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            gesture.commit();
            const scale = control.getBoundingClientRect().width / Math.max(1, control.offsetWidth);
            scrub = { control, pointerId: event.pointerId, x: event.clientX, value: read(ref, path), scale: scale || 1 };
            control.focus({ preventScroll: true });
            control.setPointerCapture(event.pointerId);
        });
        listen(control, "pointermove", event => {
            if (scrub?.control !== control || scrub.pointerId !== event.pointerId) return;
            const factor = event.shiftKey ? 0.1 : event.altKey ? 10 : 1;
            const value = scrub.value + (event.clientX - scrub.x) / scrub.scale * descriptor.step * factor;
            const accepted = gesture.input(ref, descriptor, String(value));
            if (accepted.valid) sync(path, accepted.value);
            feedback(accepted.message);
        });
        listen(control, "pointerup", () => settle(false));
        listen(control, "pointercancel", () => settle(true));
        listen(control, "lostpointercapture", () => settle(true));
        listen(control, "keydown", event => {
            if (event.key === "Escape" && scrub?.control === control) {
                event.preventDefault(); event.stopPropagation(); settle(true);
            }
        });
    }
    for (const control of root.querySelectorAll("[data-numeric-reset]")) {
        const rawPath = control.dataset.numericReset;
        if (!rawPath) continue;
        const path = prefix && rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
        const descriptor = descriptors[path];
        if (!descriptor || !Number.isFinite(descriptor.defaultValue)) continue;
        listen(control, "click", () => {
            gesture.commit();
            const accepted = gesture.input(ref, descriptor, String(descriptor.defaultValue));
            if (accepted.valid) sync(path, accepted.value);
            gesture.commit();
            feedback(accepted.message || `${descriptor.label} reset.`);
        });
    }
    return ({ cancel: rollback = false } = {}) => {
        for (const remove of listeners) remove();
        if (scrub?.control.hasPointerCapture?.(scrub.pointerId)) scrub.control.releasePointerCapture(scrub.pointerId);
        scrub = null;
        if (rollback || controls.some(control => control.getAttribute("aria-invalid") === "true")) gesture.cancel();
        else gesture.commit();
    };
}
