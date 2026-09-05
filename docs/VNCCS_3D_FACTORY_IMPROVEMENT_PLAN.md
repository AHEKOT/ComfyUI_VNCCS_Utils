# VNCCS 3D Factory: scene editor implementation plan

Status: implementation started; the specification below remains the target unless explicitly marked complete in the progress record.

Prepared: 2026-09-05. Baseline commit: `60bbc4577977a3cdbd502306bd58aa4ab1458b3a`.

Scope: `ComfyUI_VNCCS_Utils`, exclusively the 3D Factory feature and additive Factory-specific nodes. This plan permits a complete replacement of the Factory UI shell. Preserve existing scene assets, generation providers, working imports, node identity, workflow connections, and unrelated VNCCS utilities.

Document language follows the project's English documentation convention. Product labels below are implementation-ready English labels. All new paths, types, endpoints, and identifiers marked as proposed are specifications, not claims that they already exist.

### Implementation progress — 2026-09-05

Implementation is in progress, not a completed release. The user's current validation constraint is explicit: do not open, operate, or test against ComfyUI; do not generate models on the development Mac. Validation below is local code/math/storage testing only.

| Work package | Current implementation | Remaining acceptance work |
|---|---|---|
| WP01 Baseline defects | Architecture-only capture eligibility; retained local lights; illumination remains active beyond 2/4/6/8 shadow slots; allocation status in scene list and Inspector | Runtime instrumentation and device evidence remain outside current validation scope |
| WP02 Contracts/migrations | Editor 17→18 pure migration; future editor versions rejected by UI and node; scene 11→12 copy upgrade with preserved original assets; shared light numeric contracts | Full ID-domain fixtures, transform-v2 migration and capture-v2 contracts |
| WP03 Transactions/store | Typed scalar patches for light, model transform, primitive geometry and wall dimensions; coupled camera-pose patches; one undo per gesture; cancel; bounded mixed history; frozen save payload and scene ownership; preserve edits during primitive creation | General store extraction, optimistic backend transactions, immutable capture barriers |
| WP04 Runtime | Local light identity retained across value edits; primitive geometry replaced on its existing mesh; geometry-only edits avoid transform work; no full scene load for these previews | General resource cache, scheduler, shadow invalidation and worker services |
| WP05 Controls | Descriptor-driven exact/range fields, units (`m`, `cm`, `mm`, `km`, degrees/radians), relative expressions, invalid-draft handling, label scrubbing, reset, keyboard stepping, Escape and pointer cancellation | Port remaining legacy control families; group reset/mixed multi-edit; rendered alignment acceptance |
| WP06 Workspace | Resizable docks, separate Objects/Inspector tabs, six layouts, expanded editor retaining the same canvas/store, narrow drawers, dock fit/reset, command search, modal focus repair | Full menu/status/bottom-dock design, final outliner integration and host visual acceptance |
| WP09 Cameras | Actual YXZ quaternion/Euler conversion; position/rotation/FOV/target-distance numeric gestures; selecting/editing a saved camera does not enter its viewpoint | Physical lens/shift/orthographic fields, reference roles, perspective calibration and shot data |
| WP10 Indoor topology | Existing rectangular room workflow retained; polygon room drawing with live outline/fill, close-at-first-point/Enter, remove-point/Backspace and Escape; simple-contour validation; linked walls/floor/ceiling in one command | General wall joins/opening assemblies, floor holes, building-local hierarchy migration and full parametric architecture |
| WP13 Surface placement | Primitive support tests actual upward triangles clipped to the selected footprint, including transformed ramps, stairs and terrain | Pivot modes, normal alignment, mesh/splat transform-v2 semantics and full snapping |
| WP11 / WP13 Parametric parts | Editable box, ellipsoid, cylinder, cone, ramp, solid stairs and solid gable-roof wedge; bounded topology, physical dimensions, stair tread/riser readout, Shape menu and command access | Ghost placement, assemblies/railings/roof thickness, spline profiles and material slots |
| WP14 Terrain | Deterministic procedural relief, seed/frequency/octaves/amplitude, bounded grid up to 128×128 cells, base/skirt, triangle-consistent sampling; zero amplitude preserves old flat geometry | This is a recipe foundation, not tiled sculpt terrain: Float32 tile assets, brushes, heightmap I/O, holes, paint layers, workers and LOD remain |
| WP20 Packages | Native primitive recipes do not require PLY; scene/object packages include/remap primitive textures; v12 scene loading preserves its version; new-only object loading upgrades a scene copy | Full native-v2 dependencies, geometry GLB/coverage export, conditioning ZIP and broader cold round trips |
| WP07–08, WP12, WP15–19, WP21–22 | Existing capabilities retained; remaining work as specified below | Unified virtualized hierarchy, conditioning outputs, scatter/splines, advanced lighting/materials/assets, large scenes, variants/render host and release gates |

#### Implemented boundaries and compatibility

- `core/editor_migrations.mjs` changes UI metadata only. `api/factory3d_migrations.py` and the equivalent JS migration preserve existing geometry/transforms. Scene 12 currently explicitly declares `{transforms:1,captures:1,procedural_geometry:1}`. This is a staged schema activation: do not interpret version 12 alone as the complete transform/capture-v2 specification below.
- `POST /scenes/{scene_id}/upgrade` copies scene assets to a new managed ID, saves the migrated document there and preserves the v11 original. Failed copying/saving removes only the new directory. Reference URLs are rebound to the copied scene. New geometry cannot be written into scene 11; scene-12 PATCH requests require a matching writer version.
- `property_descriptors.mjs`, `property_gesture.mjs` and `numeric_property_binding.mjs` resolve entities by `{kind,id,sceneId}` and update visible runtime objects on input/pointer movement. Persistence happens after settling; Escape restores the edited property or coupled camera pose. Unfinished numeric text never coerces to zero. `+=25cm`, `*=2`, and radians are parsed without evaluation.
- `editor_commands.mjs` combines existing snapshots and new patches in one 200-command/128 MiB encoded-payload history. This bounds retained serialized commands, not total JavaScript heap. Discarding history is disclosed. Camera patches include only pose fields, not unrelated camera metadata.
- `ui/workspace.mjs` owns layout/expansion, not scene state or a second renderer. Desktop default docks are 240/300 CSS pixels; stored sizes survive responsive fitting. Expansion and layout changes preserve the scene and viewport. Objects, Inspector and Export remain mutually exclusive tabs in all layouts, including expanded mode. Panel mode changes dock sizing only. This user-requested correction supersedes the original simultaneous outliner/Inspector proposal; do not combine these panels again.
- Procedural parts are Three geometries with XZ-centered origin and base Y=0. Stairs use one closed extruded profile, not overlapping boxes. The gable roof currently represents a solid roof wedge; it is not yet an editable roof assembly. Terrain uses deterministic `value-noise-v1` lattice hashing and octave synthesis with persisted parameters, not sampled/sculpted tile assets.
- `surface_support.mjs` clips transformed upward triangles against the selected world-space XZ footprint before choosing its support height. Explicit box proxies retain their existing semantics; Gaussian placement still uses its declared proxy approximation.
- The original node output remains slot 0 `preview`, IMAGE list, current view followed by saved cameras. New conditioning nodes/passes are not registered yet. Captures use current preview lighting; deferred shadows can leak through walls. No exact Gaussian geometry pass is claimed.

Validation record: 64 focused JS geometry/transaction/frontend/light tests; 9 Python node tests; 2 Python migration/storage tests; 1 native-package test covering both scene and object packages; shared numeric normalization cases; required security scanner/integrity checks. No ComfyUI interaction, model generation, GPU benchmarks or visual acceptance is claimed. See the remaining work-package table and release gates before treating this as a release.

## Contents

