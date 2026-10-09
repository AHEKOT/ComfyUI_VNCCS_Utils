# UniCanvas and Pose Studio audit repair log

What this repo does: UniCanvas edits layered images and runs ComfyUI generation. Pose Studio edits mannequins and animation, then sends browser-rendered frames to its Python node.

The audit assumed one ComfyUI process and one user with several nodes or editor sessions. The scope was UniCanvas first, then Pose Studio, including their local persistence and sync helpers. Other nodes were not audited. Changes remain in the working tree.

## Result

The earlier seven UniCanvas findings were repaired. Follow-up reviews found further concrete failure cases, which were repaired in subsequent batches. The final review found no remaining confirmed defects in the paths inspected. This is a scoped source and regression-test conclusion, not a guarantee that every possible runtime failure has been found.

## UniCanvas repairs

| Path | Failure case | Repair and evidence |
| --- | --- | --- |
| `web/unicanvas/modes.mjs` | A standalone document larger than the browser backup limit stopped persisting. Browser quota failure also disabled further saves. | Reuse the durable server cache. Store only its pointer in browser storage; retain legacy pixels until migration succeeds. Large-document and quota regressions verify continued uploads. |
| `web/vnccs_unicanvas.js` | Flat raster Undo/Redo changed pixels without saving them. | Schedule full pixel synchronization after history application. Both directions are tested. |
| `web/vnccs_unicanvas.js`, `web/unicanvas/layer_tools.mjs` | PSD exports used byte opacity where the writer expects a fraction; hyphenated blend names fell back to normal. | Export normalized opacity and mapped blend names. Real vendored PSD write/read tests cover flat and panorama exports. |
| `nodes/unicanvas/segment.py`, `describe_layers.py` | SAM and layer-naming models retained GPU weights after requests. | Reactivate cached weights for inference and offload them in `finally` under the existing model-operation lock. Tests cover success, failure and cached reuse; no real GPU inference was performed. |
| `web/unicanvas/modes.mjs`, `web/vnccs_unicanvas.js` | A late generation or restore could populate a newly created flat document. | Invalidate pending document operations on New/restore/history replacement and reject stale generation images. Regression tests replace the document during an awaited image load. |
| `web/unicanvas/panorama.mjs` | Flat history had no byte budget; retained staging masks were not counted. | Apply the existing history budget to every document and include staging masks. Tests use a small budget to verify eviction. |
| `web/unicanvas/naming.mjs`, `prompt_enhance.mjs` | Delayed naming overwrote a manual rename or used stale pixels; prompt enhancement crossed document replacement. | Validate layer identity, pixels, name and document revision before applying results. Tests cover changed, removed and disposed targets. |
| `web/vnccs_unicanvas.js` | Failed or invalid cache restoration could later save the initial blank document over existing data. | Block persistence after failed restoration until a successful restore or deliberate New canvas. Tests cover network failure and malformed HTTP 200 payloads. |
| `api/pose_unicanvas_caches.py` | Failed disk writes published unsaved data in memory; fixed temporary filenames could collide. | Publish memory only after an atomic disk replacement succeeds; use unique temporary files and clean them on failure. Tests preserve old memory and disk data after simulated disk-full errors. |

## Pose Studio repairs

| Path | Failure case | Repair and evidence |
| --- | --- | --- |
| `web/vnccs_pose_studio.js` | Restoring server revision 100 from workflow revision 7 made edits stop uploading until revision 101. | Start the local counter at the newer revision. A restored edit is verified as upload revision 101. |
| `web/vnccs_pose_studio.js` | Ordinary SAM pose application ignored rejected uploads and did not report application errors to Python. | Validate the upload response and send token-specific errors for both SAM modes. Tests cover failed application and HTTP 413. |
| `nodes/pose_studio.py` | Failed SAM analysis, empty results or a sync timeout silently reused the old pose. Ordinary live sync also fell back to stale captures. | Stop execution with an explicit error. Align backend waiting with frontend scene-readiness time. Tests verify inference failure and timeout rejection. |
| `web/vnccs_pose_studio.js` | A mid-batch capture failure left the editor on another pose with changed lighting; null captures produced partial batches. | Restore the original scene in `finally`, roll back incomplete captures and require valid execution frames. Tests cover thrown and null capture failures. |
| `web/pose_studio/core.js` | Capture setup failed before cleanup started, leaving helpers hidden and renderer state changed. | Include capture setup inside the existing protected block. A failing renderer resize regression verifies restoration. |
| `api/pose_capture_sync.py`, `nodes/pose_studio.py` | A partial sync-file write destroyed the previous capture; reader and writer disagreed on long or unsafe node IDs. | Atomic replacement and identical normalization of the combined node ID/token. Tests cover partial-write failure and sanitized IDs. |
| `api/pose_unicanvas_caches.py` | Failed animation writes replaced the good in-memory cache before disk persistence succeeded. | Persist first, then publish, using the same atomic-file protection as UniCanvas. Disk-full regressions verify old animation data survives. |
| `nodes/pose_studio.py`, `web/vnccs_pose_studio.js` | Hundreds of highly compressible large frames could exhaust memory; empty frames were silently dropped. | Enforce a 64 Mi-pixel aggregate budget and reject incomplete sequences. Frontend rejects oversized execution captures before rendering. Tiny fixture images verify the backend budget without large allocation. |
| `web/pose_studio/text_to_motion.mjs` | Cancelling retargeting did not stop its background frame loop; it could overwrite later edits or a reopened panel. | Guard retargeting and completion by session identity. A cancel/edit/reopen regression verifies the new pose survives. |
| `web/vnccs_pose_studio.js` | A failed manager preview refresh kept old pixels but marked the new generation ready for RUN. | Preserve visible cards, record the failure and reject execution readiness until a fresh generation succeeds. A null-capture regression verifies this contract. |

## Validation

- Mandatory security scan passed; scanner integrity: **10 passed**.
- Full JavaScript CI command: **634 passed, 1 skipped, 0 failed**. The skipped DOM bootstrap test requires VM modules; it was run separately with `--experimental-vm-modules`: **1 passed**.
- Final cache-response protection was added after the full JavaScript run; its state-restoration file was rerun: **11 passed**.
- Isolated environment with the CI dependencies and verified absence of PyTorch: **502 passed, 17 skipped, 129 subtests passed**.
- Local environment with PyTorch installed: **632 passed, 8 skipped, 129 subtests passed**. No SAM3D test failures remain in that run.
- `git diff --check` passed. Frontend import versions were refreshed for both widgets.

Commands used for the full checks:

```sh
python3 scripts/security_scan.py
python3 -m pytest -q tests/test_security_scan.py
node --test tests/*.mjs
node --experimental-vm-modules --test tests/test_pose_widget_bootstrap.mjs
PYTHONPATH=. python -m pytest tests -q -p no:cacheprovider --ignore=tests/test_security_scan.py --ignore=tests/e2e
```

The Python command ran once in each dependency environment. Existing optional-runtime skips remain; no new skips, xfails, scanner exceptions or test exclusions were added. Existing non-failing warnings concern a vendored docstring escape and a 3D Factory test helper class, outside the audited nodes.

## Limits

No live ComfyUI browser E2E, actual model downloads, full-weight inference or GPU memory measurement was performed. Automated geometry tests use the real vendored Three.js scene with controlled DOM/rendering fixtures. Multi-process server writes and visual quality under real GPU inference remain unverified.

The capture budget is an intentional behavior change: large sequences now fail with an instruction to reduce resolution or frame count. Older workflow formats, model adapters and node interfaces retain their existing contracts.
