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
| `depth` | `IMAGE` list | Camera depth of the characters, aligned with `images`. See [Auxiliary control images](#auxiliary-control-images). |
| `normal` | `IMAGE` list | View-space normal map aligned with `images`. |
| `outline` | `IMAGE` list | White contour lines on black aligned with `images`. |
| `silhouette` | `IMAGE` list | White characters on black aligned with `images`. |
| `mask` | `MASK` list | Character coverage (1 = character) aligned with `images`. |
| `character_id` | `IMAGE` list | One flat colour per character slot on black, aligned with `images`. |
| `crop_json` | `STRING` list | The crop guide of each image, aligned with `images`. See [Crop Guide](#crop-guide). |
| `crop_image` | `IMAGE` list | Crop of each full image with its guide (the full image when the guide is disabled). |
| `crop_preview` | `IMAGE` list | Each full image with the outside dimmed and the guide border drawn. |

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

## Auxiliary control images

`depth`, `normal`, `outline`, `silhouette`, `mask` and `character_id` are extra
outputs appended after `images` and `lighting_prompt`, so existing links keep their
slots. They are rendered in the browser only when at least one of them is linked;
unlinked outputs return black placeholders and cost nothing, and `images` is
unchanged either way.

- **Same camera as `images`.** Every pass is rendered right after its RGB capture
  through that capture's camera and at the output resolution, so FOV, Distance,
  Align Camera to View, Yaw/Pitch, Zoom and the radar placement affect all outputs
  identically.
- **Characters only.** The passes draw a private scene of the character meshes
  (every character, with its own pose, position, zoom and rotation; hidden
  characters are skipped). The grid, capture frame, bones, joint markers, reference
  image, skydome, gizmos, imported figure overlays and any other editor helper never
  appear. Lighting, skin texture and model colour do not affect them.
- **Overlaps** are resolved by the depth test in every pass, exactly as in `images`.
- **LIST / GRID.** LIST returns one image per pose tab; GRID builds the same grid as
  `images` on a black (ID 0) background.
- **Pose Manager.** RUN still sends the card images byte for byte; the passes are
  rendered at RUN with the exact camera each card was captured with.
- **Debug Mode and `pose_image`** captures produce passes for the image they output.
- **Animation mode** is not supported yet: linking an auxiliary output there stops
  the run with an error instead of returning blank images.

| Output | Encoding |
| --- | --- |
| `depth` | Grayscale linear camera depth: nearest visible surface **white (255)**, farthest one gray 32, background **black (0)**. Normalized per image over all characters, so depth differences between characters stay visible. Same convention as MiDaS / ControlNet depth maps. |
| `normal` | View-space normals, OpenGL / three.js `MeshNormalMaterial` convention: R = +X (right), G = +Y (up), B = +Z (toward the camera), `rgb = normal * 0.5 + 0.5`. A surface facing the camera is (128, 128, 255). Background is black. |
| `outline` | **White lines on black.** A character pixel is on the outline when a neighbour is background, another character behind it, or a part of the same character behind it (an inverse-depth step of at least 1 %, e.g. an arm in front of the body). Lines lie inside the silhouette, 1 px wide up to 640 px and thicker on larger outputs. Normal creases are not drawn yet. |
| `silhouette` | White (255) characters on black. |
| `mask` | ComfyUI `MASK`, 1.0 on characters, 0.0 on background. |
| `character_id` | Flat colours without anti-aliasing by character slot: Character 1 = red (255, 0, 0), Character 2 = green (0, 255, 0), Character 3 = blue (0, 0, 255), Character 4 = yellow (255, 255, 0); background = ID 0 = black. The colour follows the slot, not the selected character, so it is stable across edits, saves and reloads. One channel threshold extracts a character's mask. |

The workflow records the linked auxiliary outputs in `pose_data.export.conditioning_outputs`
so linking one re-executes the node. The passes reuse the 3D Factory conditioning renderer
(`web/shared/conditioning_render.mjs`).

## Crop Guide

The **Crop Guide** section (left panel, below Camera Angle) adds a framing rectangle
inside the orange capture frame. Use it to compose a wide 3D shot that keeps every
joint in the frame (so OpenPose, depth and normal conditioning stay complete), mark the
final crop, generate from the uncropped image and crop the generated image afterwards.

- **The guide never changes the capture.** `images`, the auxiliary outputs, the camera,
  FOV, Distance and the pose are identical with the guide on or off. It is an editor
  overlay drawn on its own 2D layer, so it never appears in a capture.
- **One rectangle per pose tab**, shared by every character (scene level, like the
  prompt and the lens). New tabs start with a disabled guide.
- **Enabled** makes the tab's rectangle drive the crop outputs. **Show** hides or shows
  the overlay; **Dim Outside** darkens the frame around it (both are editor preferences).
- **Edit Crop** turns on editing: drag inside the rectangle to move it, drag a corner or
  edge handle to resize it. Orbit, pan, zoom and bone editing keep working outside the
  rectangle, and nothing is intercepted while editing is off. Editing works from any
  orbited view: the pointer is projected onto the frame's plane.
- **Aspect**: Free, 1:1, 4:3, 3:4, 16:9, 9:16 or Custom (W : H). Ratios are of the final
  crop in output **pixels**, so 1:1 is square on a 1280 x 720 output too. Fixed ratios
  are always locked; with Free, **Lock** keeps the current shape while resizing.
- **X / Y / W / H** are exact output pixels and update the rectangle while you type; the
  overlay updates the fields while you drag. **Center** centres the rectangle; **Fit to
  Frame** makes it the largest centred rectangle of the selected ratio. The readout shows
  the size, position and actual ratio.
- Every drag, field edit or button is one **Undo** step; edits are realtime and persist
  when the gesture ends. Rectangles stay inside the image with a minimum of 8 x 8 pixels.
- The rectangle lives in post-projection image space, so FOV, Distance, Maintain Subject
  Size, Align Camera to View, Orbit Camera, Yaw/Pitch, Zoom and output resolution changes
  keep its normalized coordinates. It never moves the camera or the pose. After an output
  resolution change a fixed ratio can be off by the aspect change; the readout says so
  until you resize or Fit.

### Coordinates and crop_json

The rectangle is stored normalized: origin top-left, +x right, +y down, `0..1`, no
rotation, always fully inside the image. Workflows store it per tab in
`pose_data.crop_guides`; static Pose Library assets store the active tab's guide as
`crop_guide` (animation scenes store `crop_guides`). Workflows and library assets saved
before the crop guide existed load with a disabled guide; loading a static library pose
applies its guide to the current tab, like its lens. No image data is stored.

Stored guide fields: `schema_version` (1), `enabled`, `x`, `y`, `width`, `height`,
`aspect_ratio` (`free`, `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `custom`),
`custom_aspect_ratio` (`[w, h]`) and `aspect_ratio_locked`. NaN, Infinity, negative,
non-numeric or oversized values are rejected (the guide loads disabled) or clamped inside.

Pixel conversion, identical in the browser, in Pose Studio and in Apply Crop Guide:
left and top use `floor(x * width)`, right and bottom use `ceil((x + w) * width)` and
are exclusive, all clamped to the image, at least 1 pixel; width and height are the
differences of the boundaries. Products within 1e-6 pixel of an integer count as that
integer, so float error (`0.1 + 0.2`) never shifts a boundary. The editor snaps the
rectangle to whole output pixels, so the fields, the overlay and `pixel_rect` agree.

Example `crop_json`:

```json
{
  "schema_version": 1,
  "type": "vnccs_crop_guide",
  "enabled": true,
  "coordinate_system": "top_left_normalized",
  "source": {"width": 1280, "height": 720},
  "rect": {"x": 0.25, "y": 0.1, "width": 0.4375, "height": 0.7777777777777778},
  "pixel_rect": {"x": 320, "y": 72, "width": 560, "height": 560},
  "aspect_ratio": "1:1",
  "aspect_ratio_value": 1.0,
  "aspect_ratio_locked": true,
  "pose_index": 0
}
```

`pose_index` is the pose tab (`null` for a Debug Mode library pose); `custom_aspect_ratio`
is added for Custom. Runs where the guide does not apply add `"unsupported": "<reason>"`.

### Output modes

| Mode | Crop outputs |
| --- | --- |
| Studio, Image mode, LIST | One `crop_json`, `crop_image` and `crop_preview` per pose tab, in the order of `images`. |
| Debug Mode | The single library pose uses that asset's saved guide (disabled if it has none). |
| GRID, Animation (VIDEO or IMAGE batch), Pose Manager | Not supported: their images are not the Studio capture frame of each tab. A linked crop output stops the run with an error; unlinked outputs return disabled `crop_json` and black placeholders. |

`crop_preview` is only drawn while it is linked (otherwise a black placeholder); linking
it records `export.crop_outputs` in `pose_data` so the node runs again. `crop_image` is a
copy of the crop and never shares pixels with `images`. Pose Manager RUN and its card
cache are unchanged.

### VNCCS Apply Crop Guide

`VNCCS Apply Crop Guide` (`VNCCS_ApplyCropGuide`, category `VNCCS/pose`) crops any image
with a `crop_json`: inputs `image` (IMAGE), `crop_json` (STRING) and `aspect_mismatch`;
output `cropped_image` (IMAGE list). It parses and validates the JSON, uses the input
image's real resolution, converts the normalized rectangle with the same rounding and
crops without resizing or interpolation. Invalid JSON, unknown schema versions,
non-numeric or out-of-range rectangles stop with a clear error. A disabled guide returns
the image unchanged.

Pairing: one `crop_json` crops every image (each batch keeps its size); N images and N
`crop_json` values pair in order; one batch of N images and N `crop_json` values is split
per pose. Crops of different sizes are separate list items and are never stacked into one
tensor. The same `crop_json` crops the depth, normal, outline, silhouette and Character ID
outputs identically.

Typical workflow: `images` -> ControlNet / generation -> `VNCCS Apply Crop Guide`
(`crop_json` from Pose Studio) -> Save Image.

Applying the rectangle to an image of a different resolution:

1. **Pure resize** (same content scaled, e.g. 1280 x 720 -> 1920 x 1080): supported; the
   same normalized rectangle is converted at the new resolution.
2. **Letterbox, padding or center crop**: the rectangle must go through the same geometric
   transform first. Apply Crop Guide refuses an aspect ratio that differs by more than 1 %
   by default; choose `stretch` only when the image was resized without padding or
   cropping (stretched).
3. **The generator moved or reframed the subject**: no guarantee; the rectangle marks the
   image region, not the subject.

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
| FOV / Distance | Shared capture lens in **Camera Angle**: vertical field of view (15–75°, default 30°) and camera distance (10–250, default 45). Wide angles exaggerate perspective; narrow angles flatten it. |
| Maintain Subject Size | When on, changing FOV moves the camera so the subject keeps its size and only the perspective changes (`distance * tan(FOV / 2)` stays constant). |
| Align Camera to View | Moves the capture camera to the current viewport camera (position, rotation, zoom), like Unity's Align With View, and captures what the orange frame covers. Shortcut: `Ctrl+Shift+F` while Pose Studio has focus. **Orbit Camera** returns to the regular camera. While aligned, Yaw and Pitch orbit around the aligned pivot. |
| Camera positioning radar | Moves the selected character; every character keeps its own X/Y. |
| Camera Zoom | Scales the selected character; every character keeps its own zoom. |
| model rotation | Rotate the mannequin without changing the viewport UI state. |
| background color | Used for final render and grid background. |
| `directional_skydome_enabled` | Show/export the directional skydome and expose the `camera_prompt` input. |

The lens is stored with each pose tab's `cameraParams` (`fov_deg`, `distance`,
`maintain_subject_size`), mirrored on every character like yaw/pitch, and in the
library asset's `camera` block. Poses and workflows saved without these fields load
with the original 30° / 45 camera. When the view snaps to the capture camera, the
viewport shows the capture perspective while the orange frame keeps its size. After you
orbit, pan or zoom the view, FOV and Distance apply to that view instead of moving it back:
it keeps its direction and pivot, shows the capture perspective, and Distance moves it along
its line of sight by the same ratio. **Preview** snaps back to the capture camera. While an applied SAM camera is active its
projection sets the lens, so FOV and Distance are disabled until it is paused or
cleared; the stored manual lens is not overwritten.

**Align Camera to View** is the reverse of the automatic snap from the capture camera
to the viewport. The capture camera takes the viewport camera's exact position and
rotation; characters, their placement and their joints do not change. Framing rules:

- The capture covers what the orange frame covers in the viewport. The viewport always
  shows the frame with a margin around it, so the image is the centre of the view at
  the frame's height, and the FOV you set is kept: aligning right after a FOV change or
  **Preview** leaves the camera unchanged. When the output aspect differs, a wider output
  shows more at the sides and a narrower one crops the sides.
- FOV outside 15–75° is stored as the nearest lens value plus a matching zoom, and a
  pivot closer than 10 or farther than 250 is moved along the view ray. Neither changes
  the image.
- While aligned, Yaw and Pitch show the aligned direction and orbit the camera around the
  aligned pivot; FOV and Distance still work (Distance moves the camera along its view ray).
  **Orbit Camera** returns to the regular camera with the same Yaw, Pitch and lens; the
  camera reset returns to the default camera.
- The view is stored per pose tab as `cameraParams.view` (and `export.cam_view`), shared
  by every character, saved to the Pose Library and workflows, and used by RUN captures.
  Pose Manager cards keep fitting each pose into the card, through the aligned angle and
  lens. An applied SAM camera takes precedence; the aligned view returns when SAM is
  paused or cleared.

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
- Download public Hugging Face pose repositories. Remote publishing is currently disabled.

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
| Pose Library API routes under `/vnccs/pose_library/...` | Repository, save, load, delete, refresh, and progress operations. Publishing requests return 403. |

Animation tracks referenced by saved workflows live in `user/vnccs/pose_animation_cache`.
They survive temporary-folder cleanup and are not pruned automatically. Back up that
directory with workflows; remove unused files explicitly. Older temporary animation
files are migrated when read, while they are still available.

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
VNCCS nodes listed in `VNCCS_UTILS_NODE_GUIDE.md`. The vendored SAM3D classes are
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
| Pose capture cache image count | 600 images |
| Pose capture cache total text size | 64 MiB |
| Decoded captured image | 32 MiB per image |
| Captured image pixels | 4096 x 4096 per image |
| Captured sequence pixels | 64 Mi pixels in total; reduce resolution or frame count above this |
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
- A failed live capture or SAM import stops execution instead of returning old frames. Scene readiness has a 120-second budget, with extra time for capture and upload.
- Failed manager refreshes retain the last visible card, but execution waits for a successful refresh.
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

- `VNCCS_UTILS_NODE_GUIDE.md` - full registered VNCCS node reference.

## Typed library storage

Poses and animations are separate assets. New local files use
`PoseLibrary/<repository>/poses/<category>/<name>.json` and
`PoseLibrary/<repository>/animations/<category>/<name>.json`, with previews beside
each JSON file. Both types may share a name and category. The library API uses
`asset_type=pose` or `asset_type=animation` for loading, previews, and deletion.
Legacy files remain readable and migrate to typed storage when saved. An
untyped lookup matching multiple assets returns an error instead of selecting
one arbitrarily. Repository synchronization requires a valid `poses` array;
invalid manifests and failed downloads retain the existing cache.

`VNCCS_ModelManager` and `VNCCS_ModelSelector` have been removed. Older workflows
using them must select their model or LoRA directly in standard ComfyUI loaders.
The bundled workflow examples already use those loaders.
