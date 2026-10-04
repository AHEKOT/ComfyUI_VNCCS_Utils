# Vendored motion model code

ARDY and Kimodo run inside ComfyUI's own Python, like UniCanvas Draw: no pip install,
no separate process. Their inference code is copied here and adapted to the packages
ComfyUI already ships (torch, transformers 4.x or 5.x, safetensors, einops, scipy,
PyYAML, pydantic, huggingface_hub).

| Folder | Source | Commit | License |
| --- | --- | --- | --- |
| `ardy/` | <https://github.com/nv-tlabs/ardy> (`ardy/`) | `693f74d13b3d04a0a22ce127ee79c929dd89756b` | Apache 2.0, `LICENSE-ardy-Apache-2.0`, `ATTRIBUTIONS-ardy.md` |
| `kimodo/` | <https://github.com/nv-tlabs/kimodo> (`kimodo/`) | `58e781898b3d7e328a676a75d3e338c45dce3ad9` | Apache 2.0, `LICENSE-kimodo-Apache-2.0`, `ATTRIBUTIONS-kimodo.md` |
| `fsq_quantizer.py` | vector-quantize-pytorch 1.25.2, `finite_scalar_quantization.py` | release 1.25.2 | MIT, `LICENSE-vector-quantize-pytorch-MIT` |

Model weights are not part of the repository: `loaders.py` downloads the checkpoints
(`nvidia/ARDY-Core-RP-20FPS-Horizon40`, `nvidia/Kimodo-SOMA-RP-v1.1`, NVIDIA Open Model
License) and the text encoder into `<ComfyUI>/models/text_to_motion` on first use.

## What is copied

Only the inference closure: the model, denoiser and autoencoder classes, diffusion and
classifier-free guidance, motion representations, skeletons (with the `cskel27`,
`somaskel30` and `somaskel77` rest-pose assets), constraints and tools. Not copied: the
demos, viewers, training, exporters, the TMR retrieval model, the bundled LLM2Vec package,
the Hugging Face loader and the TensorRT path.

## What was changed

- Imports of the package itself (`from ardy.x import ...`) are relative.
- Package `__init__` files of `ardy`, `ardy.model`, `kimodo` and `kimodo.model` are empty
  (the originals import the demo-only loaders); `kimodo.motion_rep` no longer exports TMR.
- `model/loading.py` keeps only `load_checkpoint_state_dict`; non-safetensors checkpoints
  load with `weights_only=True`. Skeleton assets load with `weights_only=True` too.
- `model/backbone.py` no longer imports omegaconf (`ListConfig` type hint).
- `ardy/model/autoencoder/fsq.py` imports the vendored `FSQ`.

## Replacements written for VNCCS

- `config_loader.py` builds a model from the checkpoint's `config.yaml` without Hydra or
  OmegaConf: `${...}` references are resolved and `_target_` may only name a class of this
  vendored code.
- `hub.py` downloads public repositories file by file with `token=False`. A gated
  repository can be placed by hand into its folder plus an empty `.complete` file.
- `llm2vec_encoder.py` reproduces the LLM2Vec encoder (Llama 3 8B Instruct, made
  bidirectional, MNTP + supervised LoRA, mean pooling) on the stock `LlamaModel`, without
  `peft` and without subclassing transformers internals. The Llama 3 weights come from the
  ungated mirror `NousResearch/Meta-Llama-3-8B-Instruct` (Meta Llama 3 Community License).
  The encoder stays in system RAM and visits the GPU only while a prompt is encoded.
- `loaders.py` ties it together and keeps one encoder for both families.

Not available: the upstream foot-skate post-processing (`motion_correction`, a C++
extension), so feet may slide a little more than in NVIDIA's demos.
