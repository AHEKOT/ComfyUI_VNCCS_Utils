# Backend ownership after the API audit

The old `api/` directory was a backend catch-all: 10 files, 11,572 lines, and 81
registered HTTP endpoints. Most of its code did not handle HTTP. Generation,
geometry, scene normalization, package storage, and node execution dependencies
belong with the feature that owns them.

`api/` now contains HTTP request validation, response construction, route
registration, and orchestration of feature services. These are inbound ComfyUI
endpoints, rather than calls to a remote API. Remote repository operations and
model execution live in feature services.

## API module names

- `factory3d_scene_editor.py`: scene and object editing, imports/exports, previews,
  generation jobs, model availability/weights, and editor SPLAT cache settings.
- `factory3d_conditioning_captures.py`: conditioning capture upload, publication,
  status, and error reporting.
- `factory3d_library.py`: 3D model library items and repositories.
- `pose_library.py`: pose/animation library items and repositories.
- `pose_capture_sync.py`: browser capture synchronization for graph execution,
  including the historical debug-route alias.
- `pose_unicanvas_caches.py`: Pose capture/animation and UniCanvas state cache
  uploads/reads, plus the canvas build identity endpoint.

Filename changes affect internal Python imports only. HTTP URLs, registration
order, node identifiers, data formats, and storage locations remain unchanged.

## Complete ownership map

| Original module | What it actually did | Current owner |
| --- | --- | --- |
| `api/factory3d.py` | HTTP routes, scene/assets/exports, jobs and model execution | HTTP in `api/factory3d_scene_editor.py`; scene/assets/exports in `nodes/factory3d/storage.py`; jobs/model execution in `nodes/factory3d/runtime.py`; shared lock/job registry in `nodes/factory3d/state.py` |
| `api/factory3d_generation.py` | Native ComfyUI mesh generator integration; no HTTP routes | `nodes/factory3d/generation.py` |
| `api/factory3d_schema.py` | Pure scene normalization and validation | `nodes/factory3d/schema.py` |
| `api/factory3d_migrations.py` | Pure schema 11-to-12 migration | `nodes/factory3d/migrations.py` |
| `api/gaussian_scene.py` | PLY/SPLAT validation, transformations and export | `nodes/factory3d/gaussian_scene.py` |
| `api/factory3d_conditioning.py` | Immutable captures and four HTTP endpoints | Services in `nodes/factory3d/conditioning.py`; handlers remain in `api/factory3d_conditioning_captures.py` |
| `api/factory3d_library.py` | Asset packages, repository synchronization and 15 HTTP endpoints | Services in `nodes/factory3d/library.py`; handlers remain in `api/factory3d_library.py` |
| `api/pose_library.py` | Pose/animation storage, previews, repository synchronization, shared config/progress and 13 HTTP endpoints | Library services in `nodes/posestudio/library.py`; shared config/progress in `nodes/shared/`; handlers remain in `api/pose_library.py` |
| `api/runtime_caches.py` | Pose capture/animation caches, canvas state cache, build identity and seven HTTP endpoints | Pose services in `nodes/posestudio/caches.py`; canvas persistence in `nodes/unicanvas/cache.py`; build identity in `nodes/unicanvas/build_info.py`; handlers remain in `api/pose_unicanvas_caches.py` |
| `api/pose_sync.py` | Two names for one browser-capture upload handler | Remains in `api/pose_capture_sync.py`: its bounded atomic upload is specific to the HTTP synchronization boundary |

Factory graph classes now live in `nodes/factory3d/node.py` and
`nodes/factory3d/render.py`. The package exports `VNCCS_3DFactory`; the extension
entry point retains all existing node class and display-name mappings. Graph
nodes import their feature services directly. Service modules do not import
`api/` or `aiohttp`.

Shared paths, user configuration, and repository progress have no dependency on
Pose Library. Factory no longer reaches shared services through Pose Library
wrappers. UniCanvas HTTP upload, state restoration, and ComfyUI output-cache
invalidation use the same cache location and ID normalization implementation.

## Corrections included in the audit

- Gaussian positions now use the same intrinsic XYZ rotation order as the
  quaternion/covariance calculation and Three.js viewport. Export format version
  9 invalidates derived PLY exports created with the old rotation order.
- Reference replacement stages source and preview under a unique reference
  directory, commits the scene manifest, then retires old files. Preview or
  manifest write failures leave the previous reference usable. Existing legacy
  reference paths remain readable; HTTP reference URLs are unchanged.
- An explicit empty `building_id` remains scene-root ownership after reload,
  including when the scene contains buildings. Unknown/missing ownership retains
  the existing fallback behavior.
- Factory scene loading, image validation, capability inspection, and package
  lookup/migration run in worker threads. Pose file transactions and preview
  decoding also run outside the HTTP event loop. A save lock keeps the name
  collision check and file commit together, preserving the previous `409`
  response when concurrent requests try to create the same pose.
- Removed unused local publishing/manifest helpers, unused config writers,
  `json_bytes`, and the unused Factory registration alias. Publishing endpoints
  still return the existing security-policy denial.

## Compatibility and verification

The 81 endpoint method/path pairs are captured from the original implementation
in `tests/fixtures/api/routes.json`. `tests/test_api_routes.py` registers the actual
handlers and checks the complete contract, storage-root resolution, and worker
thread execution for scene/package reads.

`PoseLibrary/`, `ModelLibrary/`, ComfyUI output/model directories, durable user
caches, the legacy temporary-cache fallback, and `vnccs_user_config.json` keep their
existing locations. No workflow schema or node identifier was changed. Internal
Python module paths moved; callers should import the owning service instead of
using an API module as a backend facade.

Regression tests cover compound rotations, failed reference writes, explicit
scene-root ownership, failed library/cache persistence, legacy cache migration,
node serialization, and render-cache invalidation. Run the mandatory security
scan and scanner integrity test, the Python CI suite in an environment without
PyTorch, the available tensor tests separately, and `node --test tests/*.mjs`.
Real ComfyUI/GPU execution remains a runtime verification step.

Validation on the final implementation (Python 3.14.6):

- Security scan passed; scanner integrity passed all 10 checks.
- Full local Python suite: 703 passed, 11 skipped, 134 subtests passed.
- Isolated lightweight CI dependencies with PyTorch verified absent: collection
  succeeded; 534 passed, 21 skipped, 134 subtests passed. CI's Python 3.11 was not
  available on this host.
- JavaScript suite: 727 passed, one skipped.
- The route-contract test covers all 81 original method/path pairs; structural
  comparison confirmed unchanged schema, migration, and generation code.
- No live ComfyUI, GPU generation, or browser/E2E run was performed. Restart
  ComfyUI after updating to load the relocated Python modules.
