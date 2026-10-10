# UniCanvas documents

## Accepted architecture decisions

Unaccepted generation results are transient staging, not document content. They
are never saved in canvas JSON, state caches, workflows, or the document catalog.
Switching documents discards staging only after an explicit confirmation.

Generation blocks editing for its entire asynchronous lifetime, including request
preparation. Settings, layers, masks, pose controls, tools, viewport navigation,
imports, undo/redo, and document management cannot change during generation.
Progress and Stop remain available. Cancellation unlocks editing only after the
request settles. Async editing callbacks started earlier cannot apply during this
interval. The generation's own request preparation and result handoff are internal
operations, not user edits.

## Storage and lifecycle

Each canvas has a stable `canvas_id`, a name, and a pointer to its current
`state_id`. Existing durable UniCanvas caches hold layers, masks, poses,
references, generation settings, bounds, and panorama data. The flattened output
uses the existing `${state_id}_out` convention. Model weights remain shared.

Every canvas has at least one mask layer. Deleting the last mask immediately
creates a blank replacement in the same undo step. New canvases, legacy document
restoration, history restoration, and flattening preserve this invariant. The
Masks section's header contains the Add mask layer icon.

Small document manifests live alongside the existing state cache. Listing canvases
does not decode their images. Atomic writes, backups, and owner checks protect
manifests. The existing standalone cache is registered without moving or replacing
its bytes. Browser storage remembers only the active document pointer; the server
also remembers the last standalone selection for browsers without storage.

The toolbar centers the canvas manager, with a New canvas icon immediately to its
right. Names are set during creation and can be changed through Rename. Each
manager card reports disk bytes for its owned state snapshots and output caches,
including retained workflow snapshots and legacy copies. The tooltip also shows
the current snapshot's size and saved snapshot count. Sizes use file metadata,
without decoding images; document manifests, model weights, RAM, and transient
generation results are excluded.

Creating a document saves the current one and allocates a new cache. Switching
waits for acknowledged saves, prepares the target before replacing the viewport,
and retains the current document on failure. Only one document is rendered at a
time. Undo/redo and viewport position are per-document session state and are not
persisted across browser restarts. Staging is cleared when switching.

Saved workflows retain their immutable cache snapshots. Every changed managed
document, including standalone canvases, saves a new snapshot and advances its
current pointer. Retired snapshot IDs remain owned by their original document.
Concurrent or stale writers cannot replace another document's latest pointer. Deleting a document
leaves a tombstone and retains cache snapshots, so old workflows remain readable
and late callbacks cannot recreate the deleted catalog entry.

## Verification

Cover A/B/A switching, empty documents, panorama, staging exclusion, independent
history, old standalone and workflow restoration, reload during saves, failed
storage/restoration, stale writers, deleted documents, and generation blocking
through pointer, keyboard, input, and asynchronous editing paths.
