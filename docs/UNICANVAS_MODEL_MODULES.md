# UniCanvas Model Modules

UniCanvas generates inside its widget, before normal ComfyUI graph connections
can provide model objects. Model support is therefore split into two concepts:

- **Loader**: how `model`, `clip`, and `vae` are loaded.
- **Inference module**: how prompts, reference images, latents, samplers, and
  decoding are wired for one model family.

This split keeps model files independent from the inference graph. For example,
`Diffusion Model` can load both Anima and Flux Klein, while `Checkpoint` always
forces SDXL.

AI agents asked to add a model: follow `docs/agents/ADDING_A_MODEL.md`, which lists
the questions to ask the user before writing any code.

## Extension Points At A Glance

A family is extended in three ways, from the lightest to the heaviest:

1. **Data** - `defaults`, `capabilities` (tasks, accepted inputs, reference slots,
   requirements, prompt guide) and `lora_requirements`.
2. **Hooks** - methods on `UniCanvasModelModule` that the default draw pipeline
   calls with the shared `DrawContext` (`validate_request`, `validate_source`,
   `prepare_pose_edit`, `prepare_draw_assets`, `preload_vae` / `release_vae`,
   `bind_draw_assets`, `encode_draw_prompts`, `on_mask_prepared`,
   `on_masked_mode_dropped`, `prepare_masked_inputs`, `prepare_generation_latent`,
   `prepare_masked_latent`, `after_latent_prepared`, `prepare_model_for_sampling`,
   `normalize_settings`), plus the model primitives (`encode_prompt`,
   `prepare_reference_conditioning`, `create_empty_latent`, `sample_latent`,
   `decode_samples`, ...). Every hook has a generic default.
3. **A whole draw path** - `draw_pipeline_class` names a subclass of
   `draw_pipeline.ImageDrawPipeline` (or a class with the same `run()` contract).
   Video, 3D or panorama-view families replace entire stages there.

Shared draw code never names a family: `tests/test_unicanvas_draw_pipeline.py`
fails if `draw.py`, `draw_request.py`, `draw_pipeline.py`, `generation.py`,
`latents.py`, `sampling.py` or `loras.py` mention a family key or compare
`.key`. Add a hook with a generic default instead.

## Capabilities, Tasks And Prompt Help

`models/capabilities.py` describes a family as data:

- `GenerationTask` - one thing a family can generate (`text_to_image`,
  `image_to_image`, `inpaint`, `outpaint`, `text_to_video`, `image_to_video`,
  `reference_to_video`, `video_to_video`, `text_to_3d`, `image_to_3d`,
  `panorama_view`, or your own). `canvas_mode` links it to the canvas draw mode;
  `.planned()` declares a capability without a pipeline yet (rejected cleanly,
  shown as "coming later"); `.with_prompt_guide(...)` gives the task its own
  prompt help (e.g. MiniMax H3 image edits vs reference-to-video).
- `MediaKind` - text, image, video, audio, mesh, panorama.
- `ReferenceInputs` - how many reference pictures an edit family reads and how
  the prompt names slot `n` (`Picture {n}`, `<image{n}>`, `<Picture {n}>`).
- `PromptGuide` - `hint` (prompt placeholder), `guide` (paragraphs separated by
  blank lines), `examples`, `negative_prompt` (is the negative used?) and
  `sources` (links the advice is based on - required).
- `ModelCapabilities` - label, tasks, references, prompt guide, requirements
  (`requires_source_image`, `requires_external_config` with their messages),
  `supports_pose_edit`, `default_loader`.

A draw names its task with `task` in the payload, or implicitly through the
canvas `mode`. `UniCanvasModelModule.describe()` is served by
`/vnccs/unicanvas/assets` (`model_modules`); the widget's prompt `?` renders the
guide for the active family from it, so prompt help needs no frontend change.

## LoRA Rules

Families never override `apply_loras`; they declare `LoraRequirement`s
(`loras.py`), applied before the user's LoRA stack:

