// Double-click the scale label to enter MP in the standalone tab or a side multiplier in the node.

export const INFERENCE_SCALE_MIN = 0.5;
export const INFERENCE_SCALE_MAX = 3;
export const INFERENCE_SCALE_MP_MIN = 1;
export const INFERENCE_SCALE_MP_MAX = 4;
export const INFERENCE_SCALE_MP_STEP = 0.1;

export function inferenceScaleMegapixels(scale) {
    return Math.min(INFERENCE_SCALE_MP_MAX, Math.max(INFERENCE_SCALE_MP_MIN, Math.round((Number(scale) || 1) ** 2 * 10) / 10));
}

export function inferenceScaleFromMegapixels(value) {
    const mp = Math.min(INFERENCE_SCALE_MP_MAX, Math.max(INFERENCE_SCALE_MP_MIN, Math.round((Number(value) || 1) * 10) / 10));
    // VNCCS keeps the legacy 1344 and 1536 area presets; storage remains a side multiplier.
    return Math.sqrt(mp === 1.3 ? 1344 / 1024 : mp);
}

// Parses typed text ("1,5" and "1.5" both work); null when it is not a usable number.
export function parseInferenceScale(text, standalone = false) {
    const value = Number(String(text ?? "").trim().replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) return null;
    if (standalone) return inferenceScaleFromMegapixels(value);
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
    const originalScale = widget.settings.inference_scale;
    input.value = widget.standalone ? inferenceScaleMegapixels(originalScale).toFixed(1) : String(Number(originalScale) || 1);
    input.title = widget.standalone ? "Inference scale in megapixels: 1–4 MP, step 0.1. Enter applies, Esc cancels." : "Scale relative to the Generation box: 1 = box size, 1.5 = one and a half times. Enter applies, Esc cancels.";
    input.setAttribute("aria-label", "Inference scale");
    label.dataset.editing = "1";
    label.hidden = true;
    label.after(input);
    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        const value = commit ? parseInferenceScale(input.value, widget.standalone) : null;
        input.remove();
        label.hidden = false;
        delete label.dataset.editing;
        if (value === null) {
            if (widget.standalone && widget.settings.inference_scale !== originalScale) {
                widget.settings.inference_scale = originalScale;
                widget.syncInferenceControls();
                widget.requestRender?.();
            }
            return;
        }
        widget.settings.inference_scale = value;
        widget.syncInferenceControls();
        widget.syncSettingsToWidget();
    };
    input.addEventListener("input", () => {
        if (!widget.standalone) return;
        const value = parseInferenceScale(input.value, true);
        if (value === null) return;
        widget.settings.inference_scale = value;
        widget.syncInferenceControls();
        widget.requestRender?.();
    });
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
