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
3. Set sampling steps, guidance, background removal, and seed.
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
- export its current transformed state as PLY from its object card;
- duplicate it as an independently transformable scene object;
- remove it from its object card after a graphical confirmation.

Choose **Import PLY** above the scene-object list to add an existing Gaussian
PLY directly to the active scene. Factory validates the complete payload,
normalizes its coordinate convention, stores it as a persistent scene object,
and immediately loads its derived SPLAT into the viewport. The imported object
is selected and framed automatically. This accepts binary little-endian
Gaussian PLY files with position, DC color, opacity, scale, and quaternion
fields; polygon-mesh PLY files are rejected with an explicit error.

The **Camera** block below TripoSplat provides first-person camera rotation
without changing the viewport's normal orbit controls. Drag the graphical pad
to look left/right/up/down from the current camera position, or use its
keyboard arrows. The graphical roll slider rotates the horizon and returns to
center after each adjustment; there are no numeric camera fields.

Choose **Add camera** to store the current position, target, up vector, and FOV.
Saved entries live in one **Cameras** group. Selecting one shows the viewport
from that camera. Selecting it again, clicking empty viewport space, or
selecting a scene object restores the editor camera that was active before the
saved camera was opened. A scene supports up to 32 saved cameras.

Scene selection, generation settings, current and saved cameras, transform
mode, grid, and selected object are stored in the workflow. Scene data and
Gaussian assets remain under `ComfyUI/output/vnccs_3d_factory/scenes/`.

The selected reference image is copied into the active scene as soon as it is
chosen. The workflow stores its scene URL and metadata rather than a temporary
browser `blob:` URL, so the reference thumbnail and repeat-generation source
survive a browser reload and workflow reopen.

The workflow state also carries a compact transform snapshot. When ComfyUI
executes the node, that snapshot is reconciled with the persistent scene before
the scene render is captured, so a just-moved object cannot be omitted by a
pending UI autosave.

## Scene export

**Scene PLY** bakes every visible object's position, rotation, and uniform
scale into one Gaussian model. The file contains real Gaussian centers,
covariance transforms, colors, spherical-harmonic data, and opacity—not a
triangle mesh or a renamed placeholder file.

The scene PLY header also embeds the current perspective camera and every entry
in the **Cameras** group: stable camera ID, name, position, target, up vector,
and vertical FOV. The shared Scene Export dimensions and aspect ratio are
included once in the same metadata. PLY is the only public object and scene
export format.

## Gaussian model library

The **Library** button in the scene header opens the persistent 3D Factory
library. An individual object is stored with its canonical Gaussian PLY and
metadata. A scene package additionally keeps every object, layer group,
visibility flag, transform, render size, current and saved cameras, and
lighting setup. SPLAT is a disposable internal viewport derivative and is not
duplicated inside `.vnccs3d` packages.

Preview images are rendered automatically from the 3D viewport. Object previews
temporarily isolate and frame only the selected object, then restore the editor
camera and visibility without mutating the scene.

Library data is stored under
`vnccs-utils/ModelLibrary`, alongside Pose Studio's `PoseLibrary`. Its repository panel can synchronize
manifest-driven Hugging Face model repositories and publish the local library
with the existing VNCCS Hugging Face token. Downloaded repository entries are
read-only; loading one always creates an independent Factory object or scene.

## ComfyUI outputs

When the graph executes, `preview` is an `IMAGE` LIST. Item 0 is a clean render
from the current visible viewport camera. The remaining items follow the
**Cameras** group in manager order. Every item uses the same width, height, and
PNG capture format configured by **Scene Export**, while retaining its saved
camera's own position, orientation, and FOV. Editor grid, selection bounds,
and transform gizmos are excluded. Internal PLY/SPLAT asset paths and the scene
manifest are not exposed as graph outputs.

PLY is the only permanent Gaussian source asset. The browser-facing 32-byte
SPLAT representation is generated from PLY on first use and shared by SHA-256
under `ComfyUI/output/vnccs_3d_factory/cache/splats/`. Identical objects and
hard-linked duplicates therefore reuse one cached SPLAT. The cache is
least-recently-used and capped at 8 GiB by default; set
`VNCCS_3D_FACTORY_SPLAT_CACHE_GB` before starting ComfyUI to change the cap.
Deleting the cache is always safe because every entry is reproducible from PLY.

The browser uploads the current view and all saved-camera images as one
revision-bound capture set. The backend publishes it only after every frame
has passed Scene Export dimension validation. If a complete current set cannot
be obtained, execution fails explicitly rather than silently mixing revisions
or substituting an input/reference image or outdated 3D render.
