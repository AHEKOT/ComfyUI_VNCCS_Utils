# Adding a model to UniCanvas - playbook for AI agents

Use this when a user asks to "add model X to UniCanvas" (a new model family, a new
checkpoint of an existing family, a new LoRA rule, or a new task such as video).
Goal: gather every fact **once, up front**, then implement without guessing.

Read first: `CLAUDE.md` (layering, testing gotchas), `docs/UNICANVAS_MODEL_MODULES.md`
(extension points) and one similar existing family in `nodes/unicanvas/models/`.

## 0. Decide what is being added

| The user wants | Usually means |
| --- | --- |
| A new checkpoint of a family we have (another SDXL merge, a new Qwen Edit GGUF) | A **preset** in `config/unicanvas_presets.json` only. No code. |
| A LoRA that must (or may) be applied for a family | A `LoraRequirement` on that family. |
| A model with a new architecture / text encoder / conditioning | A new **family** module. |
| A new kind of output (video, 3D, panorama view) | A new **task**, often a new **draw pipeline** (see section 4). |

If you cannot tell which row applies, ask - it decides everything else.

## 1. Questions to ask the user

Ask all of these in one message. Mark what you already found yourself (model card,
ComfyUI docs) and ask the user to confirm instead of asking blind. Never invent
defaults - an unknown value is a question, not a guess.

**Identity and files**
1. Model name and a short key (`snake_case`, e.g. `wan_video`), plus aliases users may type.
2. Where do the weights come from? Hugging Face repo + file path + a pinned revision (commit
   SHA) for each file: diffusion model / checkpoint / GGUF, text encoder (CLIP), VAE, extra
   patches. Licence of each.
3. Which ComfyUI version or custom node provides the loader and inference nodes? Are they
   core nodes (`UNETLoader`, `CLIPLoader`, `VAELoader` ...) or does the user need to install a
   node pack? (Node class names matter - we call them by name.)

**Loading**
4. Loader type: `checkpoint` (one file), `diffusion_model` (model + CLIP + VAE), `gguf`, or
   `external` (supplied by a VNCSS Config node in the graph)?
5. CLIP type string for `CLIPLoader` (e.g. `qwen_image`, `lumina2`, `flux2`) and any special
   loader arguments.

**Generation**
6. Role: **generator** (creates from a prompt) or **edit** model (transforms the canvas and
   reference images)?
7. Which tasks does it support *now* and which later? Pick from the standard list in
   `models/capabilities.py` (`text_to_image`, `image_to_image`, `inpaint`, `outpaint`,
   `text_to_video`, `image_to_video`, `reference_to_video`, `video_to_video`, `text_to_3d`,
   `image_to_3d`, `panorama_view`) or name a new one.
8. What inputs does it read: prompt only, the canvas image, reference images (how many, and
   how does the prompt name them - `Picture {n}`, `<image{n}>`, `<Picture {n}>`?), video, audio?
9. Default sampling: sampler, scheduler, steps, CFG, denoise, shift or other model-sampling
   patches, recommended resolution / aspect presets / megapixel limit.
10. Inpaint and outpaint: does the model have a native way (mask conditioning, inpaint patch,
    ControlNet) or should UniCanvas use img2img + mask paste-back? Is the negative prompt used?
11. Does it need a connected VNCSS Config node, or a source image inside the bbox? Does it
    support Pose Studio layers? Can it remove backgrounds (RGBA output)?

**LoRAs**
12. Turbo / distillation LoRA: file, which setting switches it, strength, whether it changes
    steps/CFG. Mandatory adapters (applied always, fixed strength, never twice)? LoRAs only for
    some draw modes?

**Prompt help**
13. Link to the official or author prompting guide (model card, README, docs). One per task if
    prompting differs (e.g. image edit vs video). If there is none, ask the user which
    community guide to trust - the prompt help must cite its sources.

## 2. Implement (TDD: write the test first, see it fail, then the code)

1. **Test** - add to `tests/test_unicanvas_capabilities.py` (and
   `tests/test_unicanvas_lora_requirements.py` for LoRAs) what the family must declare: tasks,
   references, requirements, default loader, prompt guide with sources, LoRA rules.
2. **Family module** `nodes/unicanvas/models/<key>.py`:
   - `<KEY>_DEFAULTS` (every sampling default from question 9, `generation_mode`, loader,
     file names);
   - a `@dataclass(frozen=True)` subclass of `UniCanvasModelModule` with
     `capabilities = ModelCapabilities(...)` (label, tasks, references, requirements,
     `default_loader`, `prompt_guide=PromptGuide(hint, guide, examples, negative_prompt,
     sources)`; per-task guides via `STANDARD_TASKS[key].with_prompt_guide(...)`,
     not-yet-wired tasks via `.planned()`);
   - `lora_requirements = (LoraRequirement(...),)` - never override `apply_loras`;
   - override only the primitives/hooks that differ (`encode_prompt`,
     `prepare_reference_conditioning`, `create_empty_latent`, `sample_latent`,
     `decode_samples`, `prepare_generation_latent`, `prepare_masked_latent`,
     `prepare_model_for_sampling`, ...). Stash per-draw objects in `ctx.settings["_<key>_..."]`
     and list those keys in `sampling_scratch_keys`.
   - Call ComfyUI nodes through `comfy_bridge._call_node_method` / `_call_comfy_node`, never
     import custom-node packages at module import time.
3. **Register** it in `nodes/unicanvas/models/__init__.py`.
4. **Frontend registry** (still manual): add the family to `UNICANVAS_MODEL_MODULES` in
   `web/vnccs_unicanvas.js` (or its own `web/vnccs_unicanvas_<key>.mjs`, like Qwen-Image-2.1)
   with `label`, `aliases`, `base`, `isEditModel`, `detect` keywords (file-name matching) and the
   same defaults. Prompt help needs no frontend change - it comes from the backend descriptor.
5. **Preset** (optional but usual): an entry in `config/unicanvas_presets.json` with pinned
   `hf_repo` / `hf_path` / `hf_revision` / `local_path` assets and, for turbo, the `turbo` block.
6. **Docs**: a short section in `README.md` and, for anything unusual, `docs/UNICANVAS_<KEY>.md`.

Never add `if model_module.key == "<key>"` (or family names) to `draw.py`, `draw_request.py`,
`draw_pipeline.py`, `generation.py`, `latents.py`, `sampling.py` or `loras.py`:
`tests/test_unicanvas_draw_pipeline.py` fails on it. If the shared path lacks a hook you need,
add a hook with a generic default to `UniCanvasModelModule` and call it from the pipeline.

## 3. Verify

```bash
python scripts/security_scan.py
python -m pytest tests -q -p no:cacheprovider
node --test tests/*.mjs
```

Then, on a running test platform (see `AGENTS.md`), `tests/e2e` - at least `smoke.spec.mjs`
and `prompt-guide.spec.mjs`. GPU inference is only verifiable on Lane B; say so explicitly
when you could not run the model itself.

## 4. New output kinds (video, 3D, panorama views)

Declare the task first (`available=False` via `.planned()`) so the UI can show it as coming.
When implementing it, subclass `draw_pipeline.ImageDrawPipeline` (or write a pipeline with the
same `run()` contract) in the family module, set `draw_pipeline_class`, and replace the stages
that differ (a video pipeline returns frames instead of saving one image per batch item). Flip
the task to available only when the pipeline and the widget can both handle its output.

## 5. Report back to the user

List what was added (files, preset, LoRA rules, tasks), which answers came from sources vs the
user, what was verified (tests, E2E, GPU or not), and every open question.
