# ComfyUI VNCCS Utils

> **Current release: `0.6.10`**

A collection of utility nodes from the [VNCCS](https://github.com/AHEKOT/ComfyUI_VNCCS) project for everyday ComfyUI workflows, including **VNCCS 3D Factory**, **VNCCS UniCanvas**, **VNCCS Pose Studio**, and supporting generation utilities.

<table>
<tr>
<td width="50%" align="center">
<strong>Join The Community</strong><br>
Share results, ask questions, and follow VNCCS updates.<br><br>
<a href="https://discord.com/invite/9Dacp4wvQw" target="_blank"><img src="images/VNCCS_Discord_Button.png" alt="Join our Discord"></a>
</td>
<td width="50%" align="center">
<strong>Support VNCCS</strong><br>
VNCCS is developed independently. Support helps keep the project moving.<br><br>
<a href="https://www.buymeacoffee.com/MIUProject" target="_blank"><img src="images/VNCCS_Donate_Button.png" alt="Support VNCCS"></a>
</td>
</tr>
</table>

---

## VNCCS 3D Factory

<p align="center">
  <img src="images/3d-factory-logo.png" alt="VNCCS 3D Factory logo" width="360">
</p>

**VNCCS 3D Factory** is a scene-oriented image-to-3D Gaussian workspace inside
ComfyUI. It runs the open-source
[`VAST-AI-Research/TripoSplat`](https://github.com/VAST-AI-Research/TripoSplat)
pipeline locally, turns reference images into editable 3D Gaussian models, keeps
every generated object in a persistent scene, and renders the actual Gaussian
assets through the bundled SparkJS viewport.

### Key Features

* **True Gaussian Viewport**: Multiple Gaussian PLY objects render together
  with orbit, pan, detail zoom, adaptive camera clipping, selection, and an
  optional grid—there is no synthetic floor mesh.
* **Scene Manager**: Create and reopen scenes; generated objects, names,
  transforms, generation settings, and exports persist on the ComfyUI host.
* **Gaussian PLY Import**: Add an existing validated Gaussian PLY to the active
  scene; it appears immediately in the object list and live viewport.
* **Interactive Transforms**: Click objects in the viewport and move, rotate,
  or uniformly scale them with visible viewport gizmos. Exact numeric fields
  remain available in a collapsed precision panel.
* **Saved Scene Cameras**: A graphical FPV look pad and roll control rotate the
  camera in place without changing normal viewport orbit behavior. Add up to
  32 named scene cameras, click one to inspect its exact view, and receive the
  current view followed by every saved camera as an ordered ComfyUI `IMAGE`
  LIST at the shared Scene Export resolution.
* **Local TripoSplat Pipeline**: The official pipeline runs in process with
  ComfyUI's PyTorch device. Model setup and weight download are graphical.
* **Object and Scene PLY Export**: Export every transformed object separately
  or combine the visible scene as an editable Gaussian PLY. The export bakes
  transforms into the actual Gaussian centers and covariance, preserves
  opacity and spherical-harmonic color data, and embeds the current camera plus
  every saved scene camera.
* **Gaussian Library**: Save individual objects or complete scenes with
  automatic 3D previews. `.vnccs3d` packages keep only canonical PLY assets,
  then synchronize or publish manifest-driven model repositories on Hugging
  Face through the Pose Studio repository workflow.
* **Observable Jobs**: Background removal, image encoding, diffusion steps,
  Gaussian decoding, serialization, and scene insertion expose real progress,
  printed to the ComfyUI console and retained in a downloadable per-job log.
* **Persistent Widget State**: Scene selection, generation controls, source
  reference, object transforms and selection, current and saved cameras, grid,
  and transform mode are saved with the workflow. Reference images are
  persisted on the ComfyUI host rather than temporary browser file URLs.

👉 **[Setup and workflow guide](docs/VNCCS_3D_FACTORY.md)**

## VNCCS UniCanvas

<p align="center">
  <img src="images/uni-canvas-logo.png" alt="VNCCS UniCanvas logo" width="360">
</p>

**VNCCS UniCanvas** is an integrated infinite-canvas image generation and editing workspace inside ComfyUI. It is designed for freeform creative work: generate anywhere, edit any region, build results across layers, and keep refining without being locked to a single fixed image boundary.

### Key Features

*   **Infinite Canvas Workflow**: Work beyond a single image frame and place generations wherever the composition needs them.
*   **Layer-Based Editing**: Build images from separate raster and mask layers with visibility, opacity, selection, movement, and compositing controls.
*   **Generation Anywhere**: Use a selected region as the generation target for new images, image edits, inpaint, outpaint, and full-area transformations.
*   **Mask and Object Tools**: Paint masks, refine selections, and use SAM-powered object selection to isolate or remove parts of an image.
*   **Preset and Custom Models**: Switch between built-in presets, custom checkpoints, or GGUF files for supported generation backends.
*   **Krea2 Identity Edit**: Edit the bbox image with grounded Qwen3-VL and adjust **Likeness** in the upper-right control. See the [Krea2 Edit guide](docs/UNICANVAS_KREA2_EDIT.md).
*   **Turbo and LoRA Controls**: Use Turbo LoRA cards and a general LoRA Stack directly from the generation panel.
*   **Canvas Editing Tools**: Move, resize, rotate, snap, undo/redo, and manage generation results without leaving the node.
*   **Free Transform**: Resize, rotate, skew, distort, perspective, warp, tilt in 3D, and flip layers without rasterizing the workflow first.
*   **Crop-and-Stitch Inpaint**: Generate the selected masked area at full resolution and paste it back only inside the mask.
*   **Automatic Layer Names**: Give generated and imported layers descriptive names, with local text or vision models available for better suggestions.
*   **Live Pose Studio Layers**: Insert an editable mannequin from the vertical toolbar and pose it in a dedicated edit session, then generate characters that follow the pose with the pose and background composite as references. See the [pose layer guide](docs/UNICANVAS_POSE_LAYERS.md).
*   **360° Panorama Editing**: Import an equirectangular panorama, look around from its center, and paint, mask, transform, or generate within a square perspective view; edits stay on the sphere and exports use the complete panorama. See the [panorama guide](docs/UNICANVAS_PANORAMA.md).

### Canvas tools

*   **Radial HUD**: Hold the **right mouse button** (every tool except SAM) to open a four-sector radial HUD at the cursor. Drag toward **size**, **opacity**, **hardness**, or the **foreground color**, then keep dragging to adjust that value live; release to commit. The SAM tool keeps its right-click subtract-point meaning.
*   **Brush hardness** (0-1): strokes render with soft radial-gradient edges below 1, effective immediately while painting.
*   **Settings (gear icon)**: configure the background-removal backend, automatic layer naming, inpaint behavior, performance, and diagnostic logging.
*   **Reference images**: the stacked-cards icon next to *Steps* opens a popover where up to 4 uploaded images condition the edit model; each is labelled `Picture 2`, `Picture 3`, ... so the prompt can refer to it by name (the working area is always `Picture 1`).
*   **Layer menu** (right-click a layer row): copy or save the visible layer, run background removal with an optional prompt, mark keep points with SAM, match colors to the layers below, auto-name the layer, and open pose actions for live pose layers.
*   **Background removal backends**: use an edit model, BiRefNet, rembg, or SAM 3; each path updates the layer alpha with one undoable operation.
*   **Prompt guides**: the `?` beside the prompt shows the active model family's reference syntax and source-specific guidance.
*   **Performance and diagnostics**: enable step caching for longer runs, use VAE chunking on lower-memory systems, and inspect request sizes and timings with debug mode.
*   **PSD import/export**: *Import PSD* loads raster layers (name, visibility, opacity, blend mode, stacking order); anything UniCanvas cannot represent is skipped and reported. *Export Layers as PSD* writes the layer stack as a PSD file.

### VNCSS Config

`VNCSS Config` lets an existing ComfyUI model setup drive UniCanvas. Connect the node's `config` output to the `config` input of `VNCCS UniCanvas`.

While it is linked, the config supplies the model, LoRA, and reference-image values; UniCanvas disables its duplicate controls while keeping **Mode** and the sampling settings editable. Unlinking restores the embedded controls unchanged.

The config panel provides an ordered LoRA stack and an **Edit model** switch for reference-conditioned workflows, including MiniMax H3 region editing. Both settings are saved with the workflow.

### Fullscreen mode

The **Fullscreen** button at the top-right of the stage opens a distraction-free workspace with isolated keyboard input (text fields keep working), a **✕** exit button, and an optional "true fullscreen" toggle. The UniCanvas shortcuts work whenever the canvas has focus, in fullscreen or embedded mode:

| Shortcut | Action |
|---|---|
| `B` / `V` / `E` / `M` / `L` / `S` | Brush / Move / Eraser / Mask brush / Lasso / Rectangle tools |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `[` / `]` | Shrink / grow the brush size |
| `Tab` | Toggle panel visibility |
| `Esc` | Exit fullscreen |

### Standalone Unicanvas mode

The **Unicanvas** sidebar tab runs UniCanvas as a standalone image app — no node, no workflow. Entering it hides the ComfyUI chrome; leaving it restores everything. The engine picker offers the built-in presets plus custom models from disk; output actions replace the node's `image` socket (**Save to output** writes the flattened composite into ComfyUI's `output/` directory, **New** clears the canvas after confirmation). Work persists to `localStorage`, so it survives a page reload. Enable the tab with the `VNCCS.UniCanvas.StandaloneSidebar` ComfyUI setting.

### Qwen-Image-2.1

UniCanvas generates with **Qwen-Image-2.1** through the `QwenImage21` family tab:

*   **Native 2K workflow**: built-in aspect presets and all standard draw modes are available for text-to-image, image-to-image, inpaint, and outpaint.
*   **Transparent output by default**: generated layers keep real alpha; the **`opaque output`** switch is available when transparency is not wanted.
*   **Reference editing**: with `VNCSS Config` and the `Edit model` switch, reference images are addressed predictably from the prompt and combined with the working area.
*   **Viggle turbo**: an optional six-step mode for faster generation.
*   **Edit-model background removal**: use the same family as a subject extractor and apply the result directly to the active layer.

## VNCCS Pose Studio

<p align="center">
  <img src="images/pose-studio-logo.png" alt="VNCCS Pose Studio logo" width="360">
</p>

**Example Workflows:** [QWEN](workflows/VNCCS_Utils%20Pose%20Studio%20QWEN.json) · [Klein9b](workflows/VNCCS_Utils%20Pose%20Studio%20Klein9b.json)

**VNCCS Pose Studio** is a professional 3D posing, framing, lighting, and pose-library environment running directly inside a ComfyUI node. It is designed for building high-quality pose/control references without leaving the graph: adjust the character body, pose bones interactively, frame the camera, tune lights, manage saved poses, and output single images or pose batches.

### Key Features

*   **Interactive 3D Viewport**: Pose the mannequin directly in the node with selectable joints, bone manipulation, transform controls, and full **Undo/Redo** support.
*   **Dynamic Body Generator**: Fine-tune the character shape with sliders for Age, Gender blending, Weight, Muscle, and Height.
*   **Multi-Pose Tabs**: Create multiple independent pose states inside one node, making batch outputs and pose sequences easier to build, with copy/paste between tabs.
*   **Keyframe Animation Mode**: Switch from static images to a dope-sheet timeline with per-bone tracks, playback, Auto-Key, draggable keys, easing presets, and deterministic frame output. Import a Mixamo FBX clip as retargeted bone keyframes.
*   **Text to Motion**: Describe a motion, generate it with NVIDIA Kimodo or Tencent HY-Motion 1.0, scrub the clip, and keep any frame as the pose ([guide](docs/VNCCS_POSE_STUDIO_TEXT_TO_MOTION.md)).
*   **Modal Pose Gallery**: Save, browse, load, and delete poses in a focused full-screen gallery, or batch import/export pose data via JSON.
*   **Tracing Support**: Load a background reference image and align the 3D character to it for accurate pose matching.
*   **Precision Camera Controls**: Set output dimensions, zoom, model rotation, and camera orbit with an integrated radar-style control, and preview the final render boundary in the viewport.
*   **Advanced Environment Lighting**: Control Ambient, Directional, and Point Lights, including 2D radar controls for positioning point lights and radius controls for their influence. A **Keep Original Lighting** mode bypasses synthetic lighting for clean ControlNet-style outputs.
*   **Prompt Tools**: Prompt-aware lighting output, custom tag-based prompt templates (`<lighting>`, `<user_prompt>`), and a direct sidebar prompt field.
*   **Flexible Export Modes**: Output poses as a list or as a grid, with configurable background color.

👉 **[Detailed Usage Guide](docs/VNCCS_POSE_STUDIO_USAGE.md)**

## Additional Nodes

### VNCCS Visual Camera Control
**[Example Workflow](workflows/VNCCS_Utils%20Visual%20camera%20control%20node%20for%20Qwen-Image-Edit-2511-Multiple-Angles%20LoRa.json)**

An interactive node with a visual widget for controlling camera position. It is designed for intuitive angle control and prompt generation, especially for multi-angle LoRAs like **Qwen-Image-Edit-2511-Multiple-Angles**.

*   **Visual Widget**: Select azimuth and distance with the mouse.
*   **Elevation Slider**: Pick elevation from -30° to 60°.
*   **Trigger Word Toggle**: Enable or disable the `<sks>` trigger from the widget.
*   **Random Range Toggle**: Randomize across the full 360° or restrict random views to the front ±45° while keeping elevation and distance random.

### VNCCS QWEN Detailer
**[Example Workflow](workflows/VNCCS_Utils%20QwenDetailer_ChangeEmotion.json)**

A QWEN-Image-Edit2511 detailer for enhancing detected regions such as faces, hands, and objects with vision-guided instructions.

*   **Smart Cropping**: Automatically squares crops and handles padding.
*   **Vision-Guided Enhancement**: Uses QWEN-generated instructions or user prompts.
*   **Drift Fix**: Helps keep the enhanced area aligned with the original composition.
*   **Quality of Life Tools**: Includes color matching, Poisson blending, and upscaling options.
*   **Inpainting Mode**: Supports mask-based editing and filling black areas.
*   **QWEN Options**: Supports QWEN-Image-Edit2511-specific options such as `distortion_fix` and `qwen_2511` mode.

### VNCCS Model Manager & Selector
**[Example Workflow](workflows/VNCCS_Utils%20Model%20Loader%20ShowCase.json)**

A system for managing and selecting LoRAs and checkpoints directly in ComfyUI, with support for Civitai and HuggingFace.

#### VNCCS Model Manager
The backend node that reads a HuggingFace-hosted `model_updater.json` and manages model downloads: point it at your repository, queue downloads in the background, and use API key authentication for restricted Civitai models.

👉 **[Configuration Guide: How to create your own model repo](docs/MODEL_MANAGER_GUIDE.md)**

#### VNCCS Model Selector
The companion UI node for choosing models from the configured repository.

*   **Visual Card UI**: Shows model name, version, status, and description.
*   **Smart Search**: Opens a searchable modal model list.
*   **Status Indicators**: Shows Installed, Update Available, Missing, and Downloading states.
*   **One-Click Install/Update**: Install or update models directly from the selector.
*   **Universal Connection**: Outputs a standard relative path string compatible with standard ComfyUI nodes.

👉 **[Usage Guide: How to use Selector with Standard Loaders](docs/MODEL_SELECTOR_USAGE.md)**

### VNCCS BBox Extractor

A helper node for extracting and visualizing crops when you need detected bounding-box regions without running a full face/detailer workflow.

## Installation

### Recommended: ComfyUI Manager

1. Open **ComfyUI Manager**.
2. Choose **Custom Nodes Manager**.
3. Search for **VNCCS Utils**.
4. Click **Install**.
5. Restart ComfyUI.

### Manual Installation

Open a terminal in your ComfyUI directory and run:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/AHEKOT/ComfyUI_VNCCS_Utils.git
cd ComfyUI_VNCCS_Utils
pip install -r requirements.txt
```

Open **Model setup** inside VNCCS 3D Factory to detect or download the official
TripoSplat weights in the standard `ComfyUI/models/{diffusion_models,vae,clip_vision,background_removal}`
folders. ComfyUI `extra_model_paths` are also searched. The inference pipeline
runs directly in ComfyUI and does not require a separate server.

Restart ComfyUI after installation.

## Star History

<a href="https://www.star-history.com/?repos=AHEKOT%2FComfyUI_VNCCS_Utils%2CAHEKOT%2FComfyUI_VNCCS%2CAHEKOT%2FComfyUI_HYWorld2&type=timeline&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=AHEKOT%2FComfyUI_VNCCS_Utils%2CAHEKOT%2FComfyUI_VNCCS%2CAHEKOT%2FComfyUI_HYWorld2&type=timeline&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=AHEKOT%2FComfyUI_VNCCS_Utils%2CAHEKOT%2FComfyUI_VNCCS%2CAHEKOT%2FComfyUI_HYWorld2&type=timeline&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=AHEKOT%2FComfyUI_VNCCS_Utils%2CAHEKOT%2FComfyUI_VNCCS%2CAHEKOT%2FComfyUI_HYWorld2&type=timeline&legend=top-left" />
 </picture>
</a>
