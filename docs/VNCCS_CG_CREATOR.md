# VNCCS CG Creator

`VNCCS_CGCreator` is the standalone model and CG stage in VNCCS-Utils. It has one
workspace: saved background sources and TripoSplat controls on the left, the raw
splat camera viewport in the center, and completed CG cards on the right. It has
no background-generation stage, image uploads, wizard, scene creation/deletion,
or generation-model selector. Background authoring remains in the main VNCCS
package; existing saved source files are usable without importing that package.

1. Select a saved background and source image. Refresh library discovers new
   backgrounds saved by the main package.
2. Create its model with TripoSplat. It shares 3D Factory's model setup. The entire
   background is retained; a new reconstruction appends an immutable model variant.
3. Drag to look, middle-drag to pan and scroll to move. FOV updates continuously.
   The working source camera uses FOV 60 with a closer distance preserving the
   predicted image-plane framing. Recenter restores that view. Existing CG and
   authored workflow cameras keep their exact coordinates.
4. Save view captures the camera and selected aspect ratio, runs QI2 refinement,
   and saves the finished image, raw frame, model reference and camera. CG settings
   are independent of the background generator's model and settings.
5. Select a finished CG before running the workflow. The node's IMAGE output reads
   that saved result; it never starts reconstruction or emits an arbitrary camera.

The new node is registered under `VNCCS/3D` as **VNCCS CG Creator**. Its hidden
`cg_data` string preserves workflow state and has no connection to the main
Background Creator's `background_data`. Utils does not register the old identifier
`VNCCS_BackgroundCreator`, avoiding a collision with the main package. Existing
background workflows remain owned by that package; add the new CG Creator node
and select the same saved scene to continue camera work.

Sources and results retain the shared layout:

```text
output/VNCCS/scenes/NAME/
  NAME.json
  NAME.json.backup
  background/<source_id>.png
  model/<model_id>/scene.json
  model/<model_id>/objects/...
  CG/<cg_name>/<cg_id>/{raw.png,image.png}
```

Each model and CG records its exact `source_image_id`; each CG also pins its
`model_id`. JSON writes preserve the background editor, generated sets, variant
cards, generator settings and unknown metadata. Only `model_settings`,
`cg_settings`, model/CG records and revision change. Atomic writes, validated
backups and revision conflicts protect existing libraries. A recovered backup is
read-only. Earlier split libraries are copied without deleting originals.

When the main Background Creator is installed in the same ComfyUI process, CG
Creator shares its existing library and inference locks. No main-package import
is required; an absent main package does not disable existing-library editing.
Revisions reject a result if another editor changes the scene during inference.

Automated checks cover node registration/output, source ownership, data
preservation, storage conflicts, refinement requests, cancellation and widget
lifecycle. The browser harness in `tests/browser/cg_creator.mjs`, adapted from
VNCCS's Background Creator harness, runs the actual extension and Gaussian
viewport against local fixtures. It covers wide/compact layout, continuous
camera controls, saved CG restoration, settings, capture progress, empty state
and read-only recovery. It saves current After images and geometry under
`tests/e2e/evidence/cg-creator/` and requires no running ComfyUI or model downloads.
Run it with `npm run cg-creator` from `tests/e2e` after installing that suite's
existing Playwright dependency and Chromium. Show the relevant After image in
chat after each UI change; fixtures are not proof of GPU inference or ComfyUI
graph integration. Those checks still require the actual ComfyUI installation.
Hard-reload after updating frontend files there.