- [1. Product outcome and boundaries](#1-product-outcome-and-boundaries)
- [2. Verified baseline and corrections to the initial audit](#2-verified-baseline-and-corrections-to-the-initial-audit)
- [3. Architecture decisions and technology choices](#3-architecture-decisions-and-technology-choices)
- [4. Module boundaries and extraction order](#4-module-boundaries-and-extraction-order)
- [5. State, schema and migration specification](#5-state-schema-and-migration-specification)
- [6. Realtime commands, persistence and concurrency](#6-realtime-commands-persistence-and-concurrency)
- [7. UI/UX specification: complete shell replacement](#7-uiux-specification-complete-shell-replacement)
- [8. Indoor construction algorithms](#8-indoor-construction-algorithms)
- [9. Terrain and outdoor tools](#9-terrain-and-outdoor-tools)
- [10. Precise transforms, placement and reusable geometry](#10-precise-transforms-placement-and-reusable-geometry)
- [11. Materials, imports and asset workflows](#11-materials-imports-and-asset-workflows)
- [12. Lighting and environment](#12-lighting-and-environment)
- [13. Camera matching, shots and navigation](#13-camera-matching-shots-and-navigation)
- [14. Conditioning and capture pipeline](#14-conditioning-and-capture-pipeline)
- [15. Presentation modes, variants and export](#15-presentation-modes-variants-and-export)
- [16. Performance, memory and lifecycle requirements](#16-performance-memory-and-lifecycle-requirements)
- [17. Implementation work packages and dependency order](#17-implementation-work-packages-and-dependency-order)
- [18. Traceability to the original improvement table](#18-traceability-to-the-original-improvement-table)
- [19. Test strategy and concrete acceptance cases](#19-test-strategy-and-concrete-acceptance-cases)
- [20. Validation commands and release discipline](#20-validation-commands-and-release-discipline)
- [21. Migration, rollout and rollback procedure](#21-migration-rollout-and-rollback-procedure)
- [22. Feasibility gates and fixed fallback decisions](#22-feasibility-gates-and-fixed-fallback-decisions)
- [23. First implementation iteration: exact starting checklist](#23-first-implementation-iteration-exact-starting-checklist)

## 1. Product outcome and boundaries

Build a desktop-oriented scene editor inside ComfyUI for constructing, arranging, lighting, and photographing indoor and outdoor environments. Its primary deliverable is reproducible visual conditioning for image generation: composition, occlusion, geometry, segmentation, and camera alignment. Scene authoring and useful render outputs must work without loading a generative model.

The complete workflow is:

1. Start from a scene template, import, or image reference.
2. Establish meters, ground/floor elevations, camera, and image perspective.
3. Build architectural or landscape geometry.
4. Populate with imported/generated assets and reusable modules.
5. Adjust materials, lighting, visibility, and shot-specific variants.
6. Inspect RGB and conditioning passes from the same frozen scene revision.
7. Queue consistent outputs in ComfyUI or export a portable scene package.

"Any complexity" means extensible construction tools, imported geometry as an escape hatch, spatial organization, explicit resource budgets, and graceful quality reduction. It does not promise unlimited GPU memory, infinite geometric precision, or full DCC sculpting/rigging/simulation. Overhangs and caves use imported meshes or modular geometry; the first terrain system is a heightfield. Arbitrary roof forms use mesh import when the parametric roof tool cannot represent them.

Priorities:

- **P0:** correct existing output, dependable light behavior, editor workspace, and the first end-to-end conditioning workflow.
- **P1:** complete practical indoor/outdoor authoring, precise placement, materials, reusable assets, and measurable scene scale.
- **P2:** shot variants, richer presentation, animation capture, and unattended capture with a connected render host.

## 2. Verified baseline and corrections to the initial audit

### 2.1 Existing code to preserve

| Area | Existing implementation | Action |
| --- | --- | --- |
| ComfyUI identity | `VNCCS_3DFactory`, hidden `factory_data`, `load_scene`, `VNCCS/3D` | Keep the identity and old output slot |
| Widget | `web/vnccs_3d_factory.js` | Turn into registration/lifecycle/composition adapter incrementally |
| Renderer | `web/vnccs_3d_factory_viewer.js` | Extract services behind the existing public viewer methods |
| Geometry | `web/factory3d/plan_geometry.mjs` | Reuse materials and wall/opening generation; evolve topology |
| Schema | `web/factory3d/editor_schema.mjs`, `api/factory3d_schema.py` | Add paired migrations and shared validation fixtures |
| Commands | `web/factory3d/editor_commands.mjs` | Replace full-scene gesture snapshots with bounded patches |
| Cameras | `web/factory3d/camera_path.mjs` | Reuse quaternion/path evaluation; separate target and optical focus |
| Placement | `web/factory3d/support_solver.mjs` | Preserve box fallback; add surface queries |
| Import | `web/factory3d/model_loader.mjs` | Preserve format loaders; expose import normalization and overrides |
| Backend | `api/factory3d.py` | Keep reviewed storage/routes/queue contracts behind new services |
| Generation | `api/factory3d_generation.py` | Preserve TripoSplat, Pixal3D, and TRELLIS.2 integration |
| Library | `api/factory3d_library.py` | Extend existing `.vnccs3d` packages and reusable library UI |
| Node output | `nodes/factory3d.py` | Preserve RGB IMAGE LIST ordering and fresh-capture safeguards |
| Tests | `tests/test_factory3d_*.py`, `tests/test_factory3d_frontend.mjs` | Keep regressions; add executable behavior and geometry tests |

The scene-file schema is currently **11**; the hidden editor-state schema is **17**. They are different version domains. The Gaussian export version is **8** and the library manifest identifier is `vnccs-3d-factory-library/v1`. Never use one counter for all four.

The renderer vendors **Three.js r180** and **Spark v2.1.0**, with provenance in `web/vendor/spark/README.md`. Reuse this exact pair initially. The project currently does not require a React build or an npm installation for the end user.

### 2.2 Confirmed problems

| ID | Evidence in baseline | Required response |
| --- | --- | --- |
| B01 | `VNCCS_3DFactory.load_scene()` checks objects/skydome/cameras, but not architecture | Fix architectural-only output before adding features |
| B02 | `_syncThreeLights()` skips whole shadow-casting lights beyond the selected shadow budget | Separate illumination from shadow allocation |
| B03 | `_syncThreeLights()` removes/recreates local lights when lighting signature changes | Retain light instances and update values directly |
| B04 | `_renderInspector()` substitutes a selection-count message for mixed/multiple selection | Implement shared-property editing and batch commands |
| B05 | `createFactoryPrimitiveGeometry()` creates terrain as plane/box geometry | Add a real heightfield; preserve existing flat terrain appearances |
| B06 | Main output is one RGB IMAGE LIST; no graph geometry passes | Add explicit rendering/conditioning contracts |
| B07 | Objects and Inspector need distinct responsibilities | Keep mutually exclusive right tabs with full-height content; preserve selection and independent scroll |
| B08 | `_renderLightInspector()` exposes Point fields although runtime handles Spot/Directional | Expose actual supported properties through capability-driven inspectors |
| B09 | Object transform scale is scalar; gizmo space is world; exact field bounds vary by entity | Introduce versioned transforms and one property specification |
| B10 | `normalizeModel()` normalizes imports to a 2 m maximum extent | Offer physical units and explicit normalization modes without resizing legacy imports |

Existing strengths include realtime `input` paths, targeted architecture previews, selection, grouping, floor levels, buildings, snapping in Plan, camera paths, Cutaway, material texture maps, saved-camera capture, autosave, and stale-result guards. Retain them.

Important corrections/qualifications:

- Native scene packaging **already exists** in the library. Extend it and expose direct export, instead of inventing another package format.
- Architecture material editing already supports base-color, normal and roughness maps, UV settings, glass transmission and IOR. The gap is consistent editing across asset types and more complete material channels.
- Camera `focus_distance` currently describes distance to the look target in pose conversion. It is not evidence of implemented optical depth of field.
- Spark has its own rendering/LOD facilities. The editor still needs measured budgets, mesh instancing, resource ownership and UI virtualization.
- Skydome currently changes the background, not a complete image-based lighting system.
- UI layout and performance were inspected in source, not visually certified on the actual ComfyUI host.

Baseline audit checks: 41 frontend tests and 6 Python node tests passed. Many frontend checks use source assertions. An isolated mocked execution of an architecture-only scene returned the empty-image branch without requesting capture. This defect needs a permanent executable regression test.

## 3. Architecture decisions and technology choices

| Decision | Selected technology/approach | Reason and boundary |
| --- | --- | --- |
| UI | Native ES modules, semantic DOM, scoped CSS Grid/Flex, small keyed components | Fits current ComfyUI extension loading; avoids a framework migration dependency |
| UI state | Factory-owned store, selectors, command registry, transactional patches | One authoritative editing flow; controls do not mutate Three objects independently |
| Type contracts | JSDoc types in `.mjs`, versioned JSON contracts, Python normalizers | Executable without a runtime compiler; type checking can be a development-only step |
| Main render | Existing Three r180 `WebGLRenderer` + Spark 2.1.0 | Retains working mixed mesh/splat rendering; no initial WebGPU/TSL rewrite |
| Heavy CPU work | Local module Web Workers, transferable typed arrays, cancel/version tokens | Terrain, scatter, BVH preparation, exports; no remote compute requirement |
| Mesh placement | Three raycaster plus an isolated `three-mesh-bvh` adapter | Fast surface queries; ordinary raycaster remains a correctness fallback |
| Repetition | Three `InstancedMesh`, partitioned by asset/material/spatial cell | Reduces repeated-mesh draw calls; does not pretend to instance Spark with `InstancedMesh` |
| Architecture | Factory topology graph + deterministic parametric `BufferGeometry` | Maintain semantic rooms/walls/openings instead of destructive scene-wide booleans |
| Polygon triangulation | Three `ShapeUtils` / matching bundled Earcut implementation | Holes in floors/ceilings; pin the exact implementation, test winding |
| Terrain | CPU-authoritative Float32 height tiles + GPU vertex buffers | Simple reproducible editing and persistence; shader-only displacement is not canonical geometry |
| Scatter | Specified seeded PRNG + spatial hash + mesh instances | Reproducible placement and selective regeneration |
| Materials | Three standard/physical materials with a Factory material descriptor | Preserve imported materials; explicit overrides and channel color spaces |
| Environment | r180-compatible RGBE/EXR loaders + PMREM for meshes | Background and environment lighting controlled separately |
| Conditioning | Dedicated mesh/proxy render passes into render targets | No assumption that generic mesh override materials render Spark correctly |
| Backend | Existing ComfyUI route API and Python storage helpers; NumPy/Pillow already available | Avoid new runtime web servers, process launchers, or arbitrary download clients |
| Packaging | Existing `.vnccs3d` ZIP + manifest version migration | Preserve native data; GLB is an additional geometry exchange format |
| Tests | Node test runner, Python unittest, shared fixtures, actual-runtime diagnostic runner | Executable tests and explicit host validation rather than source regex alone |

The UI design-system search returned an irrelevant landing-page pattern. It is not adopted. The design below is a custom editor layout using existing Sakura identity; relevant local UX guidance for keyboard navigation and visible focus is retained.

### 3.1 Dependencies and compatibility gates

1. Pin all Three addons to **r180** while keeping the current Spark pair. Do not copy examples from current docs without checking the r180 API locally.
2. Vendor runtime modules locally, rewrite imports to the single existing Three instance, preserve licenses, and record exact version/commit/hash in a vendor manifest. No CDN imports or runtime package resolution.
3. `three-mesh-bvh` is a proposed new dependency. Start the compatibility spike with pinned **v0.9.1** ([official release](https://github.com/gkjohnson/three-mesh-bvh/releases/tag/v0.9.1)); its availability is verified, but r180 compatibility has not been tested in this task. Before production import, pass an import/raycast/build/serialize fixture and record the full resolved commit/hash. Do not use `latest` or assume current-main compatibility. Keep it behind `spatial_index.mjs`; reject integration if the fixture fails, and retain Three raycasting until a compatible pin passes.
4. Add only the needed r180 addons: RGBE/EXR loader, area-light uniforms, GLTFExporter, and suitable geometry helpers. Existing Draco/Meshopt decoders stay on their current local path.
5. Do not introduce a CSG, physics, path-tracing, UI framework, or terrain package merely for convenience. The specified initial algorithms are implementable with the existing stack. Any later dependency needs a concrete feature, compatible pin and license/provenance record.
6. Use capability probes for render-target formats, readback and texture limits. `getCapabilities()` reports actual support. Half-float renderability does not imply portable float readback; validate both.
7. Existing project security gates remain unchanged. New code uses `api.fetchApi` and reviewed local storage/import abstractions; it must not introduce raw backend network clients, shell commands, dynamic code execution, credential discovery, or scanner exclusions.

Technical references: [Three InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html), [render targets](https://threejs.org/docs/pages/WebGLRenderTarget.html), [SparkRenderer](https://sparkjs.dev/docs/spark-renderer/), and [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh). These document underlying facilities; the architecture and budgets in this plan are proposed Factory design decisions.

## 4. Module boundaries and extraction order

Proposed structure; add modules when their milestone starts, not empty placeholders for the whole tree:

```text
web/
  vnccs_3d_factory.js                 # existing registration/lifecycle facade
  vnccs_3d_factory_viewer.js          # existing viewer facade during extraction
  vnccs_3d_factory.css                # scoped tokens and editor layout entry
  factory3d/
    core/
      document_store.mjs             # canonical document, selectors, revisions
      property_specs.mjs             # property kinds, units, ranges, capabilities
      command_registry.mjs           # command availability and invocation
      transactions.mjs               # gesture patches, undo/redo, cancellation
      migrations.mjs                 # editor/scene read adapters
      selection.mjs                  # unified typed entity references
      dependency_graph.mjs           # derived-geometry invalidation
      asset_registry.mjs             # immutable sources, overrides, resource refs
    ui/
      workspace.mjs                  # dock/fullscreen layout and preferences
      components.mjs                 # numeric/color/vector/select/action controls
      outliner.mjs                   # virtualized tree and selection
      inspector.mjs                  # capability-driven section composition
      creation_panel.mjs
      materials_panel.mjs
      environment_panel.mjs
      shots_panel.mjs
      output_panel.mjs
      command_palette.mjs
      interaction_state.mjs          # focus/draft/scroll/expanded-state retention
      tool_options.mjs
    tools/
      tool_controller.mjs
      transform_tool.mjs
      architecture_tools.mjs
      placement_tool.mjs
      terrain_brush.mjs
      scatter_tool.mjs
      spline_tool.mjs
      camera_match_tool.mjs
    runtime/
      scene_runtime.mjs              # typed entities -> retained runtime nodes
      mesh_runtime.mjs
      splat_runtime.mjs               # adapter around existing Spark work
      architecture_runtime.mjs
      terrain_runtime.mjs
      scatter_runtime.mjs
      lighting_runtime.mjs
      environment_runtime.mjs
      spatial_index.mjs
      resource_cache.mjs
      render_scheduler.mjs
      capture_pipeline.mjs
      conditioning_proxy.mjs
      diagnostics.mjs
    workers/
      geometry_worker.mjs
      terrain_worker.mjs
      scatter_worker.mjs
    geometry/
      architecture_topology.mjs
      parametric_parts.mjs
      terrain_tiles.mjs
      spline_geometry.mjs
    contracts/                       # versioned JSON schemas and fixtures
api/
  factory3d.py                       # existing routes facade
  factory3d_schema.py                # existing normalizers, evolved
  factory3d_library.py               # existing package/library entry
  factory3d_generation.py            # retain generator contracts
  factory3d_storage.py               # proposed persistence services
  factory3d_transactions.py          # validated optimistic document updates
  factory3d_captures.py              # immutable jobs, validation, atomic publish
  factory3d_assets.py                # immutable binary references and manifests
nodes/
  factory3d.py                       # backward compatible editor output
  factory3d_render.py                # proposed conditioning renderer node
  factory3d_mask.py                  # proposed ID/semantic mask extraction
tests/
  fixtures/factory3d/
  test_factory3d_contracts.mjs
  test_factory3d_transactions.mjs
  test_factory3d_geometry.mjs
  test_factory3d_capture_math.mjs
  test_factory3d_migrations.py
  test_factory3d_capture_contract.py
```

Dependencies flow `UI/tools -> store/commands -> runtime + persistence`. Geometry modules accept plain data and return buffers/diagnostics. They do not import ComfyUI or manipulate DOM. Runtime modules do not serialize documents. Backend rendering code does not import the main VNCCS character pipeline.

Keep imports explicit and static. Workers may use local module entry files with a fixed `new URL(..., import.meta.url)` URL; they must not evaluate downloaded strings. A worker message is data, never code.

Extraction sequence: transaction tests -> store adapter -> numeric component -> lighting retention -> selection/Inspector -> shell -> rendering services -> new tools. Run the old implementation and new implementation against the same fixture where useful; only one store and renderer may own a live widget.

## 5. State, schema and migration specification

### 5.1 State ownership

| State | Owner | Persistence |
| --- | --- | --- |
| Entities, transforms, materials, cameras, terrain/scatter recipes | Scene document | Backend scene manifest + hidden workflow snapshot of bounded metadata |
| Immutable sources, terrain tiles, proxies, maps | Asset store | Validated scene-owned files/content hashes; no binary arrays in workflow JSON |
| Selected entities, active tool, active floor, visible panels | Editor session | Hidden editor state, with size limits |
| Panel widths, UI density, shortcut preferences | Node-scoped preference store | Optional local cache; not authoritative scene data |
| Unsaved text drafts, pointer gesture, hover | Component/tool session | Memory; survive local rerender, cancel cleanly |
| Meshes, GPU buffers, PMREM, shader programs | Runtime cache | Disposable, reconstructible |
| Capture jobs and immutable manifests | Backend capture store | Revision-bound files; reusable only with exact signature |

Keep `factory_data` and existing `scene_snapshot` semantics. Define one clear queue barrier so the newest committed document and referenced blobs are durable before execution requests frames. Editor selection changes do not invalidate rendered scene content.

### 5.2 Versioning

- First new scene document version: **12**. First new hidden editor state version: **18**.
- A root `features` object records versioned feature contracts, e.g. `transforms: 2`, `terrain: 1`, `captures: 2`. Add the full declared defaults in the first v12 normalizer; bump a feature version for a semantic change. Do not silently extend a strict validator with incompatible semantics.
- Continue reading all legacy versions supported by current code. Reject unknown future major versions with a recoverable message; never normalize them into empty scenes.
- Implement `migrateScene11To12()` in JS/Python with shared golden fixtures. Migrate editor 17->18 separately. Migrations are pure, deterministic and idempotent.
- On first save that requires v12 features, create a new scene directory and migrate/copy dependencies there. Keep the v11 scene intact and switch the node to the new scene ID. Pure inspection does not rewrite original scenes. Remap scene-owned reference URLs and package identifiers; entity IDs within the copied scene remain stable.
- Existing v11 scenes remain usable until opted into new features. An old installation is not expected to edit v12; rollback uses the retained v11 original. Do not claim arbitrary downgrade compatibility.
- A mixed-version request must not discard new fields. Legacy update routes accept legacy documents; for v12 documents, allow only documented safe field updates or return `409 SCHEMA_UPGRADE_REQUIRED` to old clients.

### 5.3 Document structure

Preserve existing typed arrays (`objects`, `levels`, `architecture`, `cameras`, `camera_tracks`, `lighting`, `textures`) and opaque IDs. Add indexes at runtime rather than changing every array to a new ECS format.

Proposed additions:

```json
{
  "schema_version": 12,
  "features": {"transforms": 2, "terrain": 1, "captures": 2},
  "coordinate_system": "right-handed-y-up",
  "units": "m",
  "collections": [],
  "asset_sources": [],
  "material_definitions": [],
  "terrains": [],
  "scatter_systems": [],
  "splines": [],
  "parametric_parts": [],
  "references": [],
  "variants": [],
  "shots": [],
  "environment": {},
  "conditioning": {},
  "content_revision": 0,
  "render_revision": 0
}
```

This fragment is illustrative and requires existing mandatory fields/default objects to form a complete scene. Existing `revision` and `edit_revision` remain supported. Define `content_revision` for durable scene-affecting changes, `render_revision` for rendered-content/camera/output changes, and a separate in-memory `view_revision` for editor overlays. Revisions are backend-issued integers; content hashes are used for cache identity.

### 5.4 Entity references and transforms

Selection uses `{kind, id, subtarget?}`. `kind` is a fixed enum: model, primitive, terrain, scatter, spline, part, building, level, room, wall, opening, camera, light, collection. `subtarget` identifies a material slot, wall side, terrain tile, vertex, or instance. Validate typed references in Python as well as JS.

Each transformable entity gains:

```json
{
  "transform_v2": {
    "position": [0, 0, 0],
    "quaternion": [0, 0, 0, 1],
    "scale": [1, 1, 1],
    "pivot": [0, 0, 0],
    "parent_ref": null
  },
  "display": {"viewport_visible": true, "render_visible": true, "selectable": true},
  "semantic": {"class_id": "", "tags": []}
}
```

Transform equation is `Mlocal = T(position) * T(pivot) * R(quaternion) * S(scale) * T(-pivot)` and `Mworld = Mparent * Mlocal`. Store quaternions as XYZW, normalized. Preserve the current XYZ Euler conversion when reading legacy rotation; use rotation controls only as a presentation representation.

Legacy scalar scale becomes `[s,s,s]`; legacy mesh import normalization stays in an explicit asset-to-local matrix, not a second guessed resize. Imported internal node transforms remain untouched. Uniform splat scaling remains the compatibility baseline. Nonuniform splat transforms require tested covariance transformation `Sigma' = A * Sigma * A^T` and matching export support; disable unsupported nonuniform operations rather than silently use a scalar.

Collection membership is organizational and never creates an extra transform parent automatically. An entity has at most one transform parent. For an assigned floor entity, the physical parent chain is scene -> building -> floor -> entity. Migration computes local position from the pre-migration world matrix and floor/building inverse, preserving appearance. Reject parent cycles. Reparent with Keep world transform by default.

Nonuniformly scaled parents plus rotated children can create shear. Detect non-TRS matrices during reparent/group operations. Reject with a precise explanation or require the explicit `Bake transform` operation for supported mesh geometry; never decompose and lose shear silently. Building/floor scale stays `[1,1,1]` in v1 of the new editor. Negative instance scales are excluded; Mirror bakes a separate mesh asset with corrected winding/normals.

### 5.5 Asset references

Scene entities reference immutable asset records containing source format, relative validated storage reference, SHA-256, byte length, import normalization matrix, original dimensions, units, orientation, and material-slot IDs. Keep distinct scene asset IDs and library asset IDs: the existing library uses 24-hex IDs while scene entities generally use 32-hex IDs. Validate by domain instead of changing all IDs to one pattern.

Binary edits use copy-on-write and reference counts. Undo pins required old versions. Deleting an entity removes a reference; actual file cleanup occurs only when no scene/history/package operation references the blob. Never mutate the shared original mesh, PLY, texture or prefabricated source in place.

## 6. Realtime commands, persistence and concurrency

### 6.1 One gesture, one command

Required API:

```text
beginGesture(commandId, targetRefs, beforeValues) -> gestureId
previewGesture(gestureId, proposedValues) -> acceptedValues + dirtyRefs
commitGesture(gestureId) -> command with forward/inverse patches
cancelGesture(gestureId) -> restore beforeValues
undo()/redo() -> apply inverse/forward patches and invalidate affected refs
```

1. Pointer down/focus starts a transaction lazily when the first valid edit occurs.
2. `input`/`pointermove` writes preview state and invalidates affected runtime nodes immediately. Coalesce with `requestAnimationFrame`; never wait for pointer release to show a change.
3. Numeric peers and overlays show normalized accepted values, not stale requested values.
4. Pointer up/Enter/change commits one command. Escape, pointer cancel, lost capture or node removal rolls back the gesture. Blur follows component policy: valid draft commits; invalid draft restores with an inline explanation.
5. Persist after commit with a bounded delay, but flush at queue, scene switch and explicit Save.
6. Undo stores property patches. Terrain commands store changed rectangles/tile diffs. Use a default history memory budget of 128 MiB plus a 200-command ceiling, adjustable within 16-1024 MiB. These are proposed budgets; show discarded-history notification without deleting live assets.

Continuous lighting should update retained lights; transforms update matrices; texture UV changes update uniforms/texture transforms; topology edits rebuild only affected wall/room sections. Camera navigation never triggers asset reload.

### 6.2 Worker and async jobs

Every request carries `{sceneId, entityRef, documentRevision, gestureId, requestSequence}`. Apply a result only if its ownership and newest sequence still match. Transfer buffers only when the sender no longer needs them; do not detach the active viewport buffer. Workers return replacement buffers which are swapped atomically after validation.

During expensive work, retain the last valid geometry and overlay a lightweight current preview. Worker cancellation is cooperative between chunks; ignored late results must release buffers/resources. Low-detail previews use the same parameters and seed as the final result. Save an actionable error on a failed final build while retaining the last durable valid state.

### 6.3 Proposed transactions API

Keep existing routes for legacy scenes. Add:

| Method/path below `/vnccs/3d-factory` | Request | Result |
| --- | --- | --- |
| `POST /scenes/{id}/transactions` | `request_id`, `base_revision`, typed operations | Accepted document revision + normalized changed entities |
| `POST /scenes/{id}/assets` | Multipart metadata + bounded binary blob | Immutable asset ID/hash/capabilities |
| `GET /scenes/{id}/assets/{asset_id}` | Validated scene asset ID | Stored file; no arbitrary path/URL parameter |
| `POST /scenes/{id}/captures` | Immutable snapshot signature, shot IDs, pass profile | Capture job ID + required parts |
| `PUT /scenes/{id}/captures/{job}/parts/{part}` | Declared part payload | Validated staged part acknowledgement |
| `POST /scenes/{id}/captures/{job}/commit` | Part manifest and signature | Atomic immutable capture manifest |
| `GET /scenes/{id}/captures/{job}` | Job ID | State/progress or complete manifest |
| `POST /scenes/{id}/captures/{job}/cancel` | Job ID | Cancelled state; no incomplete publication |
| `POST /scenes/{id}/package` | Export profile, expected revision | Job + downloadable existing-format package |

Use operation enums such as `set_properties`, `create_entities`, `delete_entities`, `reparent`, `replace_asset_reference`, `apply_terrain_tiles`. Do not accept arbitrary JS property paths, filesystem paths or executable scripts. Validate target existence, kind, property whitelist, reference integrity, finite values, total request bytes and operation counts. Creation operations explicitly allocate validated IDs; the legacy `update_scene` currently cannot create arbitrary objects and must not be treated as if it can.

Apply transactions under the existing scene locking abstraction, validate the resulting document, then write atomically. A stale `base_revision` returns `409` with current revision and changed IDs. Same `request_id` and body hash returns the previous acknowledgement; conflicting body reuse returns `409`. Do not automatically merge conflicting geometry edits. Preserve a local pending edit and offer Reload or Save a copy.

Queue barrier: finish or explicitly reject the active invalid draft -> commit pending gesture -> upload referenced blobs -> await transaction acknowledgement -> freeze capture specification -> request capture. An offline/unavailable backend shows Unsaved; scene switching cannot silently discard pending changes.

## 7. UI/UX specification: complete shell replacement

### 7.1 Default layout

Default embedded node remains usable around its current 1100 x 760 size. Expanded editor uses the available ComfyUI application viewport. Layout dimensions below are CSS pixels at application zoom 100%; graph zoom is handled by the existing node integration.

```text
+---------------------------------------------------------------------------+
| Scene / Saved | File Edit Add | Layout | Quality | Capture / Output         |
+----------------+-----------------------------------+----------------------+
| Assets/Cameras | 3D / Plan / Camera | view controls | Objects Inspector    |
| search/import  | W/E/R Local/World Pivot Snap       | Export               |
| library        | active tool options               +----------------------+
| generation     |                                   | ONE active panel:    |
| references     |             VIEWPORT              | hierarchy OR         |
| camera list    |                                   | selection properties |
|                |                                   | OR export settings   |
+----------------+-----------------------------------+----------------------+
| Optional bottom: Shots / Camera path / Output preview                      |
+---------------------------------------------------------------------------+
| active tool hint | meters | selection | frame time | jobs | save state     |
+---------------------------------------------------------------------------+
```

Default sizes: top bar 40, viewport toolbar 36, contextual options 36 when needed, status 24; left dock 240, right dock 300; adjustable left 180-420/right 240-480. Bottom dock starts closed, opens to 180 and can resize between 120 and 40% of available height. Splitter hit region is 8 px with a 1 px visible divider. Double-click a splitter resets its size.

At 1100 px width, two default docks leave about 540 px before splitters for the viewport. Do not preserve the current 420 px minimum center at the cost of silently overflowing narrower nodes.

### 7.2 Responsive and expanded modes

| Available width | Layout policy |
| --- | --- |
| 1200+ | Both docks visible; bottom optional; full text tool options |
| 980-1199 | Both docks visible at compact defaults; wrap only secondary toolbar options into an overflow menu |
| 760-979 | Right Objects/Inspector/Export tabs visible; left Assets in a toggle drawer by default; user can pin both if viewport remains >=320 |
| Below 760 | Viewport plus one active drawer; show `Expand editor`; preserve all commands through menus |

Expanded mode reparents the **same** editor root to a Factory-owned overlay in the current ComfyUI document; it does not create a second store or WebGL context. Keep a placeholder in the node, call resize after reparenting, restore on Close/Escape, workflow unload, or node removal. Do not require browser Fullscreen API. Keyboard focus returns to Expand editor. No renderer-owned canvas is cloned.

Layouts: `Scene`, `Architecture`, `Landscape`, `Lighting`, `Camera`, `Output`. These are named panel arrangements/tool suggestions, not different scene stores. Switching layout must preserve selection, tool drafts where safe, camera, scroll, expanded groups and object visibility. A preset may deliberately enter Plan/Camera only when the user selects that explicit viewport option; layout alone must not unexpectedly move the camera.

### 7.3 Creation and tool discovery

- Top-level Add menu categories: Geometry, Architecture, Landscape, Models, Lights, Cameras, Reference.
- `Assets` dock embeds current library capabilities, generation providers, import and search. Model setup remains available here; it must not consume a permanent 280 px panel during scene editing.
- Add enters a placement tool with Inspector showing defaults **before** creation. Click places, drag sets size/direction, Enter confirms, Escape cancels. Allow `Repeat placement` as an explicit sticky option.
- Add at pointer uses the nearest supported surface or active construction plane; Add from a menu without a pointer hit uses the viewport target on that plane. Display a ghost and dimensions before confirmation.
- Right-click context depends on target: object, material surface, wall, terrain, camera, mixed selection or empty space. Include only applicable actions. Unsupported actions may be disabled with a reason, never silently omitted if central to the selected tool.
- Command palette searches actions and property sections by names/synonyms; Enter executes or focuses the relevant control. Use the same command registry for menus, shortcuts and buttons.
- Pin common tool settings to contextual options; advanced parameters remain in Inspector. Do not duplicate state between the two presentations.

### 7.4 Contextual tool placement

| Target/tool | Always visible options | Inspector sections | Context actions |
| --- | --- | --- | --- |
| Select/Transform | Move/Rotate/Scale, World/Local, Pivot, Snap | Transform, Dimensions, Placement, Visibility | Frame, Duplicate, Group, Isolate, Drop, Replace asset |
| Wall | Thickness, Height, Snap | Endpoints, Length/Angle, Alignment, Surfaces | Add opening, Split, Join, Select room |
| Room | Rectangle/Polygon, Height, floor/ceiling toggles | Boundary, Surfaces, Openings, Level | Edit boundary, Add door/window, Copy to floor |
| Opening | Door/Window/Empty, width, height | Host, Offset, Frame/Leaf, Materials | Flip hinge, Open/Close, Detach copy |
| Terrain | Brush, radius, strength, falloff | Heightfield, Layers, Scatter, Quality | Flatten here, Sample height, Add exclusion |
| Scatter | Paint/Erase/Region, asset set, density | Distribution, Constraints, Randomization, Instances | Regenerate, Freeze, Make instances editable |
| Light | Type, intensity, temperature/color | Transform, Shape/Cone, Shadows, Influence | Aim at selection, Duplicate, Solo light |
| Camera | Enter/Exit, Lock, FOV, frame | Pose, Lens, Reference, Match, Capture | Align to view, Add shot/path point |
| Surface | Material picker, Apply scope | Maps, Mapping, PBR, Overrides | Pick material, Make unique, Apply to selection |
| Multiple selection | Count, primary entity, transform mode | Shared properties with mixed state | Align, Distribute, Batch assign, Collection |

### 7.5 Inspector behavior

Inspector is composed from property descriptors and entity capabilities. Stable section keys: `identity`, `transform`, `geometry`, `materials`, `placement`, `lighting`, `visibility`, `advanced`. Keep common section order and remember expansion per entity kind. Different entity types may omit inapplicable sections.

An empty selection shows scene units, active building/floor, environment shortcut and creation actions. Selection in Objects updates the Inspector data; switching to Inspector shows only its property panel. Returning to Objects restores the same tree state and scroll position. Selecting a camera selects its object; entering its viewpoint is an explicit separate action. Editing saved-camera fields updates camera helper/inset immediately but does not teleport the editor camera unless already in Camera view.

Multiple selection exposes the intersection of editable properties. Show `Mixed` for unequal values; entering a value assigns all applicable targets. Transform controls offer `Set absolute` and `Apply delta`. Mixed-type selection includes only meaningful shared actions. Disallowed targets must be listed in a pre-action count, not quietly skipped.

### 7.6 Numeric, vector and color controls

Implement one `PropertyControl` family with descriptor:

```text
id, label, valueType, unit, defaultValue, hardMin, hardMax,
sliderMin, sliderMax, sliderMapping, step, precision,
supportsMixed, liveStrategy, capability, help, validate
```

- Standard row: label, slider/scrub surface, exact field, reset. Vector is three aligned axis fields with optional aspect/scale link. All controls in a logical row share top edge and height; helper text occupies its own grid row.
- Values display unit suffixes; parser accepts finite decimal values, optional unit suffix and explicit relative operations such as `+=0.25m`. Do not use eval or general expression execution. Unsupported expressions show inline errors.
- Exact field may exceed the slider's convenience window within the validated hard range. Recenter the slider after commit, not mid-drag. Use logarithmic sliders for positive multi-order quantities; include a separate Off/Zero control where zero is valid.
- Scrub sensitivity is property-specific; Shift multiplies by 0.1 and Alt by 10 while scrubbing. Snapping is a separate toggle, not an implicit rounding of exact input.
- A temporary `-`, blank field or decimal separator remains an input draft; never coerce it to zero and move the object. On valid input update continuously. Clamp accepted values visibly or show a validation error; do not let HTML min/max and backend normalization disagree.
- Color panel: swatch, HEX, RGB, optional Kelvin for lights, intensity separately. Use `input` feedback; selecting Kelvin explicitly switches from custom color mode. Never derive Kelvin from arbitrary RGB without marking approximation.
- Reset single property through an accessible button/context action. Reset section lists affected properties and produces one command.

### 7.7 Proposed property ranges

These are validation targets for new contracts, not a demand to enlarge every existing limit immediately. Asset scale and device limits are separate from property ranges. Validate combined operations against resource budgets before allocation.

| Property | Hard range / domain | Initial slider or scrub range | Default / behavior |
| --- | --- | --- | --- |
| Scene position | -1,000,000..1,000,000 m | +/-5 m around current | 0; large coordinates require origin rebasing |
| Object dimensions | 0.001..100,000 m | 0.01..20 m | From asset; explicit scale link |
| Scale XYZ | 0.000001..10,000, positive | Log, 0.01..100 | 1; geometry validation can reject overflow |
| Euler display | -36,000..36,000 degrees | -180..180 | Store quaternion, preserve useful display continuity |
| Wall height / thickness | 0.05..1,000 / 0.01..10 m | 0.5..10 / 0.05..1 | 2.8 / 0.12 |
| Grid / angle snap | 0.001..1,000 m / 0.1..180 degrees | Presets + exact | 0.1 / 15 |
| Opening geometry | Host-bounded | Current available host interval | Width 0.9, door height 2.0; explain overlap constraints |
| Perspective vertical FOV | 5..120 degrees | 15..100 | 42; effective projection supports principal-point shift |
| Camera clip planes | near >=0.001 m, far <=1,000,000 m, far > near | Auto or exact | Auto based on shot bounds; capture freezes actual values |
| Optical focus / f-stop | 0.001..1,000,000 m / 0.7..64 | Log focus; 1..22 | Focus separate from orbit distance; DOF disabled initially |
| Reference opacity | 0..1 | 0..1 | 0.5 |
| PBR roughness/metalness/opacity/transmission | 0..1 | 0..1 | Preserve asset defaults |
| IOR / normal strength | 1..2.5 / 0..4 | Full | 1.5 / 1 |
| UV scale / offset / rotation | 0.001..1,000 / +/-10,000 / +/-36,000 degrees | 0.1..10 / +/-2 / +/-180 | 1 / 0 / 0 |
| Light intensity | 0..100,000 native units | 0..50, expandable/log | Keep legacy numeric interpretation until explicit conversion |
| Light temperature | 1,000..40,000 K | 2,000..12,000 | 6,500 in Kelvin mode |
| Spot full cone | 1..178 degrees | 5..90 | 45; runtime half-angle = full angle / 2 |
| Spot penumbra | 0..1 | 0..1 | 0.2 |
| Environment exposure | -16..16 EV | -4..4 | 0; multiply linear intensity by 2^EV |
| Terrain brush radius | 0.05..1,000 m | 0.1..50 | 2 |
| Terrain brush strength | 0..100 m/s | 0..5 | 0.5 for raise/lower |
| Scatter scale / slope | positive 0.01..100 / 0..90 degrees | 0.5..2 / 0..45 | Asset scale, slope full range |
| Output size | 64..4096 per side initially | Presets | 1024x1024; preserve backend pixel limit |

Migrate legacy Spot `angle` according to its actual current usage as the Three half-angle. Present new `cone_angle_degrees = 2 * legacy.angle`, constrained to valid geometry with an explicit migration diagnostic if the old value was outside a physically valid half-angle. Do not halve an old cone silently.

### 7.8 Outliner and selection

Build a unified typed hierarchy for buildings, floors, rooms, objects, terrain/scatter, cameras and lights. Architecture room walls can expand below the room with surface subtargets. Collection views may show references without reparenting the physical scene.

Rows show icon, name, type-specific count, viewport eye, render toggle and lock. Use stable keys and virtualized rows; measured variable heights are unnecessary if row height is fixed at 30 px. Search includes name, type, semantic tag and asset name. Filters explicitly show when other floors/types are hidden.

Shift-click range-selects contiguous visible rows; Ctrl/Cmd-click toggles individual rows. Viewport Shift-click adds/toggles; box select has explicit Visible/Through mode. Transparent/splat picking uses proxy hit testing with Alt-click cycling through hits. Preserve selection IDs if filters hide selected entities and show a hidden-selection count.

Drag/drop previews target, insertion order and whether the operation is organization or physical reparenting. Prevent cycles. `Move to floor` changes the parent frame with explicit `Keep world height` or `Keep height above floor`; default to keeping height above floor for that command, and keep world transform for generic reparent.

### 7.9 Keyboard and navigation ownership

| Input | Action |
| --- | --- |
| W / E / R | Move / Rotate / Scale when viewport editing is active |
| F / Shift+F | Frame selection / Frame scene |
| End / Shift+End | Drop as selection / Drop individually |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Undo / Redo |
| Ctrl/Cmd+C / V / D | Copy / Paste / Duplicate |
| Delete or Backspace | Delete eligible selection, one undoable command |
| Escape | Cancel current gesture, else close transient surface, else exit Camera view |
| Tab | Normal keyboard focus traversal; never hijack globally for tool modes |
| Ctrl/Cmd+K | Command palette only while editor owns focus |
| 1 / 2 / 3 | Perspective / Plan / active Camera view, outside text fields |

Orbit navigation retains current mouse conventions. Add explicit Fly mode where WASD moves, QE changes height, Shift accelerates, and W/E/R transform shortcuts are suspended. Movement speed is adjustable, normalized to delta time. Walk mode adds ground-height sampling and optional collision proxy checks; it is not rigid-body physics. Show the active navigation mode and key hints.

Do not intercept typing, IME composition, native select navigation or shortcuts from another ComfyUI node. Pointer capture exists only during a gesture. Preserve middle-button graph panning outside the viewport; viewport middle-button panning belongs to the scene camera. Wheel changes the hovered panel or viewport, never both.

### 7.10 Visual system, accessibility and state retention

Keep Sakura accents and dark identity, but make editor surfaces predominantly opaque. Proposed tokens: background `#0a0a0f`, panel `#12121a`, elevated `#1a1a26`, controls `#22222e`, text `#e8e8f0`, secondary `#b1afc0`, accent `#ff8fa3`. Use dark text on filled pink primary buttons. Reserve dim text for disabled/decorative content; verify actual foreground/background pairs, including hover/focus, rather than assuming token contrast.

Use system/Sora font stack without remote font loading; mono/tabular numerals for values. Body/labels 13-14 px, secondary labels >=12 px, row/control height 30-32 px; avoid shrinking the entire UI as the node gets smaller. Fine-pointer desktop tools may use 28-32 px targets with separation; coarse-pointer mode uses at least 44 px. Focus indicators remain visible at all densities.

Use native labels/buttons/inputs, roving tab index for toolbars, accessible tree semantics and a dialog focus trap only for actual modals. Nonmodal docks must not trap focus. Focused controls must not be obscured by a drawer. Respect reduced motion; viewport feedback has no decorative easing lag.

Every persistent region preserves scroll within 1 rendered pixel across selection, filtering, Inspector updates and modal round trips. Capture focus key, text selection, drafts and expanded sections with scroll. Do not focus a replaced input and scroll it into view unless the user requested navigation. Form row top edges differ by <=1 rendered pixel. These require actual-runtime geometry checks, not a claim based on CSS source.

### 7.11 Feedback and error surfaces

Status distinguishes Saved, Saving, Unsaved, Conflict, Capturing and Job failed. Toasts are supplemental, not the only place a failure can be read. Failed imports remain as recoverable asset rows with Replace/Retry/Details. Long jobs show stage, cancellability and progress without covering the last viewport frame.

Provide tool hints and optional first-use instructions. Destructive entity edits normally use Undo rather than repeated confirmations. Scene/package deletion shows the actual name and dependencies. New UI must preserve all existing generator setup, cancellation, cache settings, library repositories and import error details.

## 8. Indoor construction algorithms

### 8.1 Topology graph

Use building-local XZ geometry with floor-local Y elevation. A wall has endpoint vertex IDs, thickness, height, alignment (center/left/right), base offset and material sides. A room has oriented boundary loops referencing wall segments; holes are separate loops. Openings reference a host wall and an offset in meters from its start, with dimensions, sill and insert descriptor.

Maintain a graph of vertices -> incident walls -> room loops -> surfaces/openings. During an endpoint edit, invalidate only incident walls, connected room polygons, their slabs and hosted openings. Store selection references independently of generated mesh IDs.

Algorithm for drawing:

1. Convert pointer to active floor plane in building coordinates.
2. Snap in priority order: explicit vertex, edge midpoint, perpendicular/parallel constraint, grid; use a screen-space capture radius of 8 px, adjustable 2-24. Stable tie-break by reference ID.
3. Show snapped source, dimensions and ghost geometry on every move.
4. On commit split intersected segments at valid intersections, merge coincident vertices within 1 mm, validate simple room loops and minimum edge length.
5. Offer explicit reuse of a shared wall when adjacent rooms overlap an existing segment; do not create two coincident walls. Separate adjacent-but-distinct walls remain possible through `Keep separate`.
6. Build wall faces from 2D profile rectangles excluding opening intervals. Use deterministic triangulation and closed caps. Acute joins use a miter with miter-length <=4x thickness, otherwise bevel the join; handle T/X junctions with tested polygon clipping in local 2D, not scene-wide CSG.

Room boundaries support rectangle and polygon creation; vertex move, insert, delete, edge offset, numeric length/angle, split and join. The polygon clipping implementation must have golden cases for L/T/X joins, acute angles, mirrored windings and holes. A concave polygon is valid; self-intersection is not. Preview invalid proposals in an error color while retaining valid geometry; commit refuses invalid topology without deleting the room.

### 8.2 Shared walls and migration

Legacy rectangular rooms have ordered `wall_ids` matching polygon sides. Convert them to topology references preserving their order and side materials. Do not automatically merge separate legacy walls solely because coordinates coincide; migration preserves appearance and offers a separate Repair shared walls action with a preview.

Deleting a room removes its ownership of a shared wall; delete the wall only if no other room owns it and the user chose to delete orphan boundaries. Deleting a shared wall requests a topology operation which updates all affected rooms. Opening ranges must be recomputed after split/join; an opening cannot straddle a split silently. Either keep a host segment that spans it or prevent that split with an explanation.

### 8.3 Parametric building parts

| Part | Stored parameters | Geometry implementation |
| --- | --- | --- |
| Stair | Width, total rise, tread count, run, landing dimensions, type straight/L/U, railing | Generate steps with explicit riser/tread dimensions; landing and railing are child parts |
| Ramp | Width, start/end elevation, length, side thickness | Extruded wedge or sampled path profile |
| Roof | Polygon footprint, type flat/shed/gable, pitch, overhang, thickness, ridge direction | Intersect roof planes with footprint, triangulate faces and caps; complex forms use imported mesh |
| Slab | Outer polygon, hole loops, thickness, elevation | Shape/ExtrudeGeometry with deterministic winding |
| Column/beam | Cross-section rectangle/circle, dimensions, endpoints | Box/cylinder or profile sweep |
| Railing/fence | Path, post spacing, height, profile, infill style | Instances for posts; swept/instanced rails |

Keep parts parametric until explicit Convert to mesh. Stair inputs need a declared controlling pair: total rise plus count determines riser; length plus count determines tread. Do not allow four contradictory independent dimensions. Display actual derived values and validation messages. These tools create visual scene geometry, not certified architectural engineering designs.

### 8.4 Openings and inserts

Opening inspector includes host wall, center/edge offset mode, width, height, sill, reveal depth, frame width/depth, mullion count, leaf thickness, hinge left/right, inward/outward and opening angle 0-180 degrees. Separate materials for frame, glass, leaf and reveal.

Separate void geometry from its door/window insert. Hiding an insert does not fill the hole. Moving the opening regenerates only its host wall; opening a door rotates the retained leaf around the hinge. Preserve glass transmission and alpha policy for conditioning. Allow custom model inserts fitted to the opening with explicit aspect lock.

### 8.5 Measurements, sections and multi-view

Add non-rendering dimension annotations for distance, height and angle, with readable screen-size labels. Provide a movable horizontal section plane, camera-relative Cutaway and manual clipping planes. Cutaway/selection helpers stay editor-only unless a shot explicitly requests a section render. Capture restores complete architecture by default.

After the single viewport is stable, add two/four-view layouts using one renderer and scissor viewports (Plan/Front/Side/Perspective), with one active input viewport. Share scene/runtime resources, maintain separate camera states and use request invalidation per view. Do not multiply WebGL contexts for every panel.

## 9. Terrain and outdoor tools

### 9.1 Heightfield contract

Proposed terrain descriptor:

```json
{
  "terrain_id": "32-hex-scene-id",
  "name": "Terrain",
  "width_m": 128,
  "depth_m": 128,
  "sample_spacing_m": 0.5,
  "height_origin_m": 0,
  "height_scale_m": 1,
  "tile_cells": 128,
  "height_asset_refs": [],
  "layer_definitions": [],
  "paint_asset_refs": [],
  "holes_asset_refs": [],
  "transform_v2": {},
  "generator_version": 1
}
```

The ID string above is a descriptive placeholder. Production validates a real 32-hex ID. Store height samples as Float32 little-endian meter offsets; tile metadata specifies row order, width/height, tile coordinates and hash. A tile with 128 cells has 129x129 samples. Edge samples are owned canonically and copied to neighbor borders on editing; never independently drift.

Global samples use row-major `(z,x)` indexing, +X right and +Z increasing row. Vertex position is `[-width/2 + x*spacing, height_origin + h, -depth/2 + z*spacing]` before terrain transform. Default terrain rotation is Y-only and scale is uniform; baking is required before unsupported tilt/nonuniform terrain operations.

Use a quadtree of 128-cell tiles with LOD steps 1/2/4/8, stable edge stitching or skirts. Condition/capture geometry uses a fixed selected LOD independent of viewport movement; collision samples the canonical heightfield. Bound active tiles and memory rather than allowing arbitrary resolution allocation.

Migrate legacy flat terrain to a constant-zero heightfield at its existing dimensions and transform. Its extrusion becomes a base-skirt/slab thickness property. Preserve UV density and color. Do not create a sampled grid until the first height edit or explicit conversion if a flat plane can remain the valid optimized representation.

### 9.2 Brush equations and gesture behavior

For raise/lower, each stroke sample changes `h += sign * strength_m_per_s * deltaTime * pressure * falloff(distance/radius)`. Default falloff is smoothstep of `1-distance/radius`, zero outside radius. Resample pointer movement at <=radius/4 spacing so fast drags do not leave gaps; distribute the accumulated time across the interpolated samples rather than adding extra strength.

Flatten interpolates toward a fixed sampled/entered target height with time-scaled bounded blend. Smooth reads a copy of the affected pre-step neighborhood, then applies a weighted mean; never use iteration order as part of the result. Noise uses the stored seed/frequency/amplitude and generator version. Clamp per-stroke work to chunks while always updating the latest brush outline and coarse preview.

Brush controls: Raise, Lower, Smooth, Flatten, Noise, Paint layer, Erase layer, Hole; radius, strength, falloff curve preset, pressure toggle, target height, slope/height filter. GPU buffer subranges and local normals update for dirty rectangles plus one-sample border. Final normals and lower LODs update after the gesture. One stroke is one undo entry storing before/after changed tile rectangles.

### 9.3 Height import and material layers

Accept grayscale 16-bit PNG for heightmap import initially. Preserve integer precision, show min/max heights and choose vertical scale/offset; do not load through an 8-bit color conversion. Add Float32 grid import through a validated documented format only. Export 16-bit PNG with scale/offset metadata or raw Float32 tile data in the native package.

Paint weights use RGBA weight tiles, four active layers per material chunk initially. Normalize weights; base layer receives remaining weight. Each layer references PBR maps, world tile size, tint and optional slope/height rules. Paint masks and procedural weights are combined in a declared order and stored with generator version. Surface hole masks affect geometry, depth, shadow and placement consistently.

### 9.4 Scatter algorithm

Scatter descriptor stores region polygon/mask, weighted asset list, seed, density per square meter, minimum distance, scale range, yaw range, normal alignment amount, slope/height ranges, exclusion masks, support surface ID and explicit removed-instance keys.

Use the following fixed `xorshift32-v1` PRNG for placement, not cryptography. Hash the UTF-8 string `seed|systemId|cellX|cellZ|candidateIndex` with FNV-1a: start `2166136261`, for each byte apply `h = Math.imul(h ^ byte, 16777619) >>> 0`; signed coordinates are decimal without leading zeroes. Replace a zero result with `0x6d2b79f5`. Each random draw applies `x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0` and returns `x / 4294967296`. Use identical uint32 wrapping in tests and Python diagnostics. Store the algorithm name and fixed draw order: X, Z, density rank, priority, asset choice, scale, yaw. Extra future random properties need separate named streams so they do not reorder old draws.

Generate candidates in fixed 16x16 m cells with a stored `candidate_density_ceiling` and row/index ordering. A candidate's density rank determines inclusion at requested density; increasing beyond the ceiling explicitly regenerates the source recipe. Sample the surface, reject by region/exclusion/slope/height, then use a spatial hash with a halo at least the maximum exclusion/minimum-distance radius. For reproducible bounded dependency, use local-priority thinning: reject a candidate if any eligible candidate within minimum distance has a smaller `(priority, stableKey)` tuple, whether or not that neighbor itself survives. This trades some maximum packing density for deterministic local updates; display requested and achieved density. It avoids a greedy acceptance chain propagating across the entire world. Freeze the candidate and acceptance algorithms as part of `generator_version`.

Use a stable instance key derived from system ID/cell/candidate index. Density changes should preserve earlier accepted candidates where possible. Changing one exclusion region regenerates affected cells and their halo, not the entire world. Paint scatter maintains the same seed stream; erased instances persist as tombstones.

Batch mesh instances by immutable geometry/material/LOD and spatial cell, update only dirty matrices, recompute bounds, and maintain instance-key -> picking-ID mapping. Imported multi-mesh assets need one batch per submesh/material; instance count is not equal to draw-call count. Animated/skinned assets use independent objects unless a tested instancing path exists. Spark assets use a separate supported Splat adapter or individual budgeted objects; do not send splats through mesh instancing.

### 9.5 Splines, roads, fences and water

Spline data stores control points, interpolation (polyline/Catmull-Rom), closed state, per-point width/elevation and terrain-conform mode. Build an arc-length lookup table with error tolerance; sample by distance, not raw parameter, so fence posts stay evenly spaced.

Generate road strips from centerline tangent and surface normal. Miter joins have a bounded ratio with bevel fallback. Settings: width, thickness, camber, material, UV distance scale, shoulder width, terrain offset. Terrain carving is a separate non-destructive layer with blend radius; changing the road invalidates only intersected tiles. Road intersections start as explicit junction pieces with tested T/X geometry rather than an unbounded automatic road-network solver.

Fences use distance-spaced instanced posts plus rails; expose endpoint caps, slope-follow versus stepped segments and spacing. Water starts as polygon/plane geometry with level, tint, opacity, roughness and normal map animation. Its conditioning policy is explicit (surface or through); reflections/foam/flow are P2 presentation features, not prerequisites for terrain editing.

## 10. Precise transforms, placement and reusable geometry

Transform gizmos use World/Local space, axis/plane constraints and explicit pivot modes: median, bounds center, active object, individual origins, cursor, custom. The mathematical pivot is independent of the displayed bounding box. Pivot editing preserves the current world geometry by compensating position according to the transform equation in section 5.

Support snapping to grid, vertex, edge midpoint, face, surface normal and angle. Use a screen-space hit threshold and show the active snap target. Mesh hits use BVH where available; splats use the selected conditioning/collision proxy. Box approximation is labeled in the Placement section.

Drop individually casts downward from multiple support points on the selected object's base; choose a support transform consistent with the selected placement mode. `Keep upright` changes only height. `Align to surface` rotates the local up axis toward the sampled normal by the configured blend, preserving yaw around that normal. Exclude selected objects and hidden/non-supporting targets from queries. Apply clearance in meters. Group drop preserves relative transforms and uses a collective support hull.

Continuous collision checking is a placement aid, not a physics simulation. Broad phase uses world bounding volumes; narrow phase uses mesh/proxy queries. Show penetration or invalid support before commit; offer Allow overlap because intentional intersections are useful in scene building.

Add Box, Sphere, Cylinder, Cone, Plane and profile extrusion. Each has dimensions and bounded segment counts, editable until Convert to mesh. A profile extrusion stores outer/inner contours and depth; use the same polygon validation as slabs. Linear/radial/grid arrays store source refs, count, spacing/angle, pivot and linked/unlinked mode. Generate preview instances while changing count; commit recipe, not thousands of duplicated JSON objects.

Align supports min/center/max along an axis with World/Local choice; distribute by origins or equal gaps between bounds. Preview before commit. Mixed selection uses valid shared transform capabilities; cameras/lights are not resized as if they were mesh assets.

## 11. Materials, imports and asset workflows

### 11.1 Material contract

Unified material descriptor includes: stable material ID, name, model (`standard`, `physical`, `unlit`), linear base color factor, base-color map, roughness factor/map, metalness factor/map, normal map/strength, AO map/strength, emissive factor/map/intensity, opacity/alpha map, alpha mode/cutoff, side mode, transmission, IOR, thickness, and mapping descriptor. Displacement is a separate geometry feature and must not be advertised as actual geometric conditioning if only a normal map is changed.

Color/emissive textures are sRGB inputs; normals, roughness, metalness, AO and masks are non-color linear data. Explicitly record packed-channel assignments rather than infer arbitrary filename conventions. Imported materials retain their texture transforms and slot mapping until overridden.

Mapping modes: mesh UV, planar, triplanar for supported mesh/terrain materials. Mapping settings: physical tile size in meters, UV scale/offset/rotation, projection origin and local/world anchoring. Reuse texture images across materials but separate sampler/UV state as needed; editing one material must not rotate unrelated textures through a shared mutable Texture object.

Architecture material IDs map into the unified definitions during migration. Preserve IDs and side assignments. Per-object overrides address stable internal material-slot IDs; selecting a submesh exposes the material path. Editing a shared material indicates the number of users and offers Make unique. Applying to a room offers Walls/Floor/Ceiling/All with an exact surface count.

### 11.2 Gaussian material boundaries

Splats contain appearance that is not equivalent to mesh PBR channels. Their Inspector exposes supported tint, exposure/opacity, renderer lighting mode, conditioning proxy, shadow proxy, and emission approximation. Do not show a normal-map or roughness-map editor which cannot affect the splat renderer.

Provide `Original appearance` and `Approximate relighting` as explicit modes; preserve the current relighting interpretation on legacy scenes. Material-related proxy settings affect conditioning geometry, not a claim that PLY has become an editable mesh surface.

### 11.3 Import options

Retain existing GLB/glTF/FBX/OBJ/STL/Gaussian PLY routes. Import dialog shows original bounds, source units/orientation if available, missing resources, polygon/splat counts and options:

- `Keep source size`, `Specify units` (m/cm/mm/ft/in), or `Fit longest side` (legacy default 2 m).
- Up axis, forward axis and ground/center/original-origin placement.
- Preserve hierarchy/materials, generate normals only when absent, texture color-space inspection.
- Optional simplify/proxy generation as a separate derived asset with original retained.

Store the exact import matrix, not just the resulting size. Existing models keep their prior normalization. Resource URLs must resolve to uploaded/package-managed resources; reject unresolved external references rather than silently fetch arbitrary model-supplied URLs. Reuse reviewed backend validation and allowlisted local resource resolution.

### 11.4 Prefabs and replacement

Extend library entries with `prefab` type containing entity graph, materials, relative placement, exposed parameters and immutable source revision. A prefab instance stores source ID/hash and property overrides. Updating a library source does not automatically change an open scene; an explicit Update instances action previews the affected count and revision.

Override precedence: source defaults -> instance overrides -> active variant overrides -> shot overrides. Overrides use typed entity-relative keys. Detach creates independent entities with current evaluated values. Replace asset preserves object ID, transform, collection/floor membership, semantic tags and compatible material overrides; show unresolved slot mappings before commit.

Thumbnails use a bounded async queue, retain old thumbnails until new ones are ready, and never steal editor selection/camera. Asset search supports tags, type, dimensions and Favorites; expose saved camera/room/building presets alongside object assets.

## 12. Lighting and environment

### 12.1 Retained light runtime and budgets

Replace full light-rig reconstruction with `Map<lightId, runtimeLight>`. Create/dispose only when a light is created/deleted or its type changes. Position/color/intensity/target/angle changes update retained objects. Shadow targets reallocate only when map size/type changes. Transforming a light marks its shadow dirty; changing a color alone does not rebuild depth geometry.

Keep the current maximum of 32 authored local lights through P0. Initially all eligible lights contribute illumination, while a separate allocator assigns at most 2/4/6/8 realtime shadow lights according to quality. Hidden/zero-intensity lights do not consume allocation. Point lights cost six cube faces; account for faces and bytes as well as light count. Directional/Spot costs differ.

Allocation priority: explicit pin -> relevant shot/viewport influence -> contribution estimate -> stable ID, with hysteresis to avoid flicker. Inspector/outliner shows `Shadow active`, `Shadow deferred`, or `Disabled`, with reason. Disabling shadow maps may cause approximate light leakage; keep this a visible Draft preview policy, not an unannounced physically correct final result.

Final mode supports two profiles:

- `Match preview`: capture the exact active lighting approximation and record it.
- `Complete shadows`: require all requested lights to have valid shadow handling within the validated device budget. If unsupported, stop with the specific count/size constraint and offer a lower map size or Match preview; never silently omit a light.

Increasing authored lights beyond 32 is a later measured feature. Partition lights by spatial cells and introduce a tested bounded light-list strategy before raising limits. Do not implement an untested giant shader array or claim unlimited fully shadowed lights. Every stored inactive light is identifiable in UI and capture metadata.

### 12.2 Light controls

Point: position, color/Kelvin, intensity, range, decay behavior, shadow enable/quality/bias controls. Spot adds target/orientation, full cone angle and penumbra. Directional adds orientation/target, intensity, shadow coverage and cascade profile where implemented. Keep legacy `Strength` units unchanged; expose photometric units only through a verified adapter with a declared conversion and tests.

Area: rectangle width/height, pose, one/two-sided mode, intensity and emission color. Three `RectAreaLight` with r180 matching uniform initialization gives PBR mesh illumination, but has **no native shadow support**. Offer unshadowed area preview or explicitly labeled sampled-source proxy shadows using a deterministic bounded light sample set. Do not label proxy shadows as exact area-light transport. Gaussian relighting uses its own approximation adapter. [Three area-light limitations](https://threejs.org/docs/pages/RectAreaLight.html).

Material emission can illuminate through the existing sampled-light approximation; preserve and expose its budget. Distinguish visible emissive color from actual light emission. Test that switching a material to emissive does not unexpectedly allocate dozens of full-resolution shadow cubes.

### 12.3 Environment

Store independent `background` and `illumination` sources/settings. Background supports color/LDR/HDR texture, rotation, exposure and blur. Illumination uses a cached PMREM environment for mesh materials; intensity/rotation updates should reuse the processed map where the r180 API supports them. Reprocess only when the source or required filtered representation changes. The existing background skydome is migrated with environment illumination disabled to preserve appearance. [PMREM reference](https://threejs.org/docs/pages/PMREMGenerator.html).

HDR/EXR upload validation is explicit and format-aware; Pillow validation for PNG must not be assumed to decode every HDR container. At the upload boundary bound bytes, dimensions, channel counts and decoded memory; parser rejects corrupt/unsupported compression variants. Preserve original files, derive viewport previews and retain float lighting data. Select and test the exact r180 loader implementation.

Procedural sky starts with controlled horizon/zenith colors, sun direction and atmospheric preset; a physical sky addon is optional after compatibility validation. Fog has enabled/color/density or near/far mode. Mesh and splat fog must agree or show separate renderer capabilities. Fog, sky and reflections affect beauty; geometry depth and normals remain unmodified unless an explicitly separate atmospheric pass is requested.

## 13. Camera matching, shots and navigation

### 13.1 Canonical camera

Camera data: camera ID, name, world position/quaternion, projection kind, vertical FOV or orthographic span, clip planes, principal point, sensor height, optical focus distance, aperture, reference ID and lock state. Store aspect in shot/output profile; camera calibration metadata includes the aspect used during matching.

Keep legacy `position/target/up/fov` through adapters. Orbit target distance and optical focus are separate fields. For a centered perspective camera, `fy = H / (2*tan(fovY/2))`, `fx=fy` for square pixels, `cx=W/2`, `cy=H/2`; principal-point offsets modify `cx,cy`. Focal length in millimeters is derived from declared sensor height, never inferred without a sensor size. Changing aspect does not silently change vertical FOV.

Export both the Three camera-to-world matrix and an explicit CV world-to-camera matrix, specifying row-major serialization. Three camera local axes are +X right, +Y up, -Z forward; CV axes here are +X right, +Y down, +Z forward. Conversion is `C = diag(1,-1,-1,1)`, `world_to_camera_cv = C * inverse(camera_to_world_three)`. Store intrinsics, image dimensions, projection type, near/far, distortion policy and coordinate convention in every shot manifest.

### 13.2 Reference modes

Reference images have explicit roles: object-generation source, camera-match background, floor-plan underlay, and scene image plane. Do not reuse one `source` state slot for all four. Each reference stores asset ID, image dimensions, role, opacity and placement/calibration metadata.

Camera-match background is a screen-space overlay outside scene geometry and capture by default. Controls: fit/fill/1:1, opacity, hide while navigating, difference/edge overlay, show/hide, compare wipe. An image plane is actual scene geometry and may render; the UI must make that distinction clear.

### 13.3 Perspective matching algorithm

Start with a deterministic manual solver, then optional assistance:

1. User draws at least two lines for each of two orthogonal world directions in image coordinates; intersect homogeneous image lines to estimate vanishing points. Add a third direction or a known vertical when available.
2. Assume square pixels, zero skew, known image center/principal point unless the user unlocks it. For orthogonal vanishing points `v1,v2` and center `c`, initialize `f^2 = -(v1-c) dot (v2-c)`. Reject invalid/negative focal solutions and nearly parallel unstable line sets instead of inventing a camera.
3. Back-project through `K^-1`, normalize directions and orthogonalize into a rotation with determinant +1, resolving sign using the user's selected world axes and visible ground direction.
4. User defines a ground-plane origin and one known length between two ground points. This resolves scale/translation constraints that vanishing points alone cannot determine. Show a human-scale reference object.
5. Refine selected parameters with a bounded damped least-squares solve minimizing image line/point residuals; use Huber loss and display residual pixels and underconstrained parameters. Preserve user locks. Worker results carry reference/camera revision tokens.
6. Preview camera and scene overlays continuously, then commit one camera-calibration command. Keep the source guides editable. Warn if output cropping/aspect invalidates the calibrated framing; offer Keep framing or Refit explicitly.

Implement small linear algebra locally using typed arrays/Three vectors; add synthetic projection fixtures before optimizing. Automatic line detection may use existing OpenCV on the backend later, but the manually specified solution is the required baseline. It does not infer hidden room dimensions or reconstruct an entire scene from one image.

### 13.4 Shots and camera paths

Shot descriptor: stable shot ID, camera ID, name, enabled, order, output profile, variant selection, visibility overrides and optional time sample. Bottom shot cards show thumbnail, aspect, resolution and stale/current capture state. Entering a shot changes only the evaluated preview context; saving camera changes requires an explicit action when the shot is locked.

Reuse existing camera-path interpolation and quaternion continuity. Add path duration/fps, frame range, constant-speed toggle with arc-length reparameterization, easing and per-point FOV/focus. Timeline supports scrubbing during pointer movement, point drag, duplicate/delete, snapping and one command per gesture. Frame output is an ordered image sequence first; compressed video is not a dependency and must not introduce shell-based encoders.

## 14. Conditioning and capture pipeline

### 14.1 Output compatibility and proposed nodes

Preserve the current `VNCCS_3DFactory` output at slot 0: `preview`, type IMAGE, list semantics, item 0 current view followed by saved cameras in existing order. Do not convert this to a tensor batch or reorder existing items. Add slot 1, type `VNCCS_FACTORY_SCENE`, non-list, containing an opaque immutable render handle. Update node registration and validate existing saved link indices. Existing workflows connected only to preview behave as before.

Proposed `VNCCS_FactoryRender` consumes that handle and a named capture profile; it does not accept arbitrary filesystem paths. It has fixed outputs:

| Slot | Name / type | Semantics |
| --- | --- | --- |
| 0 | `rgb` / IMAGE LIST | N tensors `[1,H,W,3]`, display RGB in 0..1 |
| 1 | `depth` / IMAGE LIST | N three-channel normalized depth previews; raw depth remains in capture |
| 2 | `normal` / IMAGE LIST | N encoded unit normal maps; declared space in metadata |
| 3 | `alpha` / MASK LIST | N tensors `[1,H,W]`; 1 means foreground/coverage |
| 4 | `object_id` / IMAGE LIST | N RGB24 ID images; no color management/resampling |
| 5 | `camera_metadata` / STRING LIST | N JSON strings, one per shot |
| 6 | `capture` / `VNCCS_FACTORY_CAPTURE` | Non-list immutable capture handle |

All six list outputs have identical N and shot ordering. This initial node always creates its six declared outputs; no empty-list placeholders for disabled passes. A future pass-on-demand node can consume the capture handle without destabilizing this fixed contract. Global width/height apply across shots in a render request initially. Heterogeneous output sizes require a later explicit list-only profile, not implicit batching.

Proposed `VNCCS_FactoryMask` consumes capture handle plus object/collection/semantic selections and returns a MASK LIST and per-shot metadata. It combines stable integer IDs and coverage data, never thresholds a decorative random-color segmentation preview. `mask=1` means selected region; Invert is explicit. Optional dilation/erosion/feather is postprocessing with pixel units, leaving raw IDs unchanged.

The scene handle contains `scene_id`, `content_revision`, `render_revision`, immutable manifest hash and allowed asset references. It contains no open GPU objects, credentials or absolute machine paths. Backend verifies it against persisted content before capture. A rerender with an outdated handle either renders its retained immutable snapshot or returns a precise expired-snapshot error; it never renders a newer scene under an older signature.

ComfyUI list behavior must be tested with actual downstream nodes as well as Python contracts. [ComfyUI data-list contract](https://docs.comfy.org/custom-nodes/backend/lists).

### 14.2 Render specification and cache identity

Freeze `{sceneHash, assetHashes, cameras, shotOverrides, width, height, passProfile, rendererBuild, geometryGeneratorVersions, conditioningProxyHashes, lightingProfile, quality, seed}`. Canonicalize sorted object keys, finite numbers and stable ordered arrays before hashing. UI layout, hover, selection and thumbnails are excluded. Pass/camera ordering is included.

Capture sequence:

1. Complete the persistence barrier and freeze evaluated scene/shot data.
2. Verify dependencies and required proxy availability.
3. Allocate or reuse render targets, bound by GPU capability and memory budget.
4. Render all passes for each shot from its identical frozen projection and scene geometry.
5. Read back/encode in bounded stages; upload parts with hashes and declared format.
6. Backend validates dimensions, pixel counts, numeric finiteness/ranges, part count, signature and expected shot IDs.
7. Publish the complete capture manifest atomically only when every required part is valid.
8. Restore previous editor camera/quality/visibility/target in a `finally` block if sharing the live renderer.

Prefer a dedicated capture evaluation context with shared immutable assets, not mutation of durable editor state. Do not show a black/loading-only frame while readback proceeds. If shared rendering cannot maintain interactivity during large captures, keep the last frame and expose capture progress/cancel without claiming ongoing interactive rendering.

### 14.3 Geometry depth and normals

For meshes, architecture and terrain, render dedicated shaders with skinning/morph/instancing support where relevant. Depth is positive camera-forward view depth `d = -position_view.z` in meters, not raw nonlinear hardware z and not radial distance. Orthographic cameras follow the same view-depth definition. Panorama depth, when later supported, is explicitly radial and uses a different profile.

Canonical depth file: Float32 little-endian HxW in row-major top-left order, background 0 plus a validity mask. Validate dimensions and exact byte count; finite foreground samples must be positive. Optional 16-bit PNG encodes a declared linear interval and carries min/max metadata; never silently downcast through 8-bit image loading. Portable GPU fallback encodes linear normalized depth to RGBA8 with a documented 24-bit quantization, then decodes to meters; record quantization. Prefer true float targets/readback only after device tests pass.

ComfyUI depth IMAGE defaults to near-white inverse-linear visualization: `g = 1 - clamp((d-depthMin)/(depthMax-depthMin), 0, 1)`, background 0. Offer linear/inverse-linear/disparity profiles with explicit formulas; disparity uses a positive epsilon and its own normalized near/far range. Preserve raw metric depth independently. Near/far for clipping and depthMin/depthMax for normalization are different properties.

Normals default to geometric view-space normals in the declared Three camera axes, transformed with the inverse-transpose normal matrix, renormalized and encoded `rgb = 0.5*n+0.5`. World-space normals are another explicit profile. Default excludes normal maps so geometry conditioning is stable; `Shading normals` includes them only as a separate mode. Background is `(0.5,0.5,0.5)` plus validity=0. Double-sided behavior follows the selected conditioning policy, and normal direction conventions are recorded.

Numeric fixture: a front-facing plane at view depth 2 m must produce `2 +/- max(0.001, quantization error)` across its valid interior. A rotated plane must produce expected unit normals with <=1 degree angular error for 8-bit normal encoding. Test perspective/orthographic projections, nonuniform scale, mirrored baked geometry, transparency and image row orientation.

### 14.4 Gaussian conditioning

Do not apply `MeshDepthMaterial`/`MeshNormalMaterial` to a Spark splat and assume valid output. Define a separate conditioning representation per Gaussian object:

| Mode | Implementation | Product promise |
| --- | --- | --- |
| `supplied_mesh` | User/imported aligned mesh proxy | Mesh-derived geometry maps; source quality depends on supplied proxy |
| `box` | Oriented editable bounds mesh | Coarse blockout only; default fallback requires visible acknowledgement in capture profile |
| `sampled_proxy` | Deterministically sampled covariance ellipsoid surface or reconstructed retained proxy | Approximate geometry with sampling/version metadata; validate silhouette before enabling |
| `native_splat_depth` | Dedicated verified Spark adapter, if feasible on pinned build | Optional research gate; depth semantics and transparency threshold must be demonstrated |

P0 supports supplied mesh and explicit box fallback. A scene with splats but no approved conditioning representation fails detailed conditioning capture with actionable object names; RGB remains available. Do not output blank or falsely exact normals. A one-click `Use coarse proxies for this capture` assigns the box mode explicitly.

P1 sampled proxy reuses proven shadow sampling where possible but does not confuse a sparse shadow proxy with a watertight surface. Store sampling limit, alpha threshold, covariance scale, algorithm version and hash. Show proxy overlay in the viewport; allow replacing and aligning a supplied mesh. Optional native depth is not a prerequisite for completing mesh/architecture/terrain outputs.

Beauty and conditioning may have different splat silhouettes when a proxy is used. Store per-entity approximation metadata and show it in Output before capture. Do not label all passes pixel-exact merely because their camera matrices match.

### 14.5 IDs, alpha and transparent surfaces

Assign a stable per-scene `entityKey -> uint24` LUT, 0 reserved for background; keys include scatter instance keys where per-instance IDs are enabled. Resolve collisions by allocation, not truncated hashing. Include the LUT in capture manifests. Stop before exceeding 16,777,215 IDs; offer group-level segmentation explicitly. Preserve IDs through rename, transforms and undo; deleted IDs are not reused within a scene revision lineage.

ID shaders output integer RGB24 bytes with no blending, tone mapping, sRGB transfer, dithering or MSAA. Nearest sampling only. Edge antialiasing comes from a separate coverage mask, not interpolated IDs. For mask feathering, process binary selection/coverage after ID lookup. A display palette is a separate visualization and never the machine-readable ID map.

Conditioning material policy: opaque surface by default; cutout uses material alpha cutoff; glass offers `Surface` or `Through`; water follows its explicit policy. All depth/normal/ID passes use the same evaluated policy. Beauty can retain physical/translucent appearance. Semi-transparent splats require the proxy/native-alpha policy; a single pixel cannot encode an arbitrary layered object list in RGB24.

Alpha output represents capture foreground coverage independently of skydome. Background sky can be included in RGB while alpha remains zero outside geometry; expose `Include background in alpha` explicitly. A MASK uses foreground=1, never an undocumented inversion.

### 14.6 Capture durability and render host

Keep current fresh-capture tokens and revision-matched fallback. New jobs use staged parts and immutable manifests, with progress stages `resolve`, `geometry`, `render`, `readback`, `validate`, `publish`. Scope events by node ID, scene ID, job ID and request sequence. Cancellation or timeouts clean staged parts after a bounded retention period and never invalidate the last complete capture.

For P2 batch rendering without the editor open, add a Factory-owned same-origin render-host page served by existing ComfyUI routes. It loads the same pinned runtime modules, registers capabilities through existing API mechanisms, receives immutable jobs and uses `api.fetchApi` for validated assets/parts. The user opens it explicitly through `Open render host`; no backend process launcher or new raw network client is required.

An open render host is still a browser client, not a browser-free backend renderer. If no render host is available, allow only exact-signature cached captures; fresh jobs fail with `Render host required`. True browser-free fresh rendering is outside this implementation baseline and requires a separately selected renderer supporting both mesh and splat contracts. Do not claim arbitrary fresh headless generation with only Python/Pillow.

## 15. Presentation modes, variants and export

Viewport modes: Beauty, Clay, Material, Wireframe, Depth, Normal, Object IDs, Collision/Conditioning proxy. Switches affect preview only; output pass profile remains explicit. AO/contact shadows/DOF use a tested postprocess chain for beauty and do not contaminate geometry passes. Disable effects in draft only with visible quality state. Native splat compatibility is verified separately for each effect.

Variants are named typed override sets for materials, transforms, visibility and lighting. Do not copy whole scenes for each variant. Conflicting overrides follow the precedence in section 11.4. Show evaluated values with an override indicator and reset-to-source action. Shot thumbnails include variant revision in cache identity.

Extend current `.vnccs3d` packaging with `package_version: 2`, feature versions, dependency hashes, new binary tiles/proxies, prefab sources, shots and variants. Continue reading old packages with absent package_version as v1. Keep old SCHEMA reads; a new package identifier or field must be handled explicitly by import/library validation, never silently accepted by old readers.

Export profiles:

- `Native scene`: complete `.vnccs3d`, preserving editable data and original assets. Reuse current package writer/extractor and add the new references.
- `Geometry GLB`: evaluated mesh/architecture/terrain/parts, transforms and supported materials/cameras. Bake procedural instances or use an explicitly supported instancing extension. Splats remain excluded unless a supplied proxy is explicitly chosen; show a coverage report before export.
- `Gaussian PLY`: retain current visible-Gaussian export and metadata; include nonuniform transforms only after covariance/export tests pass.
- `Capture package`: images/raw maps plus camera/ID/quality manifests, stable names and hashes.
- `Camera path frames`: ordered image sequence and timestamp manifest; no shell video encoder.

Archive import validates member paths, symlinks, extracted byte/file limits, hashes and all references before installing atomically. No live file references escape the package. A package round trip must reproduce entity IDs where possible or provide a complete deterministic remap for every reference. Derived SPLAT/PMREM/viewport caches remain reconstructible and are not mandatory package payloads.

## 16. Performance, memory and lifecycle requirements

### 16.1 Proposed performance targets

Targets below are acceptance goals, not measurements of the current implementation. Before making them a release claim, record actual GPU, driver, browser, ComfyUI frontend/backend versions, viewport size and display scale on the real runtime machine. Model-generation VRAM and browser-rendering memory may be on different devices and must be reported separately.

| Metric | Initial target on the declared reference machine | Measurement |
| --- | --- | --- |
| Normal transform/camera gestures | >=30 FPS, p95 visible response <=50 ms | Pointer timestamp -> first rendered accepted state |
| Terrain/scatter expensive gestures | Visible ghost/brush <=50 ms; coarse geometry update <=100 ms | Diagnostic event/frame stamps |
| Main-thread work | No repeated >50 ms tasks during ordinary edits | PerformanceObserver plus command spans |
| Idle editor | No unconditional continuous redraw | Renderer frame counter over 10 idle seconds |
| Selection in 5,000-row outliner | p95 <=50 ms for selection + Inspector | Store event -> DOM layout completion |
| Local mesh/light edit | Zero unrelated asset reloads or scene reconstruction | Instrument loader calls and resource identities |
| History | Bounded at selected byte budget | Bytes of patches and pinned binary diffs |
| Repeated open/close | Resource/listener counts return to baseline after disposal | 20 create/remove cycles with diagnostics |
| Capture correctness | No mixed revisions, incorrect ordering or partial publication | Manifest/part signatures and synthetic pixel fixtures |

Reference scene classes:

- Small: 100 mesh entities, 100k evaluated triangles, 2 local lights, one room, one 131k-splat asset.
- Medium indoor: 1,000 entities, 2M evaluated triangles, 10 rooms across 2 floors, 32 local lights, 1M visible splats, 8 shots.
- Outdoor: 256x256 m terrain at 0.5 m spacing, 10,000 mesh instances distributed over cells, 10 repeated assets with documented LOD triangle counts, 3 buildings, 4M splats at selected preview quality.
- Stress: 5,000 outliner entities, 100,000 scatter instances and 16 shots. This is a graceful-degradation test, not a promise of 30 FPS at full quality.

Count visible triangles after instancing/LOD and list texture dimensions/formats so the benchmark is reproducible. Generated fixtures must use deterministic assets or checked-in small licensed geometry; no external download is required to run the baseline benchmark.

### 16.2 Resource ownership

Central cache keys combine asset hash, decoding options, material/shader variant and relevant UV/sampler state. Refcount shared geometry/material/texture resources. SceneRuntime owns entity nodes, AssetRegistry owns immutable sources, ResourceCache owns GPU derivatives and CapturePipeline owns render targets. Disposal only occurs when the owning service has no users.

Estimate texture memory including mipmaps and render-target formats; report estimates as estimates because browsers do not expose universally accurate total VRAM. Default viewport texture ceiling: 2K maps, expandable to 4K on capable devices; capture requests its explicit quality. Do not resample raw depth/ID data through image texture quality settings.

Use spatial cells for instances and broad-phase queries. BVH builds run in a worker or bounded chunks and reuse immutable geometry hashes. Refits are allowed for limited vertex changes when the chosen BVH implementation supports them; terrain uses direct grid sampling for height queries rather than repeatedly rebuilding a global mesh BVH.

For large coordinate scenes, subtract a render origin near the active camera from GPU-visible positions while preserving canonical double-precision JS meter coordinates. Rebase only at a stable distance threshold (initially 1,000 m), update all runtime cameras/lights/helpers consistently, and freeze origin during capture. Origin must not alter exported camera/world coordinates.

### 16.3 Render scheduling and lifecycle

Use dirty flags for scene, camera, overlays, lighting, materials, geometry and capture. Re-render on demand, with continuous frames only during active navigation, gestures, playback or a required progressive effect. Update Spark dirty state only when its content/view requires it.

RenderScheduler prioritizes current interaction, then visible inset/thumbnail work, then background derivatives. It never lets thumbnail or library tasks reload the scene. GPU context loss preserves scene metadata, displays recovery state and rebuilds derivatives on restoration; active capture becomes retryable, never falsely completed.

Node removal cancels gestures, workers, capture ownership, observers, timers, api listeners and global key handlers. Expanded editor returns/cleans its root. Scene switch cancels old jobs by ownership token and preserves pending saves before loading another scene. Multiple Factory nodes have independent selection/history/cameras, share only immutable caches and explicitly shared backend scenes.

## 17. Implementation work packages and dependency order

Deliver each work package as a reviewable change with focused fixtures. A row is complete only when its exit criteria pass. UI replacement is intentional, but it is staged behind an internal development switch until feature parity passes; users should not need to migrate twice.

| Package | Priority / dependencies | Concrete implementation work | Files/services | Exit criteria |
| --- | --- | --- | --- | --- |
| WP01 Baseline defects | P0 / none | Add architecture-only node regression; share renderability fixtures; fix light overflow and hidden-light budget consumption; identify current output order | `nodes/factory3d.py`, current widget/viewer, node/frontend tests | Architecture-only scene captures; 9th eligible light does not disappear under 8-shadow budget |
| WP02 Contract fixtures | P0 / WP01 | Define v12/18 contracts, property descriptors, ID domains, transforms, capture metadata; add JS/Python golden cases | schema, contracts, migrations tests | Both normalizers accept/reject the same cases and preserve baseline appearances |
| WP03 Transactions/store | P0 / WP02 | Store facade, typed commands, dirty refs, patch history, per-gesture cancel, revisions, queue barrier | core modules + backend transactions/storage | One command per gesture; undo/redo/cancel; stale saves cannot overwrite newest data |
| WP04 Retained runtime | P0 / WP03 | Extract resource cache/scheduler/light map behind old viewer API; targeted invalidation | runtime modules + viewer facade | Identity/resource-count tests prove no unrelated rebuild on transforms/light edits |
| WP05 UI primitives | P0 / WP03 | Numeric/vector/color components, focus/scroll manager, menus/command registry, property capability model | UI components and CSS | Live peers, invalid drafts, row alignment and keyboard behavior meet section 7 |
| WP06 Editor shell | P0 / WP05 | Resize side docks; expanded mode; distinct Objects/Inspector tabs; port generation/library/cameras/export | workspace, panels, widget facade | All existing tools reachable; resize/fullscreen/restore works without extra renderer |
| WP07 Mixed selection/transforms | P1 / WP04-06 | TRS v2, multi-property editing, pivot/space/snaps, typed selection, align/distribute | transform/selection tools, Inspector | World-preserving migration and reparent; mixed edits one undo; unsupported shear detected |
| WP08 Capture core and node outputs | P0 / WP02-04 | Fix frozen snapshot handling; staged capture API; stable handle output and render/mask nodes; mesh/proxy pass shaders | capture pipeline/backend/nodes | Plane depth/normals/IDs correct; lists preserve order; original slot-0 links survive |
| WP09 Reference and camera matching | P0 / WP05-06, WP08 metadata | Reference roles, camera lens/target separation, guide drawing, calibrated solver, compare overlay | camera match, reference assets, shots UI | Synthetic reference calibration converges and preserves projection through save/reload |
| WP10 Architecture topology | P1 / WP03, WP06-07 | Wall graph, polygon rooms, shared-wall operations, hole loops, numeric dimensions | architecture tools/geometry/runtime/schema | L/T/X joins, L-shaped room, shared walls and openings remain valid through edits |
| WP11 Building parts/openings | P1 / WP10 | Stairs/ramps/slabs/roofs/beams/railings; frame/leaf/window inserts | parametric_parts, opening Inspector | Two-floor house and open doors have correct visible and conditioning geometry |
| WP12 Unified materials/import | P1 / WP02, WP04-06 | Material descriptors, imported-slot overrides, source units, map/mapping editor, material library | assets/materials/model_loader/backend | Legacy imports unchanged; new physical units and shared/unique materials round-trip |
| WP13 Surface placement/primitives | P1 / WP07, WP12 | BVH compatibility gate; mesh/proxy snapping, Drop/align, primitives/extrusion/arrays | spatial index, support solver, placement/geometry | Sloped/table/stair placement tests pass; box fallback clearly identified |
| WP14 Terrain | P1 / WP03-06, WP08, WP12 | Tile format, brush tools, worker updates, import/export, layers, holes, fixed capture geometry | terrain workers/runtime/API | Realtime edits; adjacent tile seams and undo diffs correct; capture agrees with sampled heights |
| WP15 Scatter/splines | P1 / WP13-14 | Deterministic cells, instance IDs/LOD, region masks, roads/fences, terrain layers | scatter/spline tools/workers/runtime | Fixed seed reproduces transforms; local changes affect only dependent cells/tiles |
| WP16 Lighting/environment | P1 / WP04-06, WP12 | Full light types/settings, area approximation, HDR/EXR validation, PMREM, independent background/fog | lighting/environment services and UI | Capabilities honest; legacy lighting unchanged; budget state/capture policy explicit |
| WP17 Prefabs/organization | P1 / WP03, WP07, WP12 | Nested collections, library prefabs, overrides, asset replacement, favorites/search | asset registry/library/outliner | Shared prefab update explicit; replacement preserves identity/placement/compatible overrides |
| WP18 Scene scale | P1 / WP04, WP13-17 | Tune cell/LOD/cache budgets, outliner virtualization, worker scheduling, origin rebasing | diagnostics/runtime/UI | Declared benchmark goals or visible bounded degradation on target hardware |
| WP19 Shots/variants/presentation | P2 / WP08-09, WP16-18 | Override evaluation, shot cards, view passes, beauty effects, section/multi-view support | shots/render/variant UI/runtime | Per-shot repeatability; effects do not alter raw geometry passes |
| WP20 Export/package | P2 / WP08, WP11-17 | Native package v2 extension, direct export, GLB coverage report, capture ZIP, covariance tests | library/storage/export services | Cold package round trip preserves all new dependencies; partial formats report exclusions |
| WP21 Path capture/render host | P2 / WP08, WP19-20 | Timeline improvements, frame-sequence jobs, same-origin render host, exact cached reuse | camera path/capture routes/host | Long sequence resumes/retries without mixed frames; no-host fresh render fails clearly |
| WP22 Parity/release | P0/P1/P2 gates / relevant packages | Runtime acceptance, documentation/workflow examples, migration/rollback exercise, cleanup of obsolete UI | tests/docs/registration/facades | No missing legacy capability; required host evidence attached; migration recoverable |

Critical path to the first useful release: WP01 -> WP02 -> WP03 -> WP04; then WP05/WP06 and WP08; then WP09 and the first release gate. WP08 need not wait for advanced terrain, scatter or a completed shell rewrite to validate the geometry pipeline. Dependency branches describe implementation order, not an instruction to spawn agents.

Recommended release slices:

1. **Correctness patch:** WP01 and bounded parts of WP04; no new scene schema required for the architecture-output fix.
2. **Editor + conditioning foundation:** WP02-06, WP08-09, initial WP07; retain native scene/import/generation parity.
3. **Indoor production:** WP07, WP10-13, WP16; demonstrate apartment and two-floor house.
4. **Outdoor production:** WP14-15, WP17-18; demonstrate terrain, vegetation and street modules.
5. **Shots and interchange:** WP19-21; final WP22 acceptance and user guide rewrite.

Do not estimate calendar completion from this table until the renderer/capture, schema and architecture spikes have been measured. Each package should be broken into code/test PRs with a single visible outcome rather than merged as one large rewrite.

## 18. Traceability to the original improvement table

| Original item | Implementation sections | Work packages |
| --- | --- | --- |
| 1 Architecture output | 2.2, 14 | WP01, WP08 |
| 2 Generation passes | 14 | WP08 |
| 3 Scene aligned to image | 13 | WP09 |
| 4 Lighting budget | 12.1 | WP01, WP04, WP16 |
| 5 Workspace size/layout | 7.1-7.2 | WP06 |
| 6 Tool accessibility | 7.3-7.5, 7.9 | WP05-06 |
| 7 Parameter ranges | 7.6-7.7 | WP02, WP05 |
| 8 Transform capabilities | 5.4, 10 | WP07 |
| 9 Batch editing/organization | 7.5, 7.8 | WP07, WP17 |
| 10 Surface placement | 10 | WP13 |
| 11 Complex plans | 8.1-8.2 | WP10 |
| 12 Building components | 8.3 | WP11 |
| 13 Doors/windows | 8.4 | WP11 |
| 14 Terrain | 9.1-9.3 | WP14 |
| 15 Scatter/instances | 9.4 | WP15, WP18 |
| 16 Roads/fences | 9.5 | WP15 |
| 17 Fast blockout geometry | 10 | WP13 |
| 18 Unified materials | 11.1-11.2 | WP12 |
| 19 Full lighting controls | 12.2 | WP16 |
| 20 Environment | 12.3 | WP16 |
| 21 Scene budgets | 16 | WP18 |
| 22 Asset reuse | 11.3-11.4 | WP12, WP17 |
| 23 Image/view controls | 8.5, 13.1, 15 | WP09, WP19 |
| 24 Complete scene transfer | 15 | WP20 |
| 25 Variants/batch capture | 13.4, 14.6, 15 | WP19, WP21 |

## 19. Test strategy and concrete acceptance cases

### 19.1 Automated checks by layer

| Layer | Required tests | What source assertions cannot replace |
| --- | --- | --- |
| Schema/migration | JS/Python shared fixtures, valid/invalid references, all legacy versions, future-version rejection | Actual before/after values and lossless asset references |
| Commands | begin/preview/commit/cancel/undo/redo, memory eviction, async stale-result handling | One gesture produces exactly one reversible semantic edit |
| Geometry | Expected vertices/bounds/areas/holes/normals, manifold wall/slab cases, deterministic hashes | Closed correct geometry after shared-wall edits |
| Camera math | Matrix/projection round trips, calibrated fixtures, row orientation, FOV/aspect/shift | Pixel reprojection and camera convention correctness |
| Backend | Concurrent revisions, request replay, invalid parts, archive safety, atomic capture publish | No mixed revision or incomplete capture visibility |
| Runtime facade | Retained object identities, dirty refs, loader counts, disposal ownership with stubs | No unrelated asset rebuild or resource disposal |
| UI behavior | Component event harness, command routing, drafts, mixed values, focus-state data | Controls invoke live edits rather than release-only changes |
| Actual ComfyUI host | Rendered geometry, pixels, scroll, focus, GPU timings, queue/downstream behavior | Visual correctness, input-to-frame latency and real driver behavior |

Add pure DOM-oriented tests using a small project-owned element/event harness where adequate. Do not claim native layout, GPU rendering or browser event correctness from that harness. Provide an opt-in in-widget diagnostic runner for execution on the user's actual ComfyUI installation; it emits measurements, frame captures and a JSON report through reviewed local routes.

Respect the project verification boundary: do not use the browser skill or in-app browser as evidence that VNCCS works. Runtime UI/visual verification is performed in the actual installation with the user's interaction and the diagnostic runner; local source/unit checks are reported separately.

### 19.2 Mandatory scenarios

| Case | Reproduction and acceptance |
| --- | --- |
| T01 Architecture-only | New scene -> room -> no saved cameras/models/skydome -> queue. RGB shows room; no empty-image branch |
| T02 Lighting overflow | 12 visible local lights, Medium shadows -> edit 12th intensity. Its illumination changes; active/deferred shadows explained; hidden lights consume no slots |
| T03 Gesture | Drag numeric width for 2 seconds. View changes before release, exact field follows, one undo restores pre-drag value |
| T04 Cancel | Drag gizmo/brush then Escape or pointercancel. Before state returns, no save/history command left behind |
| T05 Stale geometry | Issue slow terrain edit A then edit B; complete A last. Only B may replace preview; no black frame |
| T06 Dock state | Scroll tree/Inspector, select another object, filter, open/close modal and expanded mode. Scroll deltas <=1 px unless explicit navigation; draft/focus retained |
| T07 Multiple nodes | Open two Factory nodes and edit one. Other node camera, selection/history and API progress remain untouched |
| T08 Queue race | Edit position and immediately queue before autosave timer. Output uses latest accepted transform and exact referenced assets |
| T09 Shared wall | Two rooms share wall; add window; move endpoint and resize room. One wall remains, all owners/openings valid; undo exact |
| T10 House | Create two floors, stairs, slab hole, roof and balcony/railing. Geometry and depth agree at openings and levels |
| T11 Terrain seams | Stroke across tile boundary, undo/redo, save/reopen. Border heights/normals remain continuous and values reproduce |
| T12 Scatter repeat | Same source hashes/seed/recipe on reload -> identical instance keys/transforms. Exclusion edit does not change distant unaffected cells |
| T13 Placement | Place object on sloped terrain and a table; Drop with upright/aligned modes. Clearance and supporting surface are correct |
| T14 Material sharing | Edit shared UV scale then Make unique on one instance. Shared users update first, unique edits affect only chosen instance |
| T15 Depth/normal math | Synthetic plane at 2 m, tilted plane, cube occlusion and orthographic shot. Errors within section 14 tolerances |
| T16 IDs/transparency | Two touching objects, cutout foliage and glass. IDs remain exact integers; masks/depth follow declared surface policy |
| T17 Splat proxy | Mixed mesh/splat scene. Missing proxy rejects detailed capture; acknowledged box mode records approximation and produces aligned coarse maps |
| T18 Camera calibration | Synthetic reference with known intrinsics/pose/ground scale. Solve then save/reopen; residual <=2 px for well-conditioned guides |
| T19 Package | Export native scene with terrain, prefab, mesh/splat, maps, shots and references -> import to clean scene storage. All dependencies valid; output signatures equivalent after expected ID remap |
| T20 Compatibility | Open legacy workflows and packages, preserve preview slot connections/list ordering and initial appearance; retain old source scene after first v12 save |
| T21 Capture failure | Missing/corrupt part, cancelled job, wrong size/token and changed asset hash. No partial manifest published; last valid capture retained |
| T22 Resource lifecycle | 20 editor create/expand/switch/remove cycles. No growing listeners/workers/owned targets after disposal |
| T23 Render host | Queue fresh capture with host connected, then disconnected. First completes; second reuses exact cache only or gives Render host required |
| T24 Large scene | Run declared reference fixtures and capture measured FPS/latency/memory estimates. Degradation is visible and bounded; no unsupported performance claim |

### 19.3 UI completion checklist

- [ ] Objects, Inspector and Export each show only their own full-height panel in embedded and expanded modes.
- [ ] Every retained legacy generation/import/library/camera/export function has a reachable UI entry.
- [ ] Every continuous property has visible feedback during mouse, pen and keyboard interaction.
- [ ] Numeric and slider peers show the same accepted value; drafts do not move geometry to zero.
- [ ] Tools expose creation defaults before placement and parameters after selection.
- [ ] Context menus, command palette and shortcuts invoke the same command IDs.
- [ ] Active floor/building, navigation mode, camera lock and snap state are visible.
- [ ] Mixed selection supports shared edits and identifies excluded targets.
- [ ] Form top-edge/height alignment and scroll/focus restoration measured on host.
- [ ] Normal/coarse-pointer density, graph zoom and minimum node width tested.
- [ ] Keyboard traversal and text entry do not trigger graph or viewport shortcuts.
- [ ] Light/proxy/quality limitations are shown where they affect output decisions.
- [ ] Capture/export errors persist in the corresponding panel after toast expiry.

## 20. Validation commands and release discipline

Run from the repository root. Follow current CI truth if commands evolve. Do not install heavyweight generation dependencies just to validate geometry/schema/unit changes.

```sh
python scripts/security_scan.py
PYTHONPATH=. python tests/test_security_scan.py
python -m unittest discover -s tests -p 'test_factory3d_*.py' -v
node --test tests/test_factory3d_frontend.mjs
```

Add new focused module tests to the corresponding PR, then run `node --test tests/*.mjs` and the repository's CI Python test invocation before a feature release. Because the existing CI executes Python test files directly, verify newly added test classes are actually discovered in both direct execution and unittest discovery. A green count that omits new tests is not acceptance.

For edited Python modules run compile/import checks appropriate to available dependencies. Re-run the unmodified security gate before handoff for production changes. Do not modify its tests, exclusions, baselines or ownership to accommodate a new dependency. If a chosen dependency cannot satisfy the gate and compatibility contract, use the documented fallback or revisit that dependency separately.

Documentation-only work uses Markdown structure/link/coverage checks; it does not require pretending future runtime tests have run. The execution of this plan must distinguish local automated results from actual ComfyUI host evidence.

## 21. Migration, rollout and rollback procedure

1. Capture representative baseline workflows/scenes/packages as immutable fixtures, including mixed mesh/splat, architecture-only, lights, camera paths and reference ownership.
2. Add migrations/read adapters and capability checks before enabling any new writer. Unknown versions fail safely without rewriting source data.
3. Keep old viewer/UI facade functional while modules are extracted; use one internal implementation switch only in development. Do not leave two competing renderers active for one widget.
4. Release correctness fixes independently when possible. They should not force users into v12 scenes.
5. Enable new UI on legacy scenes through adapters. New-feature first save creates the migrated copy and preserves original assets/references as described in section 5.2.
6. Test queue synchronization and old slot-0 connections before releasing additive node outputs. Ship example workflows showing the new render/mask nodes without replacing existing preview workflows.
7. Extend package/library readers before writers emit new terrain/prefab/capture records. Preserve old import behavior in tests.
8. Complete parity checklist, host acceptance and performance report. Only then remove obsolete UI paths and obsolete source-assertion tests whose behavior has a stronger replacement.
9. Rollback restores the previous extension version and opens the preserved legacy scene/workflow copy. New-only features remain in the v12 package; never promise their recovery through an old parser.

Update `docs/VNCCS_3D_FACTORY.md` around the final shipped behavior, including actual camera fields, direct package export, node outputs, precision controls and native/proxy distinctions. The current guide contains descriptions predating recent code changes, so rewrite affected sections rather than appending contradictory notes. Add tutorial workflows for apartment, house/landscape, reference matching and conditioning outputs.

## 22. Feasibility gates and fixed fallback decisions

| Gate | Evidence required before feature is claimed | Fixed fallback |
| --- | --- | --- |
| G01 BVH compatibility | Pinned module imports with r180; ray/build/dispose tests | Existing Three raycaster, slower but correct |
| G02 Gaussian passes | Pixel/matrix/alpha semantics proved on pinned Spark build | Supplied mesh or acknowledged coarse proxy; RGB remains native |
| G03 GPU raw readback | Actual device target-format/readback and row-order tests | Quantized packed depth + recorded precision; reject if insufficient for requested profile |
| G04 Area shadows | Demonstrated deterministic sampled-source behavior/cost | Unshadowed PBR area light with explicit approximation; no native-shadow claim |
| G05 Large light counts | Declared active-light strategy and measured GPU limits | Keep authored cap; never silently drop a stored light |
| G06 HDR/EXR ingest | Corrupt/oversized format cases and decoded-memory validation | Keep LDR background; disable HDR upload with explanation until parser is validated |
| G07 Nonuniform splats | Correct covariance, renderer and PLY round-trip tests | Uniform scale only for splats |
| G08 Fresh unattended render | Connected host, immutable-job resume/cancel tests | Exact-signature cache only without a render host |
| G09 Arbitrary architecture | Valid topology/parametric representation and tested generator | Import mesh; retain editable supported architecture around it |

These gates are not unspecified design tasks. Each has a concrete implementation path and an honest fallback. A feature marked as a fallback must appear that way in UI, documentation and capture metadata; it cannot be presented as completed exact functionality.

## 23. First implementation iteration: exact starting checklist

- [x] Add a permanent node test for an architecture-only room with no model, skydome or saved camera.
- [x] Fix renderability in Python using the same documented cases as `_hasRenderableScene()`; cover empty and camera-only behavior explicitly.
- [x] Add a retained-light test with more lights than shadow slots, including hidden/zero-intensity entries; fix illumination and allocation without changing legacy brightness units.
- [ ] Instrument current light/gizmo changes to count asset reloads, light identities and target allocations.
- [ ] Freeze representative scene-11/editor-17 fixtures and old workflow output links.
- [x] Define property descriptors for Transform, Wall, Light and Camera first; port one Inspector section to prove live inputs and patch history.
- [ ] Prove mesh depth/normal/ID capture on a synthetic scene before adding UI for all pass settings.
- [ ] Build the docked shell with unchanged renderer and working old capabilities; evaluate it on the actual ComfyUI host.

At the end of this iteration, implementation proceeds through the work-package dependencies, with the table above serving as the issue checklist and sections 5-16 as the behavioral/technical specification.
