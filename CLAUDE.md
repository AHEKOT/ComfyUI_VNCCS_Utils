# CLAUDE.md

Guidance for Claude Code in this repository. The binding project rules (realtime
interaction, E2E suite, Docker test platform, evidence policy) live in `AGENTS.md`:

@AGENTS.md

## What this is

A ComfyUI custom-node extension (VNCCS Utils): **UniCanvas** (in-node canvas editor with
direct generation), **Pose Studio**, **3D Factory**, Model Manager/Selector, VNCSS Config,
QWEN Detailer and helpers. Python backend runs inside ComfyUI; the frontend is plain ES
modules in `web/` (no bundler, no build step). `.github/copilot-instructions.md` carries the
same guidance for GitHub Copilot.

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

## Layout

- `__init__.py` - extension entry point: node mappings, `WEB_DIRECTORY`, Pose Studio and
  UniCanvas state-cache routes, calls `register_unicanvas_routes()`.
- `nodes/` - node classes. `nodes/unicanvas/` is a package (below); `pose_studio.py`,
  `factory3d*.py`, `vncss_config.py`, `vnccs_model_manager.py`, `vnccs_qwen_detailer.py`,
  and `anima_lllite_internal.py`.
- `api/` - 3D Factory and Pose Studio backend services.
- `web/` - frontend widgets. UniCanvas: `vnccs_unicanvas.js` (main widget, very large - add
  feature code in a `vnccs_unicanvas_<feature>.mjs` module and only hook it from the widget).
- `config/unicanvas_presets.json` - model presets (pinned HF repo/path/revision).
- `vnccs_sam3d/` - vendored SAM-3D / BiRefNet code.
- `tests/` - `conftest.py` stubs `comfy`, `folder_paths`, `server` and points the bare
  `nodes` package at `nodes/`; `tests/helpers/` has shared helpers; `tests/e2e/` is Playwright.
- `docs/` - feature docs (`UNICANVAS_MODEL_MODULES.md` explains model loaders/families);
  the forward roadmap lives in GitHub Issues.

## UniCanvas backend (`nodes/unicanvas/`)

Layered; lower layers never import higher ones (keep it that way - no import cycles):

1. Infrastructure: `constants`, `locks`, `debug`, `paths`, `progress`
2. Images/state: `imaging`, `masking`, `state`, `render`
3. ComfyUI integration: `comfy_bridge`, `pipeline`, `loras` (`LoraRequirement`), `loaders`,
   `latents`, `sampling`, `draw_pipeline` (`ImageDrawPipeline`, `DrawContext`)
4. Model families: `models/` - `capabilities` (tasks, media kinds, reference slots, prompt
   guides), `base.UniCanvasModelModule` (data + hooks), `registry`, one module per family
   (`sdxl`, `anima`, `flux_klein`, `qwen_image_edit`, `qwen_image21`, `z_image`,
   `minimax_h3`, `krea2_edit` + vendored `krea2_edit_inference`). Registration happens only in
   `models/__init__.py`.
5. Features: `presets`, `assets`, `generation`, `draw_request`, `draw`, `segment`,
   `save_output`, `remove_bg`, `color_match`
6. Entry points: `node` (`VNCCS_UniCanvas`), `routes` (all `/vnccs/unicanvas/*` endpoints)

The package `__init__` re-exports only `VNCCS_UniCanvas`, `register_unicanvas_routes`, the
node mappings and `_COMFY_MODEL_OP_LOCK` (shared with `api/factory3d.py` through
`sys.modules`). Import everything else from the owning submodule.

Draw flow: `draw._run_unicanvas_draw` -> `DrawRequest.from_payload` -> `family.validate_request`
-> `family.draw_pipeline_class or ImageDrawPipeline` -> staged `run()` calling family hooks.

Conventions:
- **New model family / LoRA / task**: follow `docs/agents/ADDING_A_MODEL.md` (it lists the
  questions to ask the user first) and `docs/UNICANVAS_MODEL_MODULES.md`. In short: new
  `models/<family>.py` with defaults, `capabilities` (tasks, references, requirements,
  `PromptGuide` with `sources`) and `lora_requirements`; override only the hooks that differ;
  register in `models/__init__.py`; mirror it in the frontend registry (`web/vnccs_unicanvas.js`).
- **Never** branch on family keys in the shared draw code (`draw*.py`, `generation.py`,
  `latents.py`, `sampling.py`, `loras.py`) - a guard test fails. Add a hook with a generic
  default to `UniCanvasModelModule` instead. Never override `apply_loras`; declare a
  `LoraRequirement`.
- Blend modes, panorama projections, background removers and color transfers are registries
  (`register_blend_mode`, `register_panorama_projection`, `register_background_remover`,
  `register_color_transfer`) - extend them, do not add `if` chains.
- **New route/feature**: logic in its own module, registration in `routes.py`; heavy work via
  `asyncio.to_thread`, errors as `{"error": ...}` with a non-2xx status, request size checked
  with `_content_length_ok`.
- No import-time side effects (threads, route registration, downloads). Model downloads are
  lazy and go through `huggingface_hub` with `token=False`.
- Relative imports that leave the package: `...vncss_config` from `models/`, `...vnccs_sam3d`
  from package modules. Paths to repo files use `paths._EXTENSION_ROOT`, not `__file__` math.
- Model work (load/sample/decode) must hold `locks._COMFY_MODEL_OP_LOCK`.

## Testing gotchas

- **Monkeypatch where the name is used, not on the package**: e.g.
  `monkeypatch.setattr("nodes.unicanvas.models.minimax_h3._call_comfy_node", ...)`,
  `monkeypatch.setattr("nodes.unicanvas.draw_pipeline._load_generation_assets", ...)`,
  `patch.object(nodes.unicanvas.loras, "_apply_lora_cached", ...)` (all LoRA loading goes
  through `loras`). Family behaviour is easiest to test by registering a small test family
  (`monkeypatch.setitem(UNICANVAS_MODEL_MODULES, key, family)`) - see
  `tests/test_unicanvas_draw_pipeline.py`.
- Suites that must run without torch load the package via
  `tests/helpers/unicanvas_package.py::load_unicanvas_package(<private name>, torch_module=stub)`
  and reach submodules as attributes (`pkg.render`, `pkg.models.registry`). Keep module-level
  code free of real torch calls (annotations are lazy via `from __future__ import annotations`).
- CI installs only numpy + Pillow and runs each `tests/*.py` as a script; torch-dependent
  files fail there by design, but do not make a currently passing file depend on torch.
- `scripts/security_scan.py` scans all `.py/.js/.mjs/.json/.toml` (tests included) and forbids
  e.g. `importlib.import_module`, exec/eval, `subprocess`, `os.environ`/`getenv`,
  `tempfile.gettempdir()`, network clients (`requests`, `urllib.request`, `http.client`,
  aiohttp `ClientSession`), HF credential markers and external network calls in JS. Use
  `importlib.util.spec_from_file_location` in tests and ComfyUI's `folder_paths` temp dir.

## Workflow notes

- Bump nothing in `pyproject.toml` unless releasing (the publish workflow triggers on it).
- UI changes need an After capture only (`node evidence.mjs --topic <topic> --phase after`, see
  `AGENTS.md`); no Before captures or pairs.
- After frontend changes on a live instance, hard-reload (Ctrl+Shift+R).
