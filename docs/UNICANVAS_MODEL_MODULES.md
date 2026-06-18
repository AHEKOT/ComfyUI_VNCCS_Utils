# UniCanvas Model Modules

UniCanvas generates inside its widget, before normal ComfyUI graph connections
can provide model objects. Model support is therefore split into two concepts:

- **Loader**: how `model`, `clip`, and `vae` are loaded.
- **Inference module**: how prompts, reference images, latents, samplers, and
  decoding are wired for one model family.

This split keeps model files independent from the inference graph. For example,
`Diffusion Model` can load both Anima and Flux Klein, while `Checkpoint` always
forces SDXL.

## Adding A Loader

Add a `UniCanvasModelLoader` subclass in `nodes/unicanvas.py` when a model file
format needs a different Comfy loader node.

Required methods:

- `cache_key(settings)`: include every setting that changes loaded assets.
- `load_assets(settings)`: return `(model, clip, vae)`.

Register it with:

```python
_register_unicanvas_model_loader(MyLoader("my_loader", ("alias",), forced_mode=None))
```

Use `forced_mode="sdxl"` only when the loader's output must always be handled by
one inference module. `Checkpoint` does this because UniCanvas treats checkpoint
loading as SDXL-only.

## Adding An Inference Module

Add a `UniCanvasModelModule` subclass when the model needs different prompt,
latent, sampler, reference, or decode behavior.

Simple modules usually override only defaults:

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
