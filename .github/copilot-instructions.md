# VNCCS Utils Development Guide

Guidance for coding agents working in this repository. `AGENTS.md` carries the binding
project rules (realtime interaction, E2E suite, Docker test platform, evidence policy);
`CLAUDE.md` mirrors this guidance for Claude Code. The roadmap lives in GitHub Issues.

## What this is

A ComfyUI custom-node extension (VNCCS Utils): **UniCanvas** (in-node infinite-canvas editor
with direct generation), **Pose Studio**, **3D Factory**, VNCSS
Config, BBox Extractor and helpers. The Python backend runs inside ComfyUI; the frontend is
plain ES modules in `web/` — no bundler, no build step.

## Commands

```bash
python scripts/security_scan.py                     # mandatory, CI fails on any finding
python -m pytest tests -q -p no:cacheprovider       # Python unit tests (needs torch locally)
node --test tests/*.mjs                             # JS unit tests (Node 20+)
# CI style: every Python test file as a script, only numpy + Pillow installed
for f in tests/*.py; do [ "$f" != tests/test_security_scan.py ] && PYTHONPATH=. python "$f"; done
```

Single test: `python -m pytest tests/test_unicanvas_h3.py -q -k external` or
`node --test tests/test_unicanvas_pose.mjs`. E2E (Playwright, needs a running test platform)
is described in `AGENTS.md`.

## Repository layout

- `__init__.py` — extension entry point: node mappings, `WEB_DIRECTORY`, Pose Studio and
  UniCanvas state-cache routes, calls `register_unicanvas_routes()`.
- `nodes/` — node classes: `pose_studio.py`, `factory3d*.py`, `vncss_config.py`,
  `vnccs_bbox_extractor.py` and `anima_lllite_internal.py`;
  `nodes/unicanvas/` is the UniCanvas package (below).
- `api/` — 3D Factory and Pose Studio backend services.
- `web/` — five `vnccs_*.js` extension entry points in the root. Feature modules live in
  `unicanvas/`, `pose_studio/`, `factory3d/`, `camera_control/`, and `config/`.
  Common controls and assets live in `shared/`; third-party libraries live in `vendor/`.
  Pose Studio keeps its morph pack in `pose_studio/assets/` and skin textures in
  `pose_studio/textures/`.
- `config/unicanvas_presets.json` — model presets (pinned HF repo/path/revision).
- `vnccs_sam3d/` — vendored SAM-3D / BiRefNet code.
- `tests/` — `conftest.py` stubs `comfy`, `folder_paths`, `server` and points the bare
  `nodes` package at `nodes/`; `tests/helpers/` has shared helpers; `tests/e2e/` is Playwright.
- `docs/` — user and developer docs; `docs/UNICANVAS_MODEL_MODULES.md` explains model
  loaders/families, `docs/agents/ADDING_A_MODEL.md` the new-family checklist.

## UniCanvas backend (`nodes/unicanvas/`)

Layered; lower layers never import higher ones (no import cycles):

1. Infrastructure: `constants`, `locks`, `debug`, `paths`, `progress`
2. Images/state: `imaging`, `masking`, `state`, `render`
3. ComfyUI integration: `comfy_bridge`, `pipeline`, `loras` (`LoraRequirement`), `loaders`,
   `latents`, `sampling`, `draw_pipeline` (`ImageDrawPipeline`, `DrawContext`)
4. Model families: `models/` — `capabilities` (tasks, media kinds, reference slots, prompt
   guides), `base.UniCanvasModelModule` (data + hooks), `registry`, one module per family
   (`sdxl`, `anima`, `flux_klein`, `qwen_image_edit`, `qwen_image21`, `z_image`,
   `minimax_h3`, `krea2_edit` + vendored `krea2_edit_inference`). Registration happens only
   in `models/__init__.py`.
5. Features: `presets`, `assets`, `generation`, `draw_request`, `draw`, `segment`,
   `save_output`, `remove_bg`, `color_match`
6. Entry points: `node` (`VNCCS_UniCanvas`), `routes` (all `/vnccs/unicanvas/*` endpoints)

