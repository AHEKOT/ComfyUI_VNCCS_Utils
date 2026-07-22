import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";


const source = await readFile(new URL("../web/vnccs_img2threejs_studio.js", import.meta.url), "utf8");


function method(name, nextName) {
    const start = source.indexOf(`\n    ${name}(`);
    const end = nextName ? source.indexOf(`\n    ${nextName}(`, start + 1) : source.length;
    assert.ok(start >= 0 && end > start, `method ${name} must exist`);
    return source.slice(start, end);
}


test("workflow state persists useful provider settings but never credentials", () => {
    const fieldsStart = source.indexOf("const PUBLIC_PROVIDER_FIELDS");
    const fieldsEnd = source.indexOf("const DEFAULT_REQUEST", fieldsStart);
    const fields = source.slice(fieldsStart, fieldsEnd);
    assert.match(fields, /base_url/);
    assert.match(fields, /mmproj/);
    assert.doesNotMatch(fields, /vision_handler/);
    assert.doesNotMatch(fields, /api_key/);

    const serialize = method("serializeState", "syncToNode");
    assert.match(serialize, /publicProviderConfig/);
    assert.doesNotMatch(serialize, /api_key/);
    assert.doesNotMatch(source, /(?:local|session)Storage\s*\./);
});


test("visual refinement requires an actual rendered preview", () => {
    const refine = method("async refine", "async _capturePreviewBlob");
    const submit = method("async _submitPipeline", "_beginJob");
    assert.match(refine, /!this\.hasScene \|\| !this\.viewer/);
    assert.match(submit, /if \(!preview\)/);
    assert.match(submit, /form\.append\("preview"/);
});


test("job cancellation keeps the active id until server confirmation", () => {
    const cancel = method("async cancelJob", "async restoreProject");
    const beforeRequest = cancel.slice(0, cancel.indexOf("await this._fetchJSON"));
    assert.doesNotMatch(beforeRequest, /this\.currentJobId\s*=\s*""/);
    assert.match(cancel, /this\._finishJob\("Cancelled"/);
    assert.match(cancel, /this\._pollJob\(jobId, token\)/);
});


test("studio UI only advertises outputs the vendored v1.2 forge can produce", () => {
    assert.doesNotMatch(source, />\s*GLB package\s*</i);
    assert.doesNotMatch(source, /value:\s*"qwen2_vl"/);
    assert.match(source, /output_format:\s*"both"/);
    assert.match(source, /component\.childrenIds \|\| component\.children/);
});


test("CLI provider modal shows server-side executable discovery", () => {
    const fields = method("_renderProviderFields", "_modelsFromCapabilities");
    assert.match(fields, /capability\.executable/);
    assert.match(fields, /capability\.discovery/);
    assert.match(fields, /Detected by ComfyUI/);
    assert.match(fields, /capability\?\.reason/);
});


test("provider failures remain visible in a graphical diagnostics modal", () => {
    const modal = method("_showFailureModal", "_scheduleSave");
    assert.match(modal, /Generation failed/);
    assert.match(modal, /Copy diagnostics/);
    assert.match(modal, /Download full log/);
    assert.match(modal, /diagnosticsOpen\.hidden = false/);
    assert.match(modal, /console\.error/);
    const poll = method("async _pollJob", "_finishJob");
    assert.match(poll, /_showFailureModal/);
});


test("local GGUF modal reports the shared ComfyUI model catalog", () => {
    const fields = method("_renderProviderFields", "_modelsFromCapabilities");
    assert.match(fields, /capability\.model_count/);
    assert.match(fields, /capability\.mmproj_count/);
    assert.match(fields, /native llama\.cpp\/libmtmd/);
    assert.match(fields, /model-family whitelist/);
    assert.doesNotMatch(fields, /Qwen 2\.5 VL|LLaVA 1\.5|vision_handler/);
    const refresh = method("async _refreshProviderModels", "async _uploadLocalModel");
    assert.match(refresh, /_customSelectController\?\.refresh/);
});
