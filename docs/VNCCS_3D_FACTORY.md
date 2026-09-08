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

### Conditioning outputs

Connect `3D Factory.scene` to **Factory Render.scene**. Connect its `capture`
output to **Factory Mask.capture** to isolate selected geometry. The original
`preview` output remains slot 0 and retains its image-list ordering.

Factory Render outputs RGB, depth, view-space normals, foreground alpha,
RGB24 object IDs, per-camera JSON metadata and a capture handle. Every image
and metadata list follows the same order: current view, then saved cameras.
Width/height and depth-preview limits are configured in Factory Render;
they are independent of the existing RGB Export settings. The initial limit
is 2048 pixels per axis and 32 megapixels across all views in one request.
Geometry evaluation is bounded to 20000 meshes/instances and 4 million vertices.

Depth previews are near-white inverse-linear maps. Raw positive camera-forward
depth is also stored as Float32 meters, with background zero. Metadata records
the 24-bit GPU packing error, camera matrices and image orientation. Alpha is
binary geometry coverage with foreground=1; sky remains outside this mask.
Normals exclude normal maps. Transparent surfaces use their geometry and alpha
cutoff consistently across depth, normal and ID passes.

Use **Mesh geometry** for imported meshes, architecture and primitives. For
Gaussian objects, explicitly choose **Coarse boxes for Gaussian objects** to
approve approximate bounds geometry. RGB keeps the original splats; metadata
identifies which objects used boxes. Supplied proxy meshes and native splat
depth are not implemented in this iteration. Displacement maps and
per-instance morph targets require baking first; alpha textures require UV0.

In Export, **Get selection keys for Mask** lists the selected objects, walls,
rooms or openings. Paste these keys into Factory Mask's `entities` field.
An empty selection includes all foreground; Invert is explicit. Grow/erode
and feather use pixel units and never modify the source ID images.

Fresh captures require the matching open Factory widget in **3D** view.
Export displays progress, cancellation and persistent failure details. Edits
during capture cause a clear failure; an incomplete job never replaces a
completed capture. Exact cached captures work without a live widget.
Published captures retain their own files and hashes when the scene changes
or a later capture runs. Expired staging jobs are cleaned on the next render;
published captures are retained until their scene is removed.

Implementation has local storage, math, list-contract and lifecycle coverage.
GPU pass rendering and real downstream ComfyUI list behavior have not been
visually or interactively verified on the host.

Scenes containing only walls or rooms can produce the node's preview output;
generating or importing a model is not required. Saved cameras retain the
existing ordered image-list output behavior.

Local lights remain on when the realtime shadow budget is exhausted. Low,
Medium, High and Ultra allocate shadows to up to 2, 4, 6 and 8 eligible local
lights respectively, in stored light order. Hidden lights, zero-strength
lights, lights in hidden buildings, and other-floor lights in Plan mode do
not consume a slot. A light with shadows explicitly disabled also uses no
shadow slot. The scene list and light Inspector show the current status.
`Shadows deferred` means the light still illuminates but can shine through
walls. Increase shadow quality or disable shadows on less important sources
to free a slot. Current captures use the same shadow policy as the preview.

The workspace bar provides **Assets**, **Scene tools**, six layout presets,
**Commands**, **Panel mode**, and **Expand editor**. Docks resize by dragging
their dividers or using arrow keys; double-click a divider to reset its size.
Expansion keeps the same scene and canvas. At narrow widths Assets becomes a
closed drawer. **Cmd/Ctrl+K** searches tools and actions.

**Objects**, **Inspector**, and **Export** are separate tabs in every layout,
including expanded mode. Objects shows the hierarchy and creation actions;
Inspector shows properties of the current selection. Each uses the full panel
height and retains its own scrolling. Panel mode changes dock sizing only.

Closed opaque terrain and solids cast shadows from their back faces to avoid
self-shadow speckling. Thin sheets keep two-sided shadows. Point and spot lights
use the configured world-space normal bias, independent of light range.

