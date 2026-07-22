# VNCCS Pose Studio Usage Guide

`VNCCS Pose Studio` is an interactive 3D posing, body-shaping, camera, lighting,
render, and pose-library node for ComfyUI.

It is designed for workflows that need consistent character pose control images,
lighting prompts, camera framing, and reusable pose presets.

## Node Interface

Display name:

```text
VNCCS Pose Studio
```

Internal name:

```text
VNCCS_PoseStudio
```

Category:

```text
VNCCS/pose
```

Inputs:

| Input | Type | Visible | Notes |
| --- | --- | --- | --- |
| `pose_data` | `STRING` | hidden | Main JSON state written by the custom Pose Studio UI. |
| `pose_image` | `IMAGE` | optional | Studio mode only. Runs SAM 3D Body image-to-pose import and applies the result to the frontend pose. Disabled in VNCCS Pose Manager mode. |
| `camera_prompt` | `STRING` | settings-controlled socket | Connect `VNCCS Visual Camera Control`. It is available only while `Directional Skydome` is enabled. Pose Studio removes `<sks>`, rewrites the camera tokens as natural text, and appends them to each generated prompt. |
| `unique_id` | ComfyUI hidden | hidden | Used for backend/frontend synchronization. |

Outputs:

| Output | Type | Notes |
| --- | --- | --- |
| `images` | `IMAGE` list | Rendered pose image output. In LIST mode it is one image per pose tab. In GRID mode it is a one-item list containing the grid image. |
| `lighting_prompt` | `STRING` list | Combined lighting, per-pose, and connected camera prompt aligned with `images`. |

Important backend behavior:

- The node requests a fresh frontend sync for every execution.
- When `Directional Skydome` is enabled in Settings, a transparent rainbow wire-grid skydome is rendered behind the mannequin and included in captures. Pose Studio parses azimuth and elevation from each execution's resolved `camera_prompt` and rotates the grid before capture, including high- and low-angle views. Disabling the setting hides the skydome from the interface and export, removes the `camera_prompt` socket, and disables camera-prompt merging.
- If `pose_image` is connected in Studio mode, the backend runs SAM 3D Body, sends the imported pose back to the UI, waits for sync, and then renders the updated state.
- If `pose_data.export.interface_mode` is `manager`, `pose_image` is ignored and the frontend removes that input port.
- Captured image payloads are limited to 16 images, 64 MiB of base64 text total, 32 MiB decoded bytes per image, and 4096 x 4096 pixels per image.

## Main Modes

Pose Studio has two independent mode selectors. `interface_mode` chooses Studio
or Pose Manager, while `editor_mode` chooses static images or animation.

| Editor mode | Purpose |
| --- | --- |
| Image | Existing pose tabs; every tab is an independent output image. |
| Animation | One clip per character with a shared dope-sheet duration, playhead, FPS, transport controls, Auto-Key, and interpolation presets. |

The animation timeline exposes **FPS** and **Seconds**. FPS defaults to 12. The
internal frame count is calculated automatically as `round(seconds × FPS)` and
is not independently editable. Changing FPS does not overwrite the requested
duration. The dope-sheet ruler and playhead use frame numbers (`0…N-1`), and
playback advances exactly FPS frames per real-time second.

Pose Studio also has three practical interface states:

| Mode | Purpose |
| --- | --- |
| Studio | Full editor: body sliders, 3D viewport, pose tabs, camera, lighting, prompt, import/export, and render settings. |
| Pose Manager | Gallery/grid view for pose review and management. The `pose_image` input is disabled here. |
| Manager Detail | Focused edit/detail view opened from Pose Manager. It is still manager context, so `pose_image` remains disabled. |

The mode is stored in `pose_data.export.interface_mode`.

## Animation and Mixamo FBX Import