```python
lora_requirements = (
    LoraRequirement(
        name_setting="my_turbo_lora_name",   # settings key holding the file name
        match=MY_TURBO_LORA_NAME,            # only this canonical file
        enabled_setting="turbo_enabled",     # only with the Turbo switch on
        strength_setting="my_turbo_lora_strength",
        clip_strength=0.0,
    ),
    LoraRequirement(
        name_setting="my_edit_adapter_name",
        default_name="Vendor/edit_adapter.safetensors",
        fixed_strength=1.0,                  # the user cannot change it
        required=True,                       # applied even when a config owns the stack
    ),
)
```

Other options: `require_positive_strength`, `draw_modes` (only for some modes),
`resolver` / `resolve_match` (e.g. a lazy download on first use) and `apply` (a custom
loader, e.g. an unmerged adapter). A file is never applied twice: rules skip files the
linked VNCSS Config stack carries, and the user stack skips files already applied.

## Layer Tool Registries

Blend modes (`render.BLEND_MODES`, `register_blend_mode`), panorama projections
(`render.PANORAMA_PROJECTIONS`, `register_panorama_projection`), background
removers (`remove_bg.BACKGROUND_REMOVERS`, `register_background_remover`; any
family implementing `remove_background()` is offered as an edit-model backend)
and color transfers (`color_match.COLOR_TRANSFERS`, `register_color_transfer`)
are registries as well.

## Where The Code Lives

The backend is the `nodes/unicanvas/` package:

- `loaders.py`: `UniCanvasModelLoader` subclasses and their registry.
- `models/base.py`: `UniCanvasModelModule`, the base class of every family.
- `models/<family>.py`: one module per model family (defaults, turbo LoRA names,
  family-specific downloads and the adapter class).
- `models/__init__.py`: registers every family, in one place.
- `pipeline.py`: `UniCanvasNodeStep` / `UniCanvasPipeline`.
- `models/capabilities.py`: tasks, media kinds, reference slots, prompt guides.
- `draw.py` (entry), `draw_request.py` (payload -> `DrawRequest`),
  `draw_pipeline.py` (`ImageDrawPipeline`, `DrawContext`), `latents.py`,
  `sampling.py`, `generation.py`, `loras.py` (`LoraRequirement`): the shared draw
  path.

## Adding A Loader

Add a `UniCanvasModelLoader` subclass in `nodes/unicanvas/loaders.py` when a
model file format needs a different Comfy loader node.

Required methods:

- `cache_key(settings)`: include every setting that changes loaded assets.
- `load_assets(settings)`: return `(model, clip, vae)`.

Register it next to the built-in loaders at the bottom of the registry section:

```python
_register_unicanvas_model_loader(MyLoader("my_loader", ("alias",), forced_mode=None))
```

Use `forced_mode="sdxl"` only when the loader's output must always be handled by
one inference module. `Checkpoint` does this because UniCanvas treats checkpoint
loading as SDXL-only.

## Adding An Inference Module

Create `nodes/unicanvas/models/my_model.py` with the family defaults and, when
the model needs different prompt, latent, sampler, reference, or decode
behavior, a `UniCanvasModelModule` subclass. Then register it in
`nodes/unicanvas/models/__init__.py`.

Simple modules usually only declare defaults and capabilities (register instances
in `models/__init__.py`):

```python
MY_DEFAULTS = {
    "generation_mode": "my_model",
    "model_loader": "diffusion_model",
    "diffusion_model_name": "my-model.safetensors",
    "clip_name": "my-encoder.safetensors",
    "vae_name": "my-vae.safetensors",
    "sampler_name": "euler",
    "scheduler": "normal",
    "steps": 20,
    "cfg": 1.0,
}

_register_unicanvas_model_module(
    UniCanvasModelModule("my_model", ("my-alias",), MY_DEFAULTS)
)
```

For edit models, mark the module explicitly:

```python
_register_unicanvas_model_module(
    MyEditModule("my_edit_model", (), MY_DEFAULTS, is_edit_model=True)
)
```

