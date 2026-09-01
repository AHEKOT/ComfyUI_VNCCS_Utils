# VNCCS-Utils Project Rules

These instructions apply to the entire repository and every VNCCS-Utils widget, including 3D Factory, Pose Studio, UniCanvas, Model Manager, Model Selector, and future interactive nodes.

## Realtime interaction is mandatory

Every interactive control must show its effect continuously while the user is interacting with it. The user must never have to release the mouse button, pointer, pen, or key before seeing the result.

- Sliders, numeric scrubbing, color controls, angle controls, transform gizmos, drag pads, canvas handles, timelines, terrain controls, camera controls, and similar continuous inputs must update visible state from `input`, `pointermove`, or the equivalent continuous event.
- `change`, `pointerup`, drag-end, and blur may commit undo history, persistence, synchronization, or an expensive final-quality result. They must never be the first event that updates the visible result.
- Do not debounce visible feedback until interaction ends. When frame limiting is necessary, coalesce updates with `requestAnimationFrame` or a bounded realtime cadence and always render the newest value.
- Do not reload the entire scene, widget, model, or preview for a local interactive edit when the affected runtime object can be updated directly.
- If the full operation is too expensive for every frame, show an immediate lightweight preview or lower-detail approximation during interaction, then replace it with the final-quality result after interaction ends.
- Keep the last valid frame visible while a newer preview is being prepared. Do not flash black, empty, stale, or loading-only output during continuous manipulation.
- Cancel or ignore stale asynchronous results. The newest control value always wins.
- Exact numeric fields and their paired sliders must remain synchronized during interaction.
- Undo history should normally create one command per completed gesture, even though the viewport and UI update continuously throughout that gesture.

Any implementation that only reveals a slider or drag result on release is a bug and must not be shipped.

