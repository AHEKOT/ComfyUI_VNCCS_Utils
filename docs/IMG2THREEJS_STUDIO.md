# VNCCS img2threejs Studio

VNCCS img2threejs Studio turns one reference image into a procedural Three.js
model without leaving the ComfyUI graph. It embeds the upstream
[`hoainho/img2threejs`](https://github.com/hoainho/img2threejs) v1.2.0 skill and
forge pipeline, adds model-provider adapters, and presents the result in a safe
interactive Three.js viewport.

This is reconstruction-by-code. It is not photogrammetry and does not infer a
hidden, exact mesh from one photograph. Unseen sides are approximations. The
upstream v1.2.0 pipeline produces an ObjectSculptSpec and TypeScript factory; it
does not currently export GLB, glTF, OBJ, or FBX.

## Node outputs

The node exposes four outputs:

1. `preview` (`IMAGE`) — the last viewport render saved by the widget.
2. `threejs_source` (`STRING`) — the generated TypeScript `THREE.Group`
   factory.
3. `sculpt_spec` (`STRING`) — the complete ObjectSculptSpec JSON.
4. `project_path` (`STRING`) — the server-side project directory containing the
   reference, safe scene spec, upstream spec, source, preview, and metadata.

Large artifacts and reference images are not embedded in the ComfyUI workflow.
The hidden widget state stores a compact project identifier and non-secret UI
settings only.

## Typical workflow

1. Add **VNCCS img2threejs Studio** from `VNCCS/3D`.
2. Drop or choose one PNG, JPEG, or WebP reference. The backend
   normalizes it to an 8-bit RGB PNG before invoking the upstream forge.
3. Open **Provider settings** and configure one provider.
4. Choose the intended use and fidelity target, add only instructions that are
   specific to this asset, and select **Generate model**.
5. Inspect the component hierarchy and orbit the 3D viewport.
6. Use **AI refine** to send the reference and the current viewport screenshot
   through the img2threejs visual review loop. State the concrete mismatch to
   fix, such as silhouette, proportions, attachment, or material response.
7. Download the scene JSON, ObjectSculptSpec, or TypeScript from the graphical
   output panel, or execute the ComfyUI workflow to receive the four outputs.

The viewport never evaluates generated source. Providers return a constrained
JSON scene, the backend validates and clamps it, and a fixed primitive renderer
builds the preview. The TypeScript artifact is generated deterministically from
the normalized ObjectSculptSpec by the vendored forge.

## Providers

| Provider | Authentication | Notes |
| --- | --- | --- |
| Codex CLI | Existing local Codex login | Runs non-interactively with the reference attached, an ephemeral session, a read-only sandbox, and backend validation of the returned JSON. |
| Claude | Anthropic API key or existing Claude CLI login | API mode uses Messages vision with structured JSON output. CLI mode is restricted to non-mutating analysis. |
| OpenAI | `OPENAI_API_KEY` or a key entered in the provider modal | Uses the Responses API with image input and a JSON-schema response format, followed by backend normalization. |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` or a key entered in the provider modal | Uses the Azure v1 Responses endpoint; configure the deployment in the modal or with `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_DEPLOYMENT`. |
| Local GGUF | No remote credential | Uses a current native `llama-server`/`libmtmd` build with a multimodal GGUF and its matching mmproj. |

CLI availability is resolved by the ComfyUI backend, not the browser. On
Windows, Studio checks the server process `PATH`, explicit `codex.exe`, the
standard per-user npm installation, and Codex binaries bundled with VS Code or
Cursor extensions. The provider modal shows how the executable was detected.
For a non-standard installation, set `VNCCS_CODEX_CLI` to the absolute
`codex.exe` path before starting ComfyUI. `VNCCS_CLAUDE_CLI` provides the same
server-side override for Claude CLI. Executable paths are deliberately not
accepted from workflow JSON or browser input.

If a CLI exits unsuccessfully or returns malformed JSON, Studio preserves a
redacted diagnostic tail in the job and project metadata, writes the failure
through the ComfyUI logger, and retains a bounded `provider.log` artifact with
the engine, version, command, exit code, stderr, stdout, and pipeline traceback.
The graphical modal remains open until dismissed, can copy the diagnostic text
or download the full log, and leaves a persistent **Diagnostics** action in the
Studio top bar. Temporary raw CLI files are removed only after the retained log
has been written.

Keys entered in the modal are kept only in the widget's memory and the active
request. They are not cached by the backend or written to disk, `studio_data`,
workflow JSON, or browser storage. Reloading the page clears them. Environment
variables are the recommended option for persistent configuration. Provider
status responses expose only `configured: true/false`; keys are never returned
to the browser.

Model names change independently of this extension. Every remote provider
therefore has an editable model/deployment field rather than a hard-coded
closed list. OpenAI and Anthropic default to their official hosts; additional
public hosts must be explicitly approved by the ComfyUI operator through the
`VNCCS_IMG2THREEJS_ENDPOINT_HOSTS` environment variable. Azure accepts its
official OpenAI and Azure AI service hostnames.

## Local GGUF setup

Install a current native
[`llama.cpp`](https://github.com/ggml-org/llama.cpp) build. Studio searches the
ComfyUI server process `PATH`, `ComfyUI_VNCCS_Utils/bin`, conventional
`llama.cpp/build/bin` locations, and the explicit `VNCCS_LLAMA_SERVER`
environment variable. On Windows the override must point to
`llama-server.exe`, for example before starting ComfyUI:

```powershell
$env:VNCCS_LLAMA_SERVER = "C:\Tools\llama.cpp\llama-server.exe"
```

The provider modal displays the detected executable, discovery method, and
engine version. Architecture and chat-template selection belong to the
installed native `libmtmd` build and the GGUF metadata; Studio has no
Qwen/LLaVA/model-family whitelist. Consequently Qwen3.5 and other current
multimodal families work when that exact llama.cpp build supports them and the
selected mmproj matches the model.

The selector reads the shared ComfyUI LLM catalog recursively, including
registered `LLM`, `llm`, and `language_models` folders. The conventional layout
is:

```text
ComfyUI/models/LLM/<model family>/<vision-model>.gguf
ComfyUI/models/LLM/<model family>/mmproj-*.gguf
```

Files imported through the modal remain in the Studio-managed
`ComfyUI/models/LLM/img2threejs/` directory. Shared models are referenced in
place and are not copied. Browser state receives opaque catalog identifiers,
not absolute server paths. Uploads are streamed to a partial file, validated as
GGUF, and atomically renamed. The model and mmproj must belong to the same
architecture and model family; llama.cpp reports a precise load error in the
retained provider log when they do not match.

Local inference settings are bounded by the backend. A larger context improves
room for detailed specs but increases memory use. `GPU layers = -1` requests
maximum supported offload; use `0` for CPU-only fallback. Local GGUF jobs are
serialized to avoid loading multiple multimodal models into RAM/VRAM at once.

## Generation and review pipeline

The prompt published on
[`skillsllm.com/skill/img2threejs`](https://skillsllm.com/skill/img2threejs) is
vendored as `img2threejs/SKILL.md` and loaded verbatim. The service adds a small
transport-specific structured-output contract and then follows the upstream
stages:

```text
reference image
  -> suitability and complexity assessment
  -> detail inventory / component and material scene
  -> normalized Scene Spec and bounded ObjectSculptSpec
  -> upstream pass selection and TypeScript generation
  -> safe browser preview
  -> reference + render visual review
  -> corrected spec
```

The extension clamps the browser-facing Scene Spec and component limits, then
uses the upstream pass selector and generator for the TypeScript artifact. All
accepted components are explicitly included in that exported pass. The
selected vision model performs the visual judgment and the requested
`self_review_cycles` happen inside that provider response; an explicit **AI
refine** starts a new request with the current viewport render. A low-fidelity
or ambiguous image can legitimately result in a conditional/rejected
suitability verdict. A single-image workflow cannot recover exact hidden
geometry.

## Project storage

Projects are written below the ComfyUI output directory when it is available.
Each project uses an opaque identifier and contains only paths confined to that
project. Routes never accept arbitrary local filesystem paths.

Typical artifacts are:

```text
reference.png
scene.json
object-sculpt-spec.json
model.ts
preview.png
metadata.json
```

Removing a node does not immediately delete its project. This keeps recent
workflows reproducible and makes generated source available after a browser
restart. Automatic housekeeping bounds storage to 256 projects and 20 GiB and
may remove projects older than 180 days, starting with the oldest inactive
projects.

## Security and privacy

- Generated TypeScript is delivered as an artifact and is never run by the
  widget.
- Image, prompt, and screenshot sizes are bounded before decoding or forwarding.
- Scene identifiers, parent links, numeric transforms, colors, and component
  counts are normalized; cyclic hierarchies are rejected.
- Forge and CLI processes use argument arrays with `shell=False`.
- Codex is launched read-only and ephemerally for this task.
- Agent CLI subprocesses receive a reduced environment and run from the opaque
  project directory. They still have the host read access granted to the CLI
  process itself; use an API provider or Local GGUF for untrusted references.
- Long-running provider calls use isolated job IDs, progress, cancellation, and
  stale-result checks.
- Remote providers receive the reference image and prompt. Use Local GGUF when
  the image must remain on the ComfyUI host.

## Upstream and license

The `img2threejs/` directory is vendored from commit
`e8ff28a6ae0cb534c7b2ebc15cb3f06709262d5b`. The upstream MIT license and
copyright notice are preserved in `img2threejs/LICENSE`; provenance is recorded
in `img2threejs/UPSTREAM_COMMIT`.
