# Vendored ARDY inference

| Code | Source | Version | License |
| --- | --- | --- | --- |
| `ardy/` | https://github.com/nv-tlabs/ardy | `693f74d13b3d04a0a22ce127ee79c929dd89756b` | Apache 2.0 (`LICENSE-ardy-Apache-2.0`, `ATTRIBUTIONS-ardy.md`) |
| `fsq_quantizer.py` | vector-quantize-pytorch | 1.25.2 | MIT (`LICENSE-vector-quantize-pytorch-MIT`) |

Only the inference closure is retained: denoiser, FSQ autoencoder, motion representations,
diffusion, guidance, constraints, geometry and Core 27-joint rest-pose asset. Training,
demos, unused checkpoint registries and C++ post-processing are omitted.

Imports are relative. Checkpoint and skeleton loading use `weights_only=True` for
non-safetensors files. BF16 tensors are assigned without expanding their dtype.
`config_loader.py` replaces Hydra/OmegaConf with constrained resolution and a registry
restricted to classes actually imported from this package.

`llm2vec_encoder.py` runs the prepared bidirectional Llama encoder with prompt-only mean
pooling. `convrot.py` restores packed INT4 tensors and embedding rows without converting
weights at runtime. `loaders.py` uses only the local BF16/INT4 bundle and caches one
encoder until unload. Downloads use the validated manifest in `base.py`; these loaders
never download upstream models or adapters.
