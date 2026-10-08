// Double-click the "W×H" preview next to Inference scale to type the scale itself
// (a multiplier of the Generation box: 1 = box size, 1.5 = one and a half times).

export const INFERENCE_SCALE_MIN = 0.5;
export const INFERENCE_SCALE_MAX = 3;

// Parses typed text ("1,5" and "1.5" both work); null when it is not a usable number.
export function parseInferenceScale(text) {
    const value = Number(String(text ?? "").trim().replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.min(INFERENCE_SCALE_MAX, Math.max(INFERENCE_SCALE_MIN, Math.round(value * 100) / 100));
}

// Replaces the size label with a number field until Enter / blur (commit) or Escape (cancel).
export function editInferenceScale(widget, label) {
    if (!label || label.dataset.editing === "1") return null;
    const document = label.ownerDocument;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.className = "vnccs-uc-input vnccs-uc-infer-scale-edit";
    input.value = String(Number(widget.settings.inference_scale) || 1);
    input.title = "Scale relative to the Generation box: 1 = box size, 1.5 = one and a half times. Enter applies, Esc cancels.";
    input.setAttribute("aria-label", "Inference scale");
    label.dataset.editing = "1";
    label.hidden = true;
    label.after(input);
    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        const value = commit ? parseInferenceScale(input.value) : null;
        input.remove();
        label.hidden = false;
        delete label.dataset.editing;
        if (value === null) return;
        widget.settings.inference_scale = value;
        widget.syncInferenceControls();
        widget.syncSettingsToWidget();
    };
    input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") { event.preventDefault(); finish(true); }
        else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
    return input;
}

export function installInferenceScaleEdit(widget) {
    const onDoubleClick = (event) => {
        const label = event.target?.closest?.("[data-inference-size]");
        if (!label) return;
        event.preventDefault();
        editInferenceScale(widget, label);
    };
    widget.container.addEventListener("dblclick", onDoubleClick);
    return () => widget.container.removeEventListener("dblclick", onDoubleClick);
}