Choose **Settings → Editing Mode → Animation** to open the timeline below the
3D viewport. Each rig bone has its own track. Double-click a track or use its
diamond button to create/update a key at the playhead. Keys can be dragged to a
new frame, deleted, and assigned Hold, Linear, Ease In, Ease Out, Easy Ease, or
Smooth interpolation. Rotation keys are stored as local quaternions and use
shortest-path interpolation.

Importing a Mixamo `.fbx` file always switches Pose Studio to Animation mode.
The importer retargets the clip onto the current mannequin and converts the
sampled frames into one animation clip:

- frame zero becomes the single base/fallback pose;
- each affected bone receives keys across the timeline;
- missing sparse bone values are explicitly keyed back to rest rotation;
- no pose tab is created for each FBX frame;
- the clip duration and sample count configure the timeline automatically.

In Animation mode, LIST output returns one image per animation frame. Short
clips may use exact browser captures; longer clips are evaluated from the sparse
animation data by the backend rather than being embedded as base64 images in the
workflow.

## Quick Start

1. Add `VNCCS Pose Studio`.
2. Open the node large enough to see the embedded UI.
3. Pose the main mannequin in the center viewport.
4. Optionally expand **Characters** below Prompt and add up to three more characters.
5. Set output dimensions in the camera controls.
6. Add or edit the prompt in the prompt panel.
7. Run the workflow.
8. Connect `images` to downstream image/control nodes.
9. Connect `lighting_prompt` to your text prompt composition if you want the rendered lighting described in text.

## Layout Overview

### Left Panel

The left side contains precision controls:

- Body and mesh proportions.
- Age, gender blend, weight, muscle, height.
- Female and male-specific body sliders.
- Head, limb, torso, hand/foot proportion controls.
- Model rotation controls.
- Shared camera dimensions and angle controls, plus the existing Zoom/radar
  positioning widget for the selected character.
- Export mode controls.
- Debug/render options.

Exact UI grouping may change as the web panel evolves, but all values are saved
inside `pose_data`.

### Center Viewport

The center is the interactive 3D editor:

- Select joints/bones directly in the viewport.
- Use FK/IK controls where available.
- Rotate, move, and reset pose elements.
- Use the frame preview to match the final render crop.
- Manage multiple pose tabs.
- Copy/paste pose states between tabs.
- Import poses from supported JSON/OpenPose/Mixamo paths through the UI tools.

### Right Panel

The right side focuses on prompt, pose library, and lighting:

- Pose Library button and modal.
- Per-pose prompt text.
- Collapsed-by-default Characters scene panel.
- Lighting setup.
- Ambient, directional, and point light controls.
- Light position/radar controls.
- Lighting prompt generation state.

## Characters

The **Characters** panel is directly below Prompt and starts collapsed. A new
scene contains one main character. Use its four scene slots to create up to four
characters total. Slot numbers are stable: removing Character 1
leaves slot 1 empty instead of renumbering Characters 2–4. Click any empty slot
to create a character there; its initial color is chosen from an unused default.

Only the selected character exposes its body, pose, and animation controls. The
other characters remain visible in the viewport as inactive models and are
included in every output capture. Each character stores its own:

- body/mesh parameters;
- model color;
- X/Y position and zoom from the existing Camera widget;
- static poses;
- animation clip.

Camera angle, output dimensions, pose tabs, animation FPS, duration, loop state,
and playhead are shared by the scene. Select a character, then use the original
**Zoom** slider and positioning radar in **Camera**; the same widget switches to
that character's saved X/Y/Zoom values. Changing the common duration never hides
a late key from another character; Pose Studio keeps every character clip on the
same usable timeline boundary.

Removing a character also removes that character's poses and animation after
confirmation. At least one character always remains in the scene.

## Pose Tabs

Pose Studio can manage more than one pose in a single node.

Each tab stores:

- Bone rotations.
- IK/FK state where applicable.
- Model rotation.
- Per-pose prompt.

