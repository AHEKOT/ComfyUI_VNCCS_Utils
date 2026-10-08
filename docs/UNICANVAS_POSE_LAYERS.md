# UniCanvas Pose Studio layers

The mannequin icon in the vertical tool rail creates a live Pose Studio layer inside the current generation bbox and opens it in the pose editor. With a pose layer selected, the same icon edits that layer instead. Select a raster layer before using the tool to create another independent pose layer; Pose Studio's own Characters section can also manage multiple mannequins in one scene.

## Edit session

A pose layer is edited only in an explicit session, so outside of it the layer behaves like any other image layer: selecting it only selects it, the Move tool drags it (the live scene keeps the moved placement), it reorders, hides, locks and duplicates, and a plain right click on the canvas opens its layer menu. Enter the session with the Pose tool, **Edit pose** in the layer menu, the pose button in the layer row, or a double-click on the pose layer in the canvas.

While editing:

- the right sidebar (denoise, masks, layers) is replaced by the pose settings: the **Character reference** section, then the Pose Studio **Body** and **Scene** pages;
- the 3D viewport covers the whole stage, not just the generation box, and the capture framing lands exactly on the pose rectangle inside it (so nothing moves on entry and the camera can look at the mannequin anywhere); a bar at the bottom of the canvas lists the viewport controls (left: joints, right-drag: orbit, middle: pan, wheel: zoom) with **Pose Library**, **Cancel** and **Save pose**;
- UniCanvas undo/redo is paused (Pose Studio's own undo works inside the editor).

The embedded camera is a free 3D **inspection** view: orbit, pan and wheel zoom let a hand or joint be examined from any side and never change the layer. The layers below the pose stand in the scene as a flat **wall** aligned with the capture framing, so the mannequin can be placed in front of them, posed close up and rotated while its place in the image stays exact. The wall is drawn by the 3D view in place of those layers while editing; a character can be moved toward the camera but not behind the wall.

**Placing the mannequin:** drag the torso (the body itself, not a joint dot) to move it in the plane of the wall; hold **Shift** while dragging to move it toward or away from the wall (drag up = away). While dragging, an indicator beside the pointer shows the controlled axes: four arrows for the wall plane, a slanted arrow with **Z** for depth. Joint dots, limbs and the camera controls keep their behavior. The bar's eye button hides the wall and **Reset camera** returns the editing camera to the capture framing.

**Save pose** (also Enter or Esc outside a text field) keeps the pose and records the whole session as one undo step; **Cancel** restores the pose and pixels from before the session. Selecting another tool or layer saves as well.

## Editor

The host imports `PoseStudioWidget` from `web/vnccs_pose_studio.js`. It mounts the actual Body and Scene controls in the right sidebar for the duration of the edit session. The standard UniCanvas model, prompt, settings and Generate panel stays visible and interactive. There are no Poses or Character tabs. No rig, morph, IK, hand, library, lighting or prompt implementation is copied into UniCanvas. The original Pose Library button is in Scene. The shared central action toolbar stays hidden. Pose Library dialogs rise above the UniCanvas toolbox and other controls.

Only the active Pose tool shows its controls and viewport handles. The panels stay mounted when hidden, preserving expanded groups, drafts and scrolling. Body and hand changes update the layer during interaction; camera navigation does not - it only moves the inspection view. The layer can be moved, reordered, hidden, locked, duplicated and deleted. Pixel painting and destructive image transforms require a raster layer; use the shared Pose Studio controls to edit a live scene. Pose Studio output dimensions resize the live layer and, when still aligned, its bbox. Animation scenes retain their tracks; UniCanvas uses the currently selected frame for a still-image generation.

## Capture framing

The capture framing (`pose.viewport`, persisted) is the camera the layer pixels are rendered with and the camera the wall is aligned to. It is seeded from the Pose Studio export camera (aimed at the torso for new layers) and changes only through the **Scene** camera sliders - never through navigation. The layer pixels are not limited to the generation box: the baked region grows (within one box size) to hold the whole mannequin. Generate, PSD export and the composite always see the framing.

The hand control popover (spread/grasp/finger sliders and presets) mounts inside the embedded viewport - the hidden Pose Studio center panel does not host it there - so hands stay directly editable: click a hand to open its sliders, or drag the visible finger-joint markers when the popover mode is switched off in Pose Studio settings.

The canvas displays a transparent rendering. A separate transparent WebGL overlay contains only interaction handles, so image layers above the pose still cover it correctly. Normal canvas composition, node output and **Export Layers as PSD** include the pose's rendered pixels. PSD carries the image layer; the editable 3D scene remains in the UniCanvas workflow/cache.

## Character reference and inference

The **Character reference** section at the top of the editing sidebar has a preview, a layer picker, Upload image and Clear, and says when a reference is still needed. It accepts an image file or an existing image layer. Generate with a missing reference opens the pose editor, highlights this section and explains the missing reference before any inference request is sent. Uploaded references are fitted into the reference canvas. A selected visible lower layer is already part of the reference and is included once. Other selected layers are fitted from their full content bounds, even when their canvas position is outside the bbox.

To generate, adjust the mannequin, choose its character reference, select Klein9b in the standard model panel and press the normal Generate button without leaving the Pose tool. The model receives exactly two images:

1. **image1:** the pose rendering in the bbox, composited over Pose Studio's solid background color.
2. **image2:** the lower visible image layers, composited bottom-to-top, plus the selected character reference. Uncovered pixels are white.

A file with an opaque background can cover the lower composite within its fitted rectangle. Use a transparent character image when the underlying scene must remain visible there.

The prompt is produced by Pose Studio's existing `generatePromptFromLights` method and template. The selected pose prompt and UniCanvas prompt fill `<user_prompt>`; lights fill `<lighting>`. The default character reference remains `image2`. There is no third reference image.

Pose generation uses full denoising. Klein9b appends both reference latents in the same order to positive and negative conditioning using its existing node pipeline. Normal image editing retains its previous reference path. A visible pose layer requires a compatible model; hide it to use other UniCanvas models.

## Persistence and lifecycle

Each `type: "pose"` layer includes a `pose` object containing the Pose Studio scene schema, the capture-framing camera (`viewport`), the world rectangle and the character selection. Workflow metadata excludes uploaded character pixels; the existing UniCanvas state cache stores them with preview pixels. Existing animation cache references remain owned by Pose Studio. Static poses do not serialize the internal default timeline as an animation. In image mode, existing compact animation references are preserved without requesting the animation cache; switching to animation mode restores them on demand.

Queue execution waits for the active scene's model/morph work and state upload. Stale initialization or capture work cannot replace another layer. Removing the editor uses Pose Studio's shared `dispose()` method to release workers, renderer, observers, timers and listeners. Older raster/mask workflows keep their schema and behavior.

In panorama mode a pose retains its original editing camera. Activating its tool returns to that camera; rotating the panorama leaves the Pose tool. At another viewing angle, inference uses the already projected pose pixels so the generation view does not jump. Standard PSD export continues to export the full panorama.

## Verification

The focused tests cover shared panel mounting, scroll and keyboard state, bbox geometry, realtime preview updates, transparent capture/helper restoration, asynchronous layer replacement, reference composition/order, cache metadata, both model adapters and node output. The standalone Pose Studio bootstrap and existing frontend/backend suites also cover the reused editor. Actual browser interaction and model inference must be checked on the ComfyUI host.

## Characters and panels inside UniCanvas

- **Add character** copies the active mannequin (pose, height, depth, zoom) and places it beside it, so
  two figures that interact start at the same scale.
- The Pose Studio **Camera**, **Camera Angle** and **Export Settings** sections are hidden here: the
  framing is the layer rectangle, and depth is set by dragging the torso with `Shift`.
- The Pose Library keeps the placement of the current mannequin when a pose is loaded.
