# UniCanvas Pose Studio layers

The mannequin icon in the vertical tool rail creates a live Pose Studio layer inside the current generation bbox. Selecting an existing pose layer automatically activates the Pose tool and reopens its scene, including when clicking the already selected layer after using another tool. Switching to an ordinary image layer leaves the Pose tool. Duplicating a pose or restoring its selection through undo or workflow loading also reopens its editor. Select a raster layer before using the tool to create another independent pose layer; Pose Studio's own Characters section can also manage multiple mannequins in one scene.

## Editor

The host imports `PoseStudioWidget` from `web/vnccs_pose_studio.js`. It mounts the actual Body and Scene controls in a collapsible inspector at the right edge of the canvas. The standard UniCanvas model, prompt, settings and Generate panel stays visible and interactive. There are no Poses or Character tabs. No rig, morph, IK, hand, library, lighting or prompt implementation is copied into UniCanvas. The original Pose Library button is in Scene. The shared central action toolbar stays hidden. Pose Library dialogs rise above the UniCanvas toolbox and other controls.

Only the active Pose tool shows its controls and viewport handles. The panels stay mounted when hidden, preserving expanded groups, drafts and scrolling. Body and hand changes, camera navigation and lighting update the layer during interaction. The layer can be moved, reordered, hidden, locked, duplicated and deleted. Pixel painting and destructive image transforms require a raster layer; use the shared Pose Studio controls to edit a live scene. Pose Studio output dimensions resize the live layer and, when still aligned, its bbox. Animation scenes retain their tracks; UniCanvas uses the currently selected frame for a still-image generation.

The canvas displays a transparent rendering. A separate transparent WebGL overlay contains only interaction handles, so image layers above the pose still cover it correctly. Normal canvas composition, node output and **Export Layers as PSD** include the pose's rendered pixels. PSD carries the image layer; the editable 3D scene remains in the UniCanvas workflow/cache.

## Character reference and inference

The Character button at the lower right of the canvas opens a reference card with a preview, layer picker, Upload image and Clear. It closes on Escape, outside press or leaving the Pose tool. It accepts an image file or an existing image layer. Selecting a pose without a valid character reference opens this card automatically. Generate brings the user back to this selection and explains the missing reference before any inference request is sent. Uploaded references are fitted into the reference canvas. A selected visible lower layer is already part of the reference and is included once. Other selected layers are fitted from their full content bounds, even when their canvas position is outside the bbox.

To generate, adjust the mannequin, choose its character reference, select QiE2511 or Klein9b in the standard model panel and press the normal Generate button without leaving the Pose tool. Both models receive exactly two images:

1. **image1:** the pose rendering in the bbox, composited over Pose Studio's solid background color.
2. **image2:** the lower visible image layers, composited bottom-to-top, plus the selected character reference. Uncovered pixels are white.

A file with an opaque background can cover the lower composite within its fitted rectangle. Use a transparent character image when the underlying scene must remain visible there.

The prompt is produced by Pose Studio's existing `generatePromptFromLights` method and template. The selected pose prompt and UniCanvas prompt fill `<user_prompt>`; lights fill `<lighting>`. The default character reference remains `image2`. There is no third reference image.

Pose generation uses full denoising. QiE2511 encodes both images as ordered visual/text and VAE references. Klein9b appends both reference latents in the same order to positive and negative conditioning using its existing node pipeline. Normal image editing retains its previous reference path. A visible pose layer requires a compatible model; hide it to use other UniCanvas models.

## Persistence and lifecycle

Each `type: "pose"` layer includes a `pose` object containing the Pose Studio scene schema, viewport camera, world rectangle and character selection. Workflow metadata excludes uploaded character pixels; the existing UniCanvas state cache stores them with preview pixels. Existing animation cache references remain owned by Pose Studio. Static poses do not serialize the internal default timeline as an animation. In image mode, existing compact animation references are preserved without requesting the animation cache; switching to animation mode restores them on demand.

Queue execution waits for the active scene's model/morph work and state upload. Stale initialization or capture work cannot replace another layer. Removing the editor uses Pose Studio's shared `dispose()` method to release workers, renderer, observers, timers and listeners. Older raster/mask workflows keep their schema and behavior.

In panorama mode a pose retains its original editing camera. Activating its tool returns to that camera; rotating the panorama leaves the Pose tool. At another viewing angle, inference uses the already projected pose pixels so the generation view does not jump. Standard PSD export continues to export the full panorama.

## Verification

The focused tests cover shared panel mounting, scroll and keyboard state, bbox geometry, realtime preview updates, transparent capture/helper restoration, asynchronous layer replacement, reference composition/order, cache metadata, both model adapters and node output. The standalone Pose Studio bootstrap and existing frontend/backend suites also cover the reused editor. Actual browser interaction and model inference must be checked on the ComfyUI host.