Pose tabs are shared scene frames: switching a tab displays the corresponding
pose of every character. The selected character is the one edited on that tab.

In LIST output mode, every pose tab becomes a separate output image and prompt
entry. In GRID mode, the node combines rendered poses into one grid image.

## Output Modes

### LIST

`LIST` is the default production mode for most ComfyUI workflows.

Behavior:

- Renders each pose tab separately, with every scene character composited into the same image.
- Returns `images` as a list of individual image tensors.
- Returns `lighting_prompt` as a list aligned to those images.

Use LIST when:

- You want a batch of pose/control images.
- Downstream nodes process each pose separately.
- You want individual prompts per pose.

### GRID

`GRID` combines all poses into one image.

Behavior:

- Renders each pose tab.
- Builds a grid using the configured column count and background color.
- Returns the grid as a one-item image list.

Use GRID when:

- You want a single pose sheet/contact sheet.
- You are building reference previews rather than separate generation inputs.

## Camera and Framing

Pose Studio stores shared output dimensions and camera angles in the `export`
section of `pose_data`. Positioning-radar and Zoom values are stored separately
in each character's `transform` object; the selected character's values are also
mirrored to the legacy camera fields for compatibility.

Common settings:

| Setting | Purpose |
| --- | --- |
| `view_width` / `view_height` | Output resolution. |
| camera yaw/pitch | Shared viewing direction for the whole scene. |
| Camera positioning radar | Moves the selected character; every character keeps its own X/Y. |
| Camera Zoom | Scales the selected character; every character keeps its own zoom. |
| model rotation | Rotate the mannequin without changing the viewport UI state. |
| background color | Used for final render and grid background. |
| `directional_skydome_enabled` | Show/export the directional skydome and expose the `camera_prompt` input. |

Tips:

- Use the preview frame to check the final crop.
- For pose-control images, keep the subject fully visible unless you are intentionally making a close-up.
- For grid sheets, choose dimensions and column count before final capture.

## Lighting and Lighting Prompts

Pose Studio renders a lit mannequin and can output a lighting prompt string.

Lighting controls include:

- Ambient light.
- Directional light.
- Point lights.
- Color and intensity.
- Light position.
- Radius/falloff-like controls for local lights.

The `lighting_prompt` output is intended to be appended to your generation
prompt. It is especially useful when you want image lighting and text prompt
lighting to agree.

### Debug Mode Lighting

For each queued execution, Debug Mode selects exactly one fully loaded pose from
the pose library and applies that library entry as saved, including its stored
rotation and camera data. It does not add any extra random model rotation,
camera angle, framing, zoom, or offsets.

Lighting behavior is controlled separately:

- With `Keep Manual Lighting` disabled, Debug Mode may generate temporary random
  lights for that capture.
- With `Keep Manual Lighting` enabled, the complete current lighting state is
  preserved and random light generation is skipped.
- `Keeping Original Lighting` takes precedence and is preserved as part of the
  manual lighting state.

## Pose Library

Pose Studio includes a local and repository-backed pose library.

Library features:

- Save current pose.
- Save or load a complete multi-character static scene or animation scene.
- Load a saved pose.
- Delete local poses.
- Browse pose cards with previews.
- Organize by repository and category.
- Store tags and metadata.
- Refresh enabled remote repositories.
- Publish local pose repositories to Hugging Face when configured.

Local pose metadata is stored inside each pose JSON under `_library`.

Default category:

```text
Uncategorized
```

Local user repository id:

```text
local_user_poses
```

### Saving Poses

When saving, Pose Studio writes:

- A scene JSON file containing every character and, for animation assets, every character clip.
- Optional preview image.
- Repository/category/tags metadata.

The save path is controlled by repository and category. Pose names are sanitized
to filesystem-safe names.

Current implementation detail:

- Preview data is prepared in a temporary file before replacing the final file.
- Pose JSON is written to a temporary file and installed with `os.replace`.
- This keeps normal save operations from leaving partial preview files behind.

