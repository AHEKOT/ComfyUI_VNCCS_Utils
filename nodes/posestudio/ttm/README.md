# Standalone ARDY inference

This directory is a complete Python inference package: ARDY, the Core 27-joint skeleton
asset, sampler, motion representation, start-pose solver, output projection, model
specification, download manifest and upstream code licenses. No files from the parent
VNCCS Utils repository are required for inference.

The model uses **BF16 motion weights** (denoiser and FSQ autoencoder) and a
**ConvRot W4A4 INT4 LLM2Vec encoder**. Runtime files live in
`<model-root>/ARDY-Core-RP-20FPS-Horizon40-int4/`. ComfyUI uses
`folder_paths.models_dir / "text_to_motion"`. Downloads use the pinned public repository
`MIUProject/ARDY-Core-RP-20FPS-Horizon40-int4` and `token=False`.
Ordinary weights, conversion tools and experimental motion quantization are omitted.

## Install separately

Copy this entire directory, including `vendor/` and `config/`, to another location.
Install a PyTorch build appropriate for your GPU, then install the package:

```sh
python -m pip install /path/to/ttm
```

`requirements.txt` lists every external Python dependency. Python 3.10 or newer is
required. The accepted deployment uses CUDA with BF16 support and
[comfy-kitchen](https://github.com/Comfy-Org/comfy-kitchen) exposing
`TensorCoreConvRotW4A4Layout`. CPU-only checks do not establish GPU inference support.
`comfy` and `folder_paths` are optional host integrations, not standalone requirements.
Weights are downloaded separately and are not included in the Python package.

## Generate

```python
from ttm import MotionRequest, create_backend

report = lambda message, percent: print(f"{percent}% {message}")
backend = create_backend("./models/text_to_motion")
try:
    backend.ensure_weights(report)
    backend.load(report)
    motion = backend.generate(
        MotionRequest(prompt="A person walks forward.", duration=2.0, seed=42,
                      guidance=5.0, use_start_pose=False), report,
    )
    print(motion.fps, motion.positions.shape)  # [frames, 27, 3], meters
finally:
    backend.unload()  # also releases the cached encoder
```

`generate` returns `SourceMotion` with global positions, rotations and joint mappings.
With `use_start_pose=True`, supply mannequin `keypoints`, optional `rest_keypoints` and
`head_axes` in `MotionRequest`. The solver creates a frame-zero Core constraint.
The ComfyUI HTTP adapter in `service.py` validates requests and projects output to Pose
Studio coordinates using `transform.py`; standalone hosts can use the same helpers.
Hosts must serialize backend calls and must not unload during generation.

Pose Studio runs ARDY inside ComfyUI's process under the shared model lock.
`service.register_routes` provides the ComfyUI adapter. Importing `ttm` does not register
routes or import PyTorch.

## Distribution and limits

`pyproject.toml` packages configuration, skeleton data and license notices with the code.
VNCCS-written code is MIT; vendored ARDY is Apache 2.0 and FSQ is MIT. See
`vendor/README.md` and its notices. Weight licenses are separate: NVIDIA Open Model
License, Meta Llama 3 Community License and MIT adapters, as specified in the model JSON
and downloaded notices.

Compilation and upstream C++ foot-skate post-processing are disabled. Motion is for one
character. Projection preserves target bone offsets; different proportions can change
contacts. Memory and speed in the model card describe the previous RTX 5070 Ti run,
not a new measurement of this packaging change.