Light, model-transform, primitive, wall-dimension and camera numeric controls
update continuously. Exact fields accept units such as `25cm`, `1.5m`, `90deg`
or `1.57rad` where appropriate, and relative edits such as `+=25cm` or `*=2`.
Drag a numeric label to scrub; Shift adjusts finely and Alt adjusts coarsely.
The reset arrow resets one field. Escape cancels the current gesture; Enter,
release or valid blur commits one undo step. An unfinished number leaves the
last valid frame visible. Limits appear inline. Saved camera edits update its
helper/preview; entering the camera viewpoint is a separate action. Target
distance controls the look-at target, not optical depth of field.

**Shape** adds editable boxes, ellipsoids, cylinders, cones, ramps, solid stairs
and solid gable-roof wedges. Dimensions are in meters; stairs expose step count
and calculated tread/riser sizes. **Terrain** adds seeded procedural relief
with adjustable height, frequency, octaves, grid segments and base thickness.
The current grid limit is 128×128 cells; tiled sculpting, brush painting and
heightmap import are not implemented yet. Drop to surface uses the actual
primitive triangles beneath the object's footprint.

The first new procedural feature upgrades a copy of an old scene to version
12. The original remains available in Scenes. Native library scene and object
packages preserve primitive recipes and surface textures. A shape loaded into
an old scene also creates a compatible scene copy when needed.

In Plan view, choose **Room → Polygon** to draw a concave room contour. Click
corners, then click the first corner or press Enter / **Finish room**. Backspace
/ **Remove point** removes the last corner; Escape cancels. Crossing contours
are rejected. A valid contour creates linked walls, floor and ceiling in one
undo command. Rectangle mode keeps the original press-and-drag workflow.

Undo history retains up to 200 commands within a 128 MiB serialized-payload
budget. Discarding old steps shows a notification and keeps the live scene.

Use **Scenes** in the top bar to create or reopen scenes. Every new generation
is added to the active scene. Select an object in the right panel or viewport,
then:

- drag the colored viewport gizmo to move, rotate, or uniformly scale it;
- switch tools with the viewport buttons or `W` / `E` / `R`;
- export its current transformed state as PLY from its object card;
- duplicate it as an independently transformable scene object;
- remove it from its object card after a graphical confirmation.

Choose **Import 3D** above the scene-object list to add an existing model to
the active scene. Factory supports GLB/glTF, FBX, OBJ with MTL, STL, and
Gaussian PLY. Select the model together with its `.bin`, material, and texture
files, or select one ZIP package when the asset uses nested folders. PNG,
JPEG, WebP, BMP, GIF, and TGA texture resources are stored with the model.
Imported mesh models are normalized to a practical viewport size while
retaining their hierarchy, materials, UVs, skinning, and embedded resources.

Gaussian PLY import continues to validate the complete payload, normalizes its
coordinate convention, stores it as a persistent scene object,
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
mode, grid, and selected object are stored in the workflow. Scene data,
Gaussian assets, imported models, and their textures remain under
`ComfyUI/output/vnccs_3d_factory/scenes/`.

The selected reference image is copied into the active scene as soon as it is
chosen. The workflow stores its scene URL and metadata rather than a temporary
browser `blob:` URL, so the reference thumbnail and repeat-generation source
survive a browser reload and workflow reopen.

The workflow state also carries a compact transform snapshot. When ComfyUI
executes the node, that snapshot is reconciled with the persistent scene before
the scene render is captured, so a just-moved object cannot be omitted by a
pending UI autosave.

## Room materials

Rooms keep independent material assignments for their perimeter walls, floor,
and ceiling. Select a room and open **Manage textures and mapping** to choose or
create each material in one dialog. Materials support base color/albedo,
roughness, metalness, opacity, UV scale, UV offset, and UV rotation. Optional
normal and roughness maps add lighting detail without adding geometry.

Only materials assigned to architecture are loaded by the viewport. Texture
objects with the same source and UV settings are reused, while optional detail
maps remain unloaded until assigned. Scene packages and model-library scene
entries preserve all room material assignments and texture maps.

## Scene export

The **Export** panel can render a 2:1 equirectangular 360° PNG from any saved
camera. Choose the camera and either the 2048 × 1024 draft size or the
4096 × 2048 high-quality size. The saved camera position is the panorama
viewpoint and its forward direction defines the center of the image. Panorama
capture is generated locally by the viewport and does not alter the editor
camera or scene.