### Remote Pose Repositories

Pose repositories are Hugging Face model repositories with a manifest:

```text
pose_library.json
```

The manifest contains pose entries with JSON paths, optional preview paths,
categories, and SHA256 hashes. During sync:

- Existing files are checked by SHA.
- Changed files are downloaded to temporary paths.
- Per-file download limit is 32 MiB.
- Total sync limit is 256 MiB.
- Files are only marked expected after successful validation/download.
- Stale local files are removed from the repository cache.

### Pose Sync Endpoints

The web UI and backend communicate through local ComfyUI routes:

| Route | Purpose |
| --- | --- |
| `/vnccs/pose_captures_upload` | Upload frontend-rendered captures for backend execution. |
| `/vnccs/pose_captures/{capture_id}` | Fetch cached captures. |
| Pose Library API routes under `/vnccs/pose_library/...` | Repository, save, load, delete, refresh, publish, and progress operations. |

These are internal workflow/UI routes. They are documented so users understand
where state comes from; they are not normally called by hand.

## Using `pose_image`

The optional `pose_image` input lets you drive Pose Studio from an input image.

Workflow:

1. Connect an `IMAGE` to `pose_image`.
2. Run the node in Studio mode.
3. Backend runs SAM 3D Body on the first image in the batch.
4. The imported pose is sent to the frontend.
5. The frontend applies the pose to the mannequin.
6. Backend waits for synced `pose_data`.
7. The node renders the updated pose.

Notes:

- `pose_image` is meant for Studio mode.
- It is disabled in VNCCS Pose Manager mode.
- If a saved manager workflow still sends `pose_image`, backend ignores it when `interface_mode` is `manager`.
- SAM 3D Body can take time on CPU. CUDA is preferred for SAM3D. BiRefNet masking can use XPU when `torch.xpu.is_available()`.

## SAM 3D Body Backend

Pose Studio uses the vendored `vnccs_sam3d` backend for image-to-pose import.

Model files:

```text
<ComfyUI>/models/sam3dbody/
  model.ckpt
  model_config.yaml
  assets/
    mhr_model.pt
```

If missing, the loader path can download from:

```text
jetjodh/sam-3d-body-dinov3
```

Device behavior:

- SAM 3D Body loader supports `Auto`, `CUDA`, and CPU-oriented fallback depending on the underlying code path.
- SAM3D itself is treated as CUDA-first and CPU fallback.
- BiRefNet uses CUDA when available, then XPU when available, then CPU.
- CUDA half precision is used only for CUDA in BiRefNet.

Standalone SAM 3D Body classes present in the vendored package:

| Display name | Internal class | Purpose |
| --- | --- | --- |
| Load SAM 3D Body Model | `LoadSAM3DBodyModel` | Prepare/download SAM3D model config. |
| SAM 3D Body: Process Image to Pose JSON | `SAM3DBodyProcessToJson` | Convert image plus optional mask/hand crops to pose JSON. |
| SAM 3D Body: Setting Body Preset JSON | `SAM3DBodySettingBodyPresetJson` | Build reusable body preset JSON. |
| SAM 3D Body: Render Human From Pose and Body Preset JSON | `SAM3DBodyRenderFromPoseAndBodyPresetJson` | Render a human image from pose JSON and body preset JSON. |

In this repository version, the top-level ComfyUI registration exports the
VNCCS nodes listed in `MODEL_MANAGER_GUIDE.md`. The vendored SAM3D classes are
kept as the backend bridge and may be registered by dedicated SAM3D entrypoints
in environments that load them directly.

## Standalone SAM3D Node Reference

This section documents the SAM3D classes included under `vnccs_sam3d` for users
who expose or call them directly.

### Load SAM 3D Body Model

Input:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `device_mode` | enum | `Auto` | Auto tries CUDA first and falls back when CUDA cannot be used. |