The package `__init__` re-exports only `VNCCS_UniCanvas`, `register_unicanvas_routes`, the
node mappings and `_COMFY_MODEL_OP_LOCK` (shared with `api/factory3d.py` through
`sys.modules`). Import everything else from the owning submodule.

Draw flow: `draw._run_unicanvas_draw` -> `DrawRequest.from_payload` -> `family.validate_request`
-> `family.draw_pipeline_class or ImageDrawPipeline` -> staged `run()` calling family hooks.

## Conventions

- **New model family / LoRA / task**: follow `docs/agents/ADDING_A_MODEL.md` and
  `docs/UNICANVAS_MODEL_MODULES.md`. In short: new `models/<family>.py` with defaults,
  `capabilities` (tasks, references, requirements, `PromptGuide` with `sources`) and
  `lora_requirements`; override only the hooks that differ; register in `models/__init__.py`;
  mirror it in the frontend family registry in `web/vnccs_unicanvas.js`.
- **Never** branch on family keys in the shared draw code (`draw*.py`, `generation.py`,
  `latents.py`, `sampling.py`, `loras.py`) — a guard test fails. Add a hook with a generic
  default to `UniCanvasModelModule` instead. Never override `apply_loras`; declare a
  `LoraRequirement`.
- Blend modes, panorama projections, background removers and color transfers are registries
  (`register_blend_mode`, `register_panorama_projection`, `register_background_remover`,
  `register_color_transfer`) — extend them, do not add `if` chains.
- **New route/feature**: logic in its own module, registration in `routes.py`; heavy work via
  `asyncio.to_thread`, errors as `{"error": ...}` with a non-2xx status, request size checked
  with `_content_length_ok`.
- No import-time side effects (threads, route registration, downloads). Model downloads are
  lazy and go through `huggingface_hub` with `token=False`.
- Paths to repo files use `paths._EXTENSION_ROOT`, not `__file__` math. Model work
  (load/sample/decode) must hold `locks._COMFY_MODEL_OP_LOCK`.
- Frontend: new UniCanvas features go in their own `web/unicanvas/<feature>.mjs`
  module, hooked from `vnccs_unicanvas.js`; respect the realtime interaction contract in
  `AGENTS.md` (continuous feedback during gestures, commit-only on release).

## Testing gotchas

- **Monkeypatch where the name is used, not on the package**: e.g.
  `monkeypatch.setattr("nodes.unicanvas.models.minimax_h3._call_comfy_node", ...)`,
  `patch.object(nodes.unicanvas.loras, "_apply_lora_cached", ...)` (all LoRA loading goes
  through `loras`). Family behaviour is easiest to test by registering a small test family
  (`monkeypatch.setitem(UNICANVAS_MODEL_MODULES, key, family)`) — see
  `tests/test_unicanvas_draw_pipeline.py`.
- Suites that must run without torch load the package via
  `tests/helpers/unicanvas_package.py::load_unicanvas_package(<private name>, torch_module=stub)`
  and reach submodules as attributes (`pkg.render`, `pkg.models.registry`). Keep module-level
  code free of real torch calls (lazy `from __future__ import annotations`).
- CI installs only numpy + Pillow and runs each `tests/*.py` as a script; torch-dependent
  files fail there by design, but do not make a currently passing file depend on torch.

## Security rules

`scripts/security_scan.py` scans all `.py/.js/.mjs/.json/.toml` (tests included) and CI fails
on any finding. It forbids, among others: `importlib.import_module`, `exec`/`eval`,
`subprocess`, `os.environ`/`getenv`, `tempfile.gettempdir()`, network clients (`requests`,
`urllib.request`, `http.client`, aiohttp `ClientSession`), HF credential markers and external
network calls in JS. Use `importlib.util.spec_from_file_location` in tests and ComfyUI's
`folder_paths` temp dir.

## Workflow notes

- Bump nothing in `pyproject.toml` unless releasing (the publish workflow triggers on it).
- UI changes need an **After** capture only (`node evidence.mjs --topic <topic> --phase after`,
  workdir `tests/e2e`; details in `AGENTS.md`).
- After frontend changes on a live instance, hard-reload (Ctrl+Shift+R).