**Scene PLY** bakes every visible Gaussian object's position, rotation, and
uniform scale into one Gaussian model. Imported mesh objects remain part of the
saved scene and rendered previews, but are not converted into Gaussians. The
file contains real Gaussian centers,
covariance transforms, colors, spherical-harmonic data, and opacity—not a
triangle mesh or a renamed placeholder file.

The scene PLY header also embeds the current perspective camera and every entry
in the **Cameras** group: stable camera ID, name, position, target, up vector,
and vertical FOV. The shared Scene Export dimensions and aspect ratio are
included once in the same metadata. PLY is the only public object and scene
export format.

## Model library

The **Library** button in the scene header opens the persistent 3D Factory
library. An individual object is stored with its canonical Gaussian PLY or its
original mesh model, material files, and texture resources. A scene package
additionally keeps every object, layer group,
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

## Editor usability update — 2026-09-08

The original centered floating viewport toolbar is retained, with its translucent
surface and direct Undo, Redo, Copy and Paste controls. There is no separate
workspace menu strip or Add/Edit menu. Panel visibility and editor expansion use
small icons in the existing scene header. Creation controls remain in Objects;
Objects and Inspector remain separate tabs. Plan tools appear only in Plan.

**Opening** works directly on a visible wall in 3D as well as in Plan. Choose the
type, hover for a vertical preview, click for default dimensions or drag along
the wall to set width. The wall projection respects building rotation; the
preview uses the wall's elevation and height. Existing openings reserve their
wall spans. Locked walls, rooms and buildings reject placement. Creation selects
the opening and opens Inspector for live width, height, sill and position edits.
In 3D, select a wall and use **Add door**, **Add window** or **Add opening** in
its Inspector to start placement on that wall. The Inspector shows placement
instructions and Cancel while the tool is active. Escape also cancels; successful
placement returns to Select. Preview geometry is excluded from image capture and
does not cast shadows.

Plan **Fit** frames the XZ extents without changing the export camera. Plan pan
converts screen movement to local viewport coordinates, including node graph
scaling. Grid numeric fields preserve partially typed values while updating live.
3D-only grid and rotate/scale buttons are hidden in Plan.

UI text has a stable 13 px base and an 11 px minimum for compact labels. Node
resize no longer applies an additional shrinking factor. Secondary text has
higher contrast. Narrow inspectors put sliders on a second row alongside the
exact-value workflow instead of removing sliders. These sizes are local CSS
sizes; graph zoom still scales the complete embedded editor. Expanded workspace
remains the option for prolonged editing at distant graph zoom.

Validation is limited to local JavaScript geometry/behavior tests, source checks
and the project scanner. No ComfyUI session, GPU generation, rendered layout or
interactive host verification was used for this update.

### Undo rendering

Snapshot Undo/Redo applies changed object properties directly instead of calling
the scene loader. Unchanged lighting, skydome and camera settings are not reapplied.
Architecture reconciliation retains unaffected runtime meshes; wall openings and
changed junctions rebuild only their affected walls. Structural additions/removals
and building transforms retain unrelated objects. Primitive texture changes load
only that texture, retaining the previous map until the latest request completes.
Changes to the shared architecture material registry still rebuild the architecture
portion; they do not reload scene models. Local tests cover object identity and
connected-wall junction updates. No ComfyUI runtime verification was performed.

### Selection and history controls

History updates Undo/Redo availability whenever a command is committed, undone,
redone or cleared, without requiring another object selection. Selecting rows in
Objects updates selection and Inspector content while retaining the current tab;
programmatic selection does not re-enter the viewport selection callback. A left
click on empty viewport space clears selection; camera drags retain it, including
drags which return to their starting point. Light creation belongs to the Create
grid alongside Image, Shape and Terrain.

The hidden `factory_data` input retains its native ComfyUI type. State serialization
writes its value directly without invoking an interactive host callback. Local
regressions exercise terrain creation with a stub API response, real terrain
Inspector rendering, state synchronization, list selection, empty picking and
consecutive slider commits; they do not substitute for testing on the ComfyUI host.