Output:

| Output | Type |
| --- | --- |
| `model` | `SAM3D_MODEL` |

### SAM 3D Body: Process Image to Pose JSON

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `model` | `SAM3D_MODEL` | required | Output from Load SAM 3D Body Model. |
| `image` | `IMAGE` | required | Human subject image. |
| `bbox_threshold` | `FLOAT` | `0.8` | Human detection bbox confidence threshold. |
| `inference_type` | enum | `full` | `full`, `body`, or `hand`. |
| `debug_scale` | `BOOLEAN` | `False` | Emits scale/camera diagnostics to console. |
| `mask` | optional `MASK` | none | Optional body mask. If present, bbox is derived from it. |
| `Left_hand_image` | optional `IMAGE` | none | Cropped left hand; hand decoder result overrides left fingers. |
| `Right_hand_image` | optional `IMAGE` | none | Cropped right hand; hand decoder result overrides right fingers. |

Output:

| Output | Type |
| --- | --- |
| `pose_json` | `STRING` |

### SAM 3D Body: Setting Body Preset JSON

This node builds body preset JSON from sliders. It persists the last successful
settings as `autosave` unless the selected preset is `reset`.

Important slider groups:

| Group | Inputs |
| --- | --- |
| Body PCA controls | `body_fat`, `body_muscle`, `body_fat_muscle`, `body_limb_girth`, `body_limb_muscle`, `body_limb_fat`, `body_chest_shoulder`, `body_waist_hip`, `body_thigh_calf` |
| Bone length controls | `bone_torso`, `bone_neck`, `bone_arm`, `bone_leg` |
| Blendshapes | Dynamic `bs_<name>` sliders discovered from the active preset pack. |

Output:

| Output | Type |
| --- | --- |
| `body_preset_json` | `STRING` |

### SAM 3D Body: Render Human From Pose and Body Preset JSON

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `model` | `SAM3D_MODEL` | required | Loaded SAM3D model config. |
| `pose_json` | `STRING` | `{}` | Pose JSON from process/import/editor path. |
| `body_preset_json` | `STRING` | `{}` | Preset JSON from body preset node. |
| `offset_x` | `FLOAT` | `0.0` | Horizontal render offset. |
| `offset_y` | `FLOAT` | `0.0` | Vertical render offset. |
| `scale_offset` | `FLOAT` | `1.0` | Render scale multiplier. |
| `camera_yaw_deg` | `FLOAT` | `0.0` | Orbit camera yaw. |
| `camera_pitch_deg` | `FLOAT` | `0.0` | Orbit camera pitch. |
| `width` | `INT` | `0` in UI, render default path uses 1024 | Output width; 0 lets backend infer/default depending on context. |
| `height` | `INT` | `0` in UI, render default path uses 1024 | Output height; 0 lets backend infer/default depending on context. |
| `pose_adjust` | `FLOAT` | `0.0` | Lean/pose correction strength. |
| `debug_scale` | `BOOLEAN` | `False` | Console diagnostics. |
| `background_image` | optional `IMAGE` | none | Optional background image. |

Output:

| Output | Type |
| --- | --- |
| `image` | `IMAGE` |

## Import and Interop Notes

Pose Studio web tools include import paths for:

- Pose Studio JSON.
- OpenPose-derived data.
- Mixamo FBX pose extraction through the bundled JS helper.
- SAM 3D Body image-to-pose import.

Because different sources use different coordinate systems, imported poses may
need manual cleanup. Recommended workflow:

1. Import pose.
2. Check hips/spine/shoulders first.
3. Fix hands and feet.
4. Adjust camera.
5. Save into the Pose Library with a clear category/tag.

## Recommended Workflows

### Single Pose Control Image

1. Add `VNCCS Pose Studio`.
2. Pose the body in Studio mode.
3. Set output mode to LIST.
4. Keep one pose tab.
5. Connect `images` to your ControlNet/OpenPose/reference path.
6. Append `lighting_prompt` to your text prompt if useful.

