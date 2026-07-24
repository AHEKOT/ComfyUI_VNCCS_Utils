# VNCCS 3D Factory

VNCCS 3D Factory turns a single reference image into a 3D Gaussian object with
the open-source [TripoSplat](https://github.com/VAST-AI-Research/TripoSplat)
pipeline, then lets you assemble multiple generated objects into persistent
scenes directly inside ComfyUI.

## Model setup

Open **Model setup** in the TripoSplat section of the node. The dialog shows the
five required official weight files and their installation state. Existing
files are discovered through ComfyUI's standard model folders and
`extra_model_paths`. Choose **Download weights** to install missing files from
`VAST-AI/TripoSplat` into:

```text
ComfyUI/models/diffusion_models/triposplat_fp16.safetensors
ComfyUI/models/vae/triposplat_vae_decoder_fp16.safetensors
ComfyUI/models/vae/flux2-vae.safetensors
ComfyUI/models/clip_vision/dino_v3_vit_h.safetensors
ComfyUI/models/background_removal/birefnet.safetensors
```

To use another storage location, set `VNCCS_TRIPOSPLAT_MODELS` to an absolute
models root containing the same subfolders before starting ComfyUI. The older
`ComfyUI/models/TripoSplat/` layout remains readable for compatibility. No API
key, CLI program, external inference server, or llama.cpp installation is used.

The same dialog has a separate **Inference settings** block. `1024 × 1024`
remains the official default conditioning resolution. `1536 × 1536` and
`2048 × 2048` are experimental modes that supply 2.25× and 4× as many image
tokens to each conditioning encoder. They can preserve finer source evidence,
but run outside the released model's trained inference regime and require
substantially more compute and VRAM.

Enable **Do not upscale smaller sources** to cap conditioning at the source
image's native short side. The effective size is rounded down to a multiple of
16 so DINOv3 and Flux VAE retain matching patch grids. The option is disabled
by default for backward compatibility. Requested and effective resolutions,
the native-upscale policy, and both encoder tensor shapes are written to the
generation log.

## Generate an object

1. Drop a PNG, JPEG, or WebP reference into the left panel.
2. Choose the Gaussian count. `131K` is the normal quality setting; `32K` and
   `65K` are useful for drafts, while `262K` is the supported maximum.
   `524K` is an experimental 2×-density extension. It uses 16,384 decoder
   tokens and can require substantially more VRAM and decode time because the
   TripoSplat Gaussian decoder uses full attention. `1.05M` is the extreme
   4×-density mode, uses 32,768 decoder tokens, and is intended for finding
   hardware/runtime limits rather than routine generation.
3. Set sampling steps, guidance, mask erosion, and seed.
4. Choose **Generate object**.

The progress panel reports the real pipeline stage. The same events are written
to the ComfyUI console and to the scene's `logs/` directory. A failed job opens
a graphical diagnostic with the Python traceback and a full-log download.

## Scene workflow

Use **Scenes** in the top bar to create or reopen scenes. Every new generation
is added to the active scene. Select an object in the right panel or viewport,
then:

- drag the colored viewport gizmo to move, rotate, or uniformly scale it;
- switch tools with the viewport buttons or `W` / `E` / `R`;
- export its current transformed state as PLY or SPLAT from its object card;
- duplicate it as an independently transformable scene object;
- remove it from its object card after a graphical confirmation.

Scene selection, generation settings, camera position, transform mode, grid,
and selected object are stored in the workflow. Scene data and Gaussian assets
remain under `ComfyUI/output/vnccs_3d_factory/scenes/`.

The selected reference image is copied into the active scene as soon as it is
chosen. The workflow stores its scene URL and metadata rather than a temporary
browser `blob:` URL, so the reference thumbnail and repeat-generation source
survive a browser reload and workflow reopen.

The workflow state also carries a compact transform snapshot. When ComfyUI
executes the node, that snapshot is reconciled with the persistent scene before
the combined output is exported, so a just-moved object cannot be omitted by a
pending UI autosave.

## Scene export

**Scene PLY** and **Scene SPLAT** bake every object's position, rotation, and
uniform scale into one Gaussian model. These files contain real Gaussian
centers, covariance transforms, colors, and opacity—not a triangle mesh or a
renamed placeholder file.

The scene PLY header also embeds the exact perspective camera used by Scene
Export: position, target, Y-up vector, vertical FOV, output dimensions, and
aspect ratio. Raw `.splat` has no header or metadata section—every 32-byte
record is a Gaussian—so Scene SPLAT remains standards-compatible and downloads
an integrity-bound `.camera.json` sidecar with the same data. Appending camera
bytes to the SPLAT itself would make compatible viewers interpret them as
corrupt Gaussians.

GLB export reconstructs a colored triangle mesh from the Gaussian density
field. It is intended for conventional mesh tools; PLY/SPLAT remain the
lossless Gaussian scene outputs.

## ComfyUI outputs

When the graph executes, the node exposes:

- `preview`: a clean render of the complete 3D scene from the current viewport
  camera, without the editor grid, selection bounds, or transform gizmo;
- `scene_ply`: the revisioned combined PLY path;
- `scene_splat`: the revisioned combined SPLAT path;
- `scene_manifest`: the persistent `scene.json` path.

The browser viewport capture is saved with the scene and bound to its revision.
If the scene changes before a fresh frame is captured, the node returns an
empty preview rather than silently substituting an input/reference image or an
outdated 3D render.