This flag changes inpaint/outpaint behavior. Edit models use an InvokeAI-style
masked-latent path: UniCanvas VAE-encodes the source image, attaches the denoise
mask to the latent, and lets the sampler keep unmasked areas on the original
latent trajectory. Non-edit modules keep the SDXL/Anima path with native inpaint
conditioning and DifferentialDiffusion.

If the model uses custom inference nodes, define a `UniCanvasPipeline`.

## Declarative Pipelines

Use `UniCanvasNodeStep` to describe a Comfy node call:

```python
UniCanvasNodeStep(
    node="Flux2Scheduler",
    methods=("get_sigmas", "schedule"),
    inputs={"steps": "$steps", "width": "$width", "height": "$height"},
    output="sigmas",
)
```

The runner resolves inputs starting with `$` from the current pipeline context.
It calls the node through `NODE_CLASS_MAPPINGS` and also tries the node's
`FUNCTION` metadata, so contributors usually do not need to know exact Python
method names.

Available common context values:

- `$model`, `$clip`, `$vae`
- `$positive`, `$negative`
- `$positive_text`, `$negative_text`
- `$image_tensor`
- `$latent`
- `$seed`, `$steps`, `$cfg`, `$sampler_name`
- `$width`, `$height`

Flux Klein is the reference implementation. Its pipeline is declared as
`FLUX_KLEIN_PIPELINE` and contains:

- `reference`: attach source image latent to conditioning.
- `sample`: Flux2 scheduler + guider + sampler graph.
- `decode`: VAE decode.

Z-image Turbo is implemented as `ZImageUniCanvasModule`. It uses the standard
`Diffusion Model` loader with the official defaults from
`image_z_image_turbo.json`: `z_image_turbo_bf16.safetensors`,
`qwen_3_4b.safetensors` as `lumina2`, `ae.safetensors`,
`EmptySD3LatentImage`, `ModelSamplingAuraFlow` shift `3`, and
`res_multistep/simple` sampling. It is a non-edit module, so inpaint/outpaint
reuse the same SDXL/Anima inpaint conditioning path.

Z-image negative conditioning has one exception: turbo mode uses the official
workflow's `ConditioningZeroOut` negative conditioning. Turbo mode is selected
when the diffusion/GGUF model filename contains `turbo`, or when the user sets
`cfg` to `1`. Otherwise, the negative prompt remains the full `CLIPTextEncode`
conditioning so non-turbo Z-image models can use negative prompts normally.

## Frontend Registration

The frontend registry in `web/vnccs_unicanvas.js` must include the mode label,
defaults, aliases, and `detect` keywords. `detect` is used to switch Mode
automatically when the selected model filename matches a known family.

For models loaded by existing loader types, no new UI fields are needed. The
loader controls which model file selectors are shown:

- `Checkpoint`: `ckpt_name`
- `Diffusion Model`: `diffusion_model_name`, `clip_name`, `vae_name`
- `GGUF`: `gguf_model_name`, `clip_name`, `vae_name`

When adding a new loader field, add it in the JS loader registry and return its
asset list from `/vnccs/unicanvas/assets`.

## Inpaint And Outpaint

UniCanvas has two inpaint/outpaint strategies:

- Non-edit modules use SDXL/Anima-style inpaint conditioning. The source is
  encoded with inpaint metadata, DifferentialDiffusion may be applied, and the
  generated result is pasted back through the mask.
- Edit modules (`is_edit_model=True`) use masked source latents. The source image
  is VAE-encoded and a `noise_mask` is attached to the latent. This mirrors
  InvokeAI's rectified-flow edit model flow, where denoise receives both init
  latents and a denoise mask so unmasked regions remain anchored to the original
  image.

For edit-model outpaint, the masked/empty outpaint region is flattened to black
for inference. Do not smear, stretch, or crop the reference automatically: the
black region is intentional context for the edit model.

Outpaint requests also append `outpaint black part of image` to the positive
prompt at runtime. The UI prompt is not changed; the suffix only helps edit
models understand that black/empty canvas regions are targets to extend.

If a model has its own native masked edit implementation, override the module
methods and keep those mask semantics local to that module.
