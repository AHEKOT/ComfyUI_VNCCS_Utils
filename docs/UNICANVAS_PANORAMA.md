# UniCanvas panorama mode

Import a full **360 × 180° equirectangular image**, normally in a 2:1 aspect ratio.
Images with width/height at least 1.9 trigger an import question. Choose
**Panorama**, **Regular image**, or **Cancel**. Use the regular image import
button. Aspect ratio is only
a hint: an ordinary wide photo does not contain a complete spherical scene.
Cubemaps and partial/cylindrical panoramas require conversion before import.

## Editing and navigation

- The square bbox is a 1024 × 1024 perspective editing window. The document
  retains the panorama's full dimensions. Inference scale still controls
  generation resolution independently of the editing window.
- The compact sphere control rotates the view directly: drag inside the sphere
  for heading/elevation, drag its outer ring for roll, and scroll over it to change
  the field of view. All three rotation axes update during the gesture. The
  regular pan and zoom controls still navigate the editor.
- With the sphere focused, arrow keys rotate heading/elevation, Q/E change roll,
  and +/- change field of view. Hold Shift for smaller keyboard increments.
- Select the normal brush, eraser, mask, shape, move, resize/perspective, or SAM
  tools to edit the visible part of a layer. Edits are transferred to spherical
  coordinates, including across the left/right seam and around the poles.
  Finish an edit or apply/cancel a transform before changing the camera.
- The original panorama remains at the bottom, initially locked. Select an
  editable layer above it, or unlock the base to edit its visible region. The
  base cannot be placed above other layers while panorama mode is active.
- Delete the original panorama layer to exit panorama mode. A confirmation warns
  that the entire panorama workspace will be permanently discarded, including
  all layers, staged results, and undo/redo history. Cancel keeps it intact;
  **Delete panorama** opens an empty regular canvas. There is no separate exit
  button, and the deleted workspace cannot be restored through Undo.
- Further image imports become overlays anchored to the current view. Existing
  layers in a flat document are fitted together into the initial panorama view
  when the mode is enabled. Undo can restore that original flat document.
- A generation result remembers the camera used for its request, so rotating
  while it runs does not change where it is previewed or accepted. SAM prompts
  belong to the current view and are cleared when navigation begins; a late SAM
  response from an old view is ignored.
- Flattening combines visible raster layers into a panorama layer and retains
  the original base underneath, hidden. Undo restores the previous layers.

## Export and saved workflows

The standard **Export layers as PSD** action and the node's **IMAGE** output
always use the complete equirectangular document. The camera and square bbox do
not crop the output. No additional panorama export button is added. Masks remain editing aids and are not included in the
composite image. PSD keeps visible raster layers in full panorama coordinates.

Panoramas use version 3 of `unicanvas_state`, with spherical layer pixels stored
through the existing ComfyUI state cache. Older versions 1 and 2 retain flat
canvas behavior. Before queue execution, the latest panorama pixels are committed
and their upload is awaited; a failed upload stops queueing to prevent exporting
stale content. Workflows continue to depend on their ComfyUI host's state cache.

## Limits and verification

- WebGL 2 is required. Images are limited to 8192 pixels per side and
  33,554,432 pixels total (including a standard 8192 × 4096 panorama), subject to
  the GPU's texture limit. Existing upload/cache size limits also apply.
- Navigation uses a reduced-resolution preview during a gesture and restores
  full editing-window quality on completion. It never resamples the stored
  panorama. Imported overlays and generated patches use up to a 4096-pixel
  square when transferred to the sphere; brush edits use the editing window.
- Large panoramas require substantial CPU/GPU memory. Pixel history is bounded
  by memory as well as the normal gesture limit; older history may be evicted.
- Automated tests cover coordinate round trips, seams, poles, erasure,
  unchanged-pixel preservation, live control events, history, generation camera
  capture, cache restoration, queue synchronization, and full-image export.
  On macOS the production shader is also tested using native OpenGL without a
  browser (only its GLSL version/precision declarations are adapted).
- Final layout, pen/mouse interaction, actual model generation, and WebGL
  behavior must be checked in the real ComfyUI installation. A useful acceptance
  check is to paint across the seam, turn through 360°, undo/redo, generate while
  looking elsewhere, save/reopen the workflow, and export PNG/PSD/IMAGE.