### Multi-Pose Batch

1. Create one tab per pose.
2. Set per-pose prompts if needed.
3. Use LIST output mode.
4. Run the workflow and process the image list downstream.

### Pose Sheet

1. Create multiple pose tabs.
2. Set output mode to GRID.
3. Choose grid columns and background color.
4. Run the workflow to get one combined sheet image.

### Image-to-Pose

1. Connect a source image to `pose_image`.
2. Stay in Studio mode.
3. Run the node.
4. Wait for SAM 3D Body import to apply to the UI.
5. Make manual corrections.
6. Save the result to the Pose Library.

### Pose Manager Review

1. Switch to Pose Manager.
2. Review pose cards in the grid.
3. Open a card for detail editing.
4. Return to Pose Manager when done.
5. `pose_image` is disabled in this mode to keep the manager focused on existing pose states.

## Limits and Safety

Frontend/backend payload limits:

| Payload | Limit |
| --- | --- |
| Pose capture cache image count | 16 images |
| Pose capture cache total text size | 64 MiB |
| Decoded captured image | 32 MiB per image |
| Captured image pixels | 4096 x 4096 per image |
| SAM3D upload image | 32 MiB |
| SAM3D upload pixels | 4096 x 4096 |
| Mesh overlay JSON body | 32 MiB |

Pose Library repository sync limits:

| Item | Limit |
| --- | --- |
| Preview image | 16 MiB |
| Single repository file download | 32 MiB |
| Total repository sync download budget | 256 MiB |
| Sync capture JSON body | 64 MiB |
| Pose repository small API bodies | 1 MiB |

## Troubleshooting

### The node output is stale

- Pose Studio asks the frontend for a fresh sync before execution.
- If the frontend tab was refreshed or the node was duplicated, click inside the node UI once and run again.
- Save and reload older workflows after opening the node once.

### The UI is visible but renders do not match what I see

- Check output mode and output dimensions.
- Use the preview frame before execution.
- Make sure you did not leave Pose Manager mode when expecting Studio capture.

### `pose_image` is missing

- This is expected in VNCCS Pose Manager and Manager Detail modes.
- Switch back to Studio mode to restore the `pose_image` input.

### `pose_image` is connected but ignored

- Check `pose_data.export.interface_mode`.
- In manager mode, backend intentionally ignores `pose_image`.

### SAM3D import is slow

- CUDA is strongly preferred for SAM3D.
- On systems without CUDA, SAM3D may fall back to CPU.
- BiRefNet can use XPU when available, which can be much faster than CPU for the mask stage.

### SAM3D model download fails

- Manually download from `https://huggingface.co/jetjodh/sam-3d-body-dinov3`.
- Place files under `<ComfyUI>/models/sam3dbody/`.
- Required files are `model.ckpt`, `model_config.yaml`, and `assets/mhr_model.pt`.

### No person is detected from `pose_image`

- Use a clearer full-body source image.
- Avoid heavy occlusion.
- If using the standalone SAM3D process node, provide a `MASK` to guide bbox extraction.

### Pose Library sync leaves unexpected results

- Refresh the repository.
- Check whether the remote manifest includes SHA256 hashes for JSON and previews.
- Check ComfyUI console errors for failed downloads, SHA mismatches, or file-size limits.

### Output image is 1x1 or blank

- For Pose Studio, check that a pose capture exists or that the frontend sync succeeded.
- For BBox Extractor, a 1x1 black output means no valid bbox region was detected.
- For SAM3D render paths, check that `pose_json` is valid and not `{}`.

## Related Docs

- `MODEL_MANAGER_GUIDE.md` - full registered VNCCS node reference.
- `MODEL_SELECTOR_USAGE.md` - focused guide for model manifests, downloads, and selector output paths.
