# Widget interaction design

This binding interaction contract covers every existing and future interactive
widget in VNCCS-Utils: UniCanvas, Pose Studio, 3D Factory, visual camera controls,
and all other embedded editors and controls. It complements the repository rules
in [AGENTS.md](../AGENTS.md).

## Continuous motion is mandatory

Anything the user moves, resizes, rotates, paints, scrubs, or adjusts must show
the newest input continuously while the mouse, pointer, pen, touch, or key remains
held. Masks, raster and pose layers, objects, joints, cameras, viewports, gizmos,
generation bounds, panels, and timeline controls all follow this rule.

Freezing during a gesture and jumping to its final value on release are strictly
forbidden. Unrequested position jumps during interaction or commit are also
forbidden. A release must preserve the last visible position and geometry.

- Update visible runtime state from `input`, `pointermove`, or the equivalent
  continuous event. Direct manipulation must not trail behind a CSS transition.
- Coalesce expensive rendering with `requestAnimationFrame` or a bounded realtime
  cadence. Each frame uses the newest input; never queue stale intermediate values.
- If full quality is too expensive, render an immediate lightweight preview.
  Keep the last valid frame visible and reject stale asynchronous results. Final
  quality must preserve the preview's placement and geometry.
- `change`, `pointerup`, drag-end, and blur may commit pixels, persistence,
  synchronization, and one undo command. They must never supply the first visible
  update or cause the manipulated content to jump.
- Apply previews to every affected content type, including masks. Compute visible
  clipping for the preview's current position so content entering the viewport
  appears during the gesture. Other layers and controls retain their positions.
- Synchronize paired sliders and numeric fields during interaction. Update the
  affected object directly; do not reload the whole widget for each input.

## Acceptance checks

Hold the gesture through at least two different values and render each frame
before release. Verify that every frame shows the newest value, including content
moving into view from outside the viewport. Release and verify unchanged visible
placement and one undo command for the completed gesture. Confirm that unrelated
content retains its position and that generation still blocks document edits.

A control that only updates after release fails this contract and must not ship.
