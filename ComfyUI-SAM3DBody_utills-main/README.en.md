# ComfyUI-SAM3DBody_utills

**Language:** [🇯🇵 日本語](README.md) ・ 🇬🇧 English (current)

A streamlined fork of **[PozzettiAndrea/ComfyUI-SAM3DBody](https://github.com/PozzettiAndrea/ComfyUI-SAM3DBody)** focused on turning a single pose image into a reusable, rigged, posable 3D character inside ComfyUI.

## What this plugin does

### 1. Render a custom-body 3D model in the pose of any input image

Extract the pose from any character image, then render it onto a 3D character body whose shape you control yourself (height, thickness, face shape, bone lengths, ...).

![sample1](docs/sample1.png)

### 2. Export a rigged, animated FBX

Write the same posed character out as a rigged FBX — **armature + skinned mesh + pose animation** — straight into `<ComfyUI>/output/`. Drop it into Blender / Unity / Unreal Engine as-is. (This one feature needs Blender installed.)

![sample2](docs/sample2.png)

### 3. Export motion-captured FBX from a video

Feed a video via `ComfyUI-VideoHelperSuite`'s `VHS_LoadVideo` and get an animated FBX that **rigs the character once at the rest pose and bakes every frame of the video as a keyframe**. Drop it into Unity and you have a ready-to-play motion clip (Blender required).

<!-- DEMO_VIDEO_START -->
https://github.com/user-attachments/assets/4fa43a56-8dd2-4ebf-8abe-61a31ff14e6f
<!-- DEMO_VIDEO_END -->

## The five nodes

1. **Load SAM 3D Body Model** — lazy-loads the checkpoint from `<ComfyUI>/models/sam3dbody/`.
2. **SAM 3D Body: Process Image to Pose JSON** — runs SAM 3D Body on the input image and emits the pose as JSON.
3. **SAM 3D Body: Render Human From Pose JSON** — renders an MHR neutral body in the estimated pose, with full slider control over body shape, bone length, and FBX-sourced blend shapes.
4. **SAM 3D Body: Export Rigged FBX** — writes an armature + skinned mesh + posed animation FBX to `<ComfyUI>/output/`. (Blender required)
5. **SAM 3D Body: Export Animated FBX** — writes an animated FBX baked from a video (IMAGE batch). The character is rigged once at the rest pose, then every frame becomes a keyframe. (Blender required)

Based on Meta's **SAM 3D Body** + **Momentum Human Rig (MHR)**; both libraries are vendored under their original licenses. See the [License](#license) section.

## Installation

### Prerequisites

- ComfyUI already installed (Python 3.11 recommended)
- Windows / Linux / macOS (tested on Windows 11 + Python 3.11)
- **Blender 4.1 or newer** (needed by some features — see below)
- NVIDIA GPU (CUDA) strongly recommended — see VRAM requirements below

### GPU / VRAM requirements

SAM 3D Body keeps ~3.4 GB of weights resident on the GPU; inference activations stay under 100 MB, so this is a relatively lightweight model. Measurements taken on an RTX A6000 (1024×1024 input, single-person scene):

| Metric | `full` inference | `body` inference |
|---|---:|---:|
| Model weights (resident) | 3,374 MB | 3,374 MB |
| Inference activation (extra) | +93 MB | +69 MB |
| **Overall peak VRAM** | **~3.5 GB** | ~3.5 GB |
| First inference time | 3.06 s | 1.47 s |
| Warm inference time | 1.13 s | 0.27 s |

**Recommended specs:**

| Use case | Recommended VRAM | Examples |
|---|---|---|
| **Absolute minimum** (this plugin alone) | **4 GB** | GTX 1650 |
| **Comfortable** (alongside the OS and other processes) | **6 GB** | RTX 3050 / 4060 |
| **Sharing ComfyUI with other models** (SDXL / Qwen-Image-Edit etc.) | **8 GB+** | RTX 3060 12GB / 4070 (depends on the other model) |

> The model is cached at module scope (`_MODEL_CACHE`), so re-running the node does not allocate additional VRAM. CPU inference works but is much slower; CUDA is strongly recommended.

### ⚠ Features that require Blender

The following features spawn `blender.exe` as a subprocess and will not work without it:

| Feature | Why Blender is needed |
|---|---|
| **Adding / editing blend shapes** | Edit shape keys on `tools/bone_backup/all_parts_bs.fbx` in the Blender GUI, then re-run `tools/extract_face_blendshapes.py` headless to rebuild `presets/face_blendshapes.npz` |
| **`SAM 3D Body: Export Rigged FBX` node** | Calls `blender.exe --background --python tools/build_rigged_fbx.py` internally to build the armature, weld skin weights to vertex groups, and write the FBX |
| **`SAM 3D Body: Export Animated FBX` node** | Calls `blender.exe --background --python tools/build_animated_fbx.py` internally to bake per-frame rotation keyframes from the input video and write the animated FBX |

**When Blender is not required:** if you only want to render existing characters in ComfyUI using the shipped 18 blend shapes and bundled presets (the `Load → ProcessToJson → Render` chain of three nodes), Blender does not need to be installed at all.

### Standard installation

1. Clone this repo under `<ComfyUI>/custom_nodes/`
2. From the ComfyUI venv run:

   ```
   cd C:/ComfyUI/custom_nodes/ComfyUI-SAM3DBody_utills
   C:/ComfyUI/.venv/Scripts/python.exe -m pip install -r requirements.txt
   C:/ComfyUI/.venv/Scripts/python.exe install.py
   ```

3. Launch ComfyUI — on first run the SAM 3D Body weights (~1.5 GB) auto-download from `jetjodh/sam-3d-body-dinov3` into `<ComfyUI>/models/sam3dbody/`.

### Manual installation

#### 1. Bootstrap dependencies

```
C:/ComfyUI/.venv/Scripts/python.exe -m pip install -r requirements.txt
```

This installs `comfy-env`, `comfy-3d-viewers`, `numpy`, `pillow`, `opencv-python-headless` into the main venv.

#### 2. Set up the isolated environment for heavy dependencies

```
C:/ComfyUI/.venv/Scripts/python.exe install.py
```

`install.py` calls `from comfy_env import install; install()` which builds a pixi-backed isolated environment (`_env_*/` folders) holding the ~30 heavy dependencies declared in `nodes/comfy-env.toml` (`torch`, `bpy`, `trimesh`, `transformers`, `huggingface-hub`, `xtcocotools`, `pytorch-lightning`, `pyrender`, `hydra-core`, …).

> **macOS note:** `xtcocotools` may fail to build in some setups. `install.py` retries with `--no-build-isolation` automatically; for manual recovery run `pip install --no-build-isolation xtcocotools`.

#### 3. Place the SAM 3D Body model weights

Usually the auto-downloader takes care of this. For manual placement:

1. Download from [jetjodh/sam-3d-body-dinov3](https://huggingface.co/jetjodh/sam-3d-body-dinov3)
2. Lay them out as:

   ```
   C:/ComfyUI/models/sam3dbody/
   ├── model.ckpt              (SAM 3D Body checkpoint, ~1.3 GB)
   ├── model_config.yaml       (model config)
   └── assets/
       └── mhr_model.pt        (Momentum Human Rig, ~200 MB)
   ```

The folder is fixed at `<ComfyUI>/models/sam3dbody/` and derived from `folder_paths.models_dir`, so any `extra_model_paths.yaml` override to the models dir is followed automatically.

#### 4. Verify startup

A successful startup prints:

```
[SAM3DBody] Registered server routes:
[SAM3DBody]   GET  /sam3d/autosave
[SAM3DBody]   GET  /sam3d/preset/{name}
```

In the node menu you should see the `SAM3DBody` category with four nodes.

### Troubleshooting

| Symptom | Fix |
|---|---|
| No SAM 3D Body category in the node menu | Check the ComfyUI console for `[SAM3DBody]` errors. Make sure both `pip install -r requirements.txt` AND `python install.py` have been run. |
| Model download fails | Place the files manually per step 3. |
| `comfy_env` fails to import | Verify `requirements.txt` is installed — `comfy-env==0.1.91` must be on the path. |
| `bpy` (Blender module) fails at import | `bpy` is installed into the isolated environment by `install.py`. Re-run it. |

### ⚠ Editing blend shapes requires Blender (advanced users)

> **This section is for Blender users who want to author their own blend shapes or tweak existing ones.** If you only want to render using the 18 shipped blend shapes, you can skip it entirely — Blender is not required for that workflow.
>
> **Why Blender is required:** editing shape keys on the source FBX in the GUI, then re-running `tools/extract_face_blendshapes.py` headless to regenerate `presets/face_blendshapes.npz`.

The plugin's blend shapes live as **shape keys** on `tools/bone_backup/all_parts_bs.fbx`. Any add / edit / value change must be done in [Blender](https://www.blender.org/).

- **Tested with:** Blender 4.1 (`C:/Program Files/Blender Foundation/Blender 4.1/blender.exe`). Other versions likely work, but the hardcoded path inside `tools/extract_face_blendshapes.py` assumes 4.1.

Workflow:

1. Open `tools/bone_backup/all_parts_bs.fbx` in Blender
2. Add / edit / rename shape keys on the `mhr_reference` object
3. Save as FBX (use the export settings below)
4. From a shell, run `tools/extract_face_blendshapes.py` via headless Blender — it auto-syncs `presets/face_blendshapes.npz` + `chara_settings_presets/*.json` + `process.py`'s `_UI_BLENDSHAPE_ORDER`

#### FBX export settings

![Blender FBX export settings](docs/blender_fbx_export_settings.png)

| Option | Value |
|---|---|
| Path Mode | Automatic |
| Batch Mode | Off |
| **Limit to** | **all OFF** (don't check Selected / Visible / Active Collection) |
| **Object Types** | **Armature + Mesh** only |
| Custom Properties | OFF |
| **Scale** | **1.00** |
| **Apply Scalings** | **FBX All** |
| **Forward** | **-Z Forward** |
| **Up** | **Y Up** |
| Apply Unit | ON |
| Use Space Transform | ON |
| Apply Transform | ON |
| Bake Animation | ON |

**Important:** Forward = -Z / Up = Y / Scale 1.0 are required to match the internal axis-swap matrix `_FBX_TO_MHR_ROT`. Other axis setups will misalign the extracted blend-shape deltas.

## License

This project uses a **multi-license structure**. License files live in `docs/licenses/`.

- **Wrapper code** (ComfyUI integration): **MIT** — [LICENSE-MIT](docs/licenses/LICENSE-MIT)
- **SAM 3D Body library** (vendored under `sam_3d_body/`): **SAM License** — [LICENSE-SAM](docs/licenses/LICENSE-SAM)
- **Momentum Human Rig** (`mhr_model.pt` + mesh topology used for blend-shape authoring): **Apache 2.0** — [LICENSE-MHR](docs/licenses/LICENSE-MHR) + [NOTICE-MHR](docs/licenses/NOTICE-MHR)

See [LICENSE](docs/licenses/LICENSE) and [THIRD_PARTY_NOTICES](docs/licenses/THIRD_PARTY_NOTICES).

### Summary

- ✅ Wrapper code is free under MIT
- ✅ SAM 3D Body is usable commercially under the SAM License
- ✅ MHR-derived assets (our npz deltas + region JSONs) are Apache 2.0 compatible with commercial use
- ⚠ When redistributing, ship LICENSE-MIT + LICENSE-SAM + LICENSE-MHR + NOTICE-MHR
- ⚠ Contracted blend-shape authoring against the MHR topology: the contractor's output is a derivative work under Apache 2.0 — keep the MHR attribution
- ⚠ Acknowledge SAM 3D Body in publications (required by the SAM License)

## Community

For issues and feature requests specific to this fork, use the [tori29umai0123/ComfyUI-SAM3DBody_utills](https://github.com/tori29umai0123/ComfyUI-SAM3DBody_utills) repo (Issues / Discussions).

For SAM 3D Body / MHR core topics and upstream plugin chat, see the [PozzettiAndrea/ComfyUI-SAM3DBody Discussions](https://github.com/PozzettiAndrea/ComfyUI-SAM3DBody/discussions) and the [Comfy3D Discord](https://discord.gg/bcdQCUjnHE).

## Preset packs (distributable blend-shape definitions)

This plugin bundles its blend-shape definitions, vertex mapping, and character preset JSONs into a single unit called a **preset pack**. The pack system exists so users can author their own blend-shape sets and share them with others as self-contained folders.

### Directory layout

```
ComfyUI-SAM3DBody_utills/
├── active_preset.ini                    ← selects which pack is active
└── presets/
    └── default/                         ← bundled default pack
        ├── face_blendshapes.npz
        ├── mhr_reference_vertices.json
        └── chara_settings_presets/
            ├── autosave.json
            ├── chibi.json
            ├── female.json
            ├── male.json
            └── reset.json
```

`active_preset.ini` content:

```ini
[active]
pack = default
```

### Switching packs

To use a pack someone else shared (say `my_custom_pack`):

1. Drop the pack folder into `presets/my_custom_pack/` (same layout as above)
2. Change `active_preset.ini` from `pack = default` to `pack = my_custom_pack`
3. Reload ComfyUI (F5)

If the named pack is missing, the runtime falls back to `default` automatically.

### Creating your own pack

1. Copy `presets/default/` to `presets/my_pack/`
2. Edit `active_preset.ini` so `pack = my_pack`
3. Open `tools/bone_backup/all_parts_bs.fbx` in Blender and add / edit the shape keys you want
4. Run `tools/extract_face_blendshapes.py` — it writes into the active pack (`my_pack`), regenerates `face_blendshapes.npz`, and auto-syncs both `chara_settings_presets/*.json` and `process.py`'s `_UI_BLENDSHAPE_ORDER`
5. Optionally run `tools/rebuild_vertex_jsons.py` to refresh `mhr_reference_vertices.json`
6. Zip the `presets/my_pack/` folder and distribute

A pack is fully self-contained — the recipient just unzips it under `presets/` and edits `active_preset.ini`, no code change needed.

## Example workflows

Four ready-made workflows ship under `workflows/`. Load them from ComfyUI's `Workflow → Open` menu. The bundled `workflows/input_image*.png` / `workflows/input_mask*.png` work as drop-in test inputs.

| File | What it does | Needs Blender |
|---|---|---|
| **`SAM3Dbody_image.json`** | Minimal image-rendering workflow. Takes the pose from your input image and renders it onto an arbitrary body shape. | ❌ |
| **`SAM3Dbody_FBX.json`** | FBX export workflow. Takes the pose from your input image, applies it to an arbitrary body shape, and exports a rigged FBX with a posed animation track — importable into Unity / Unreal Engine. | ✅ |
| **`SAM3Dbody_FBXAnimation.json`** | **Video motion-capture workflow.** Pipes a video loaded via `VHS_LoadVideo` into `SAM 3D Body: Export Animated FBX` and writes an animated FBX covering every frame. | ✅ |
| **`SAM3Dbody _QIE_VNCCSpose.json`** | A real-world usage example. Combines [Qwen-Image-Edit-2511](https://huggingface.co/Qwen/Qwen-Image-Edit) + the VNCCSpose LoRA: extract the pose from a reference character of a different body shape, render it onto an arbitrary 3D character body, then image-edit the result. | ❌ |

### How `SAM3Dbody _QIE_VNCCSpose.json` fits together

![sample3](docs/sample3.png)

- **Left two panels** — inputs (a reference character for the pose + a different character for the target body shape)
- **Middle panel** — intermediate output (the 3D character body, posed by this plugin, that matches the target body shape)
- **Right panel** — final output (the middle panel handed to an image-editing model and composed into the finished art)

The intended use is treating this plugin's render as an **intermediate artifact fed into an image-editing model** (here Qwen-Image-Edit). It lets you merge two separate inputs — "pose from character A, body type from character B" — via a geometrically correct 3D body in the middle.

## Render Human From Pose JSON — parameter reference

Takes the pose estimated from an input image (`pose_json`) and renders it onto the **MHR neutral body**.

- Character shape (`shape_params` / `scale_params`) from pose_json is **ignored** so the output stays rig-stable.
- Only pose-ish fields (`global_rot` / `body_pose_params` / `hand_pose_params` / `expr_params`) are taken from pose_json.
- Body shape is fully controlled by the UI sliders (`body_*` / `bone_*` / `bs_*`). All-zero sliders = perfectly neutral body.

### Required inputs

| Parameter | Default | Range | Notes |
|---|---|---|---|
| model | — | — | From the Load node |
| pose_json | `"{}"` | — | From the Process Image to Pose JSON node |
| preset | `autosave` | preset dropdown | `autosave` is pinned to the top as the default. Selecting a preset writes its values into the sliders (via the frontend extension) |
| offset_x | 0.0 | −5.0 … 5.0 | Horizontal camera offset (meters, added to `camera[0]`). **Pans the subject left/right within the image** |
| offset_y | 0.0 | −5.0 … 5.0 | Vertical camera offset. **Pans the subject up/down within the image** |
| scale_offset | 1.0 | 0.1 … 5.0 | Camera distance multiplier. 1.0 = as-is, 0.1 = zoom in, 5.0 = zoom out |
| camera_yaw_deg | 0.0 | −180 … 180 | **Horizontal orbit** around the subject centroid. `+` moves the camera to the viewer's right (subject appears to turn left). `±180` = back view |
| camera_pitch_deg | 0.0 | −89 … 89 | **Vertical orbit** around the subject centroid. `+` moves the camera up (looking **down** at the subject), `−` looks **up**. The subject stays centered in the frame |
| width | 0 | 0 … 8192 | Output width (0 → pose_json's original image size) |
| height | 0 | 0 … 8192 | Output height (same) |

> **How the camera controls compose**
> - `camera_yaw_deg` / `camera_pitch_deg`: orbit the camera around the subject centroid (subject stays centered, only its orientation changes).
> - `offset_x` / `offset_y`: shift the rendered subject in image space (move it off-center).
> - `scale_offset`: dolly the camera in/out (zoom).
>
> The three groups are independent knobs that can be combined freely. Defaults (yaw=0, pitch=0) reproduce the previous behavior exactly.

### Optional inputs

| Parameter | Notes |
|---|---|
| background_image | Background image. If left unconnected, the background is black. |

### Body Params (PCA body shape) — `body_*`

Nine sliders driving the first 9 axes of MHR's 45-dim PCA body shape basis.

- Default: **0.0** (neutral)
- Range: **−5.0 … +5.0**
- Practical range: ±1 is subtle, ±3 is extreme, ±5 starts breaking
- **Per-axis normalisation**: PCA basis magnitudes shrink rapidly past PC0 (~16× smaller by PC8). We multiply each slider by `[1.00, 2.78, 4.42, 8.74, 10.82, 11.70, 13.39, 13.83, 16.62]` so ±1 on any axis produces a comparable-sized deformation.

Names are educated guesses at the axes' learned semantics — the actual direction may not perfectly match the label. Try them.

| Slider | PCA axis | Intended effect |
|---|---:|---|
| body_fat              | `shape_params[0]` | Body fat. +/= more fat, −/= slimmer |
| body_muscle           | `shape_params[1]` | Muscle mass. +/= muscular, −/= delicate |
| body_fat_muscle       | `shape_params[2]` | Fat vs muscle balance |
| body_limb_girth       | `shape_params[3]` | Limb thickness |
| body_limb_muscle      | `shape_params[4]` | Limb muscularity |
| body_limb_fat         | `shape_params[5]` | Limb subcutaneous fat |
| body_chest_shoulder   | `shape_params[6]` | Chest + shoulder width |
| body_waist_hip        | `shape_params[7]` | Waist + hip thickness |
| body_thigh_calf       | `shape_params[8]` | Thigh + calf thickness |

> `shape_params[9..44]` are held at 0. `scale_params` is also 0 (MHR default skeleton scale).

### Bone length sliders — `bone_*`

Four sliders that rescale link lengths along specific bone chains. Implemented as an extension of LBS with **per-joint isotropic scaling** — lengthening/shortening a bone also isotropically scales the mesh around that joint, so proportions stay locked (shrinking the torso to 0.6 gives you a short but not stubby character).

- Scale 1.0 = unchanged. 0.5 = half, 2.0 = double
- Branch joints (`clavicle_l/r`, `thigh_l/r`) stay at 1.0 so shoulder width / hip width are preserved
- Formula: `new_posed_vert = Σ_j w_j [ s_j · R_rel[j] · (rest_V - rest_joint[j]) + new_posed_joint[j] ]`

| Slider | Default | Range | Affected MHR joints |
|---|---|---|---|
| bone_torso | 1.0 | 0.3 … 1.8 | pelvis (incl. self) → neck_01 chain (crotch through neck base). Including pelvis lets the belly mesh shrink alongside the skeleton |
| bone_neck  | 1.0 | 0.3 … 2.0 | `neck_01` → `head` link (neck length). `head`'s own mesh_scale is pinned to 1.0 so lengthening the neck doesn't balloon the head |
| bone_arm   | 1.0 | 0.3 … 2.0 | Descendants of `clavicle_l/r` (upperarm → lowerarm → hand → fingers) |
| bone_leg   | 1.0 | 0.3 … 2.0 | Descendants of `thigh_l/r` (calf → foot → toes) |

Implemented in `_apply_bone_length_scales` (`nodes/processing/process.py`). We split `joint_scale` (drives bone length) from `mesh_scale` (drives local isotropic mesh scale) and soften the mesh scale with `_MESH_SCALE_STRENGTH=0.5` so shrinking the bone by 40% only thins the mesh by 20% — stops the character from turning into a stick figure.

### Blend shapes — `bs_*`

20 sliders driven by the shape keys of `tools/bone_backup/all_parts_bs.fbx`. Linearly blended into the posed mesh. Each slider defaults to **0.0** and runs **0.0 … 1.0**; combining multiple sliders is additive.

Discovery is automatic — `process.py` reads names from `presets/face_blendshapes.npz` at startup, so adding a new shape in Blender and re-extracting will surface it in the UI on the next reload. The `bs_` prefix is purely a UI label; on-disk preset JSONs and the FBX itself use the bare name.

#### Face

| Slider | Effect |
|---|---|
| bs_face_big      | Face up |
| bs_face_small    | Face down |
| bs_face_wide     | Face wider |
| bs_face_mangabig | Manga-inflated face |
| bs_face_manga    | Anime-style face shape |
| bs_chin_sharp    | Sharper chin |

#### Neck

| Slider | Effect |
|---|---|
| bs_neck_thick | Thicker neck |
| bs_neck_thin  | Thinner neck |

#### Chest

| Slider | Effect |
|---|---|
| bs_breast_full | Larger breasts |
| bs_breast_flat | Flatter breasts |
| bs_chest_slim  | Slimmer ribcage |

#### Shoulder

| Slider | Effect |
|---|---|
| bs_shoulder_wide   | Wider shoulders |
| bs_shoulder_narrow | Narrower shoulders |
| bs_shoulder_slope  | Slope / square shoulders |

#### Waist

| Slider | Effect |
|---|---|
| bs_waist_slim | Slimmer waist |

#### Limbs

| Slider | Effect |
|---|---|
| bs_limb_thick | Thicker limbs |
| bs_limb_thin  | Thinner limbs |
| bs_hand_big   | Bigger hands |
| bs_foot_big   | Bigger feet |

#### Muscle

| Slider | Effect |
|---|---|
| bs_MuscleScale | Bulk up full-body muscle (macho) |

### Outputs

| Output | Notes |
|---|---|
| image | The rendered RGB image |
| settings_json | JSON snapshot of the current slider values, paste-compatible with `chara_settings_presets/*.json` |

The `settings_json` has the structure:

```json
{
  "body_params":  { "fat": 0.0, "muscle": 0.0, ..., "thigh_calf": 0.0 },
  "bone_lengths": { "torso": 1.0, "neck": 1.0, "arm": 1.0, "leg": 1.0 },
  "blendshapes":  { "face_big": 0.0, ..., "waist_slim": 0.0 }
}
```

### Preset system

Drop a JSON of the above shape into `chara_settings_presets/<name>.json` and it appears in the `preset` dropdown. Selecting a preset pushes its values into the sliders via a small frontend extension; you can then tweak further. The Python side does **not** re-apply the preset at render time, so post-selection edits are respected. `autosave.json` is special: it's written automatically at the end of every render (except when `preset` is `reset`) and is pinned to the top of the dropdown as the default.

## ⚠ Export Rigged FBX node (Blender required)

Writes a rigged FBX (**armature + skinned mesh + 30-frame static pose animation**) of the character + pose to `<ComfyUI>/output/`. Opens directly in Blender / Unity / Unreal Engine.

> **Blender 4.1+ is required** — this node calls `blender.exe --background --python tools/build_rigged_fbx.py` as a subprocess to assemble the armature, bind the LBS weights, and export the FBX. Environments without Blender will error only on this node (the other three still work).

### Inputs

| Parameter | Notes |
|---|---|
| model | From the Load node |
| **character_json** | **Character JSON**. Wire up the Render node's `settings_json` output, or paste any `chara_settings_presets/*.json` contents. Contains `body_params` / `bone_lengths` / `blendshapes`. The text area starts with `=== CHARACTER JSON ===` so you can tell which slot is which. |
| **pose_json** | **Pose JSON**. Wire the `pose_json` output of the Process Image to Pose JSON node. Contains `body_pose_params` / `hand_pose_params` / `global_rot`. The text area starts with `=== POSE JSON ===`. |
| blender_exe | Path to `blender.exe` (default `C:/Program Files/Blender Foundation/Blender 4.1/blender.exe`) |
| output_filename | Output FBX name under `<ComfyUI>/output/` (default `sam3d_rigged.fbx`). Leave blank for a timestamped name |

### Outputs

| Output | Notes |
|---|---|
| fbx_path | Absolute path of the written FBX (`<ComfyUI>/output/<name>.fbx`) |

### How it works

1. **Python (ComfyUI main venv)**
   - Expands `character_json`'s `body_params` / `bone_lengths` / `blendshapes` through the same MHR pipeline the Render node uses, producing the character rest mesh
   - Computes the posed skeleton (world rotation + translation per joint) from `pose_json`'s `body_pose_params` / `hand_pose_params` / `global_rot`
   - Prunes weightless leaf joints (MHR has ~127; about 15 are pure leaves with no LBS weight) so the final armature has ~112 bones
   - Dumps the parent hierarchy, rest/posed poses, and sparse LBS skin weights (`V=18439 × J`) to a temp JSON
2. **Blender (subprocess)**
   - Reads the temp JSON and `tools/build_rigged_fbx.py` builds:
     - Armature at rest pose, with `bone.matrix` set so bone rest orientation matches MHR's bind rotation exactly
     - Mesh at rest-pose vertex positions
     - One vertex group per bone, with LBS weights written in
     - Armature modifier on the mesh
     - Pose mode: each bone's **local delta rotation** is computed from the math (not `pose_bone.matrix`, which mixes translation into the local transform); `pose_bone.location` and `scale` are pinned to 0 / 1 so world positions come purely from forward kinematics
     - Keyframes at frame 1 and frame 30 so the clip has non-zero duration (Unity treats zero-length clips as empty)
     - FBX export (`axis_forward=-Z / axis_up=Y`, `add_leaf_bones=False`, `bake_anim=True`, `bake_anim_force_startend_keying=True`)

### Example workflow

```
LoadImage ──► SAM 3D Body: Process Image to Pose JSON ──► [pose_json]
                                                           │
LoadSAM3DBodyModel ──┬────────────────────────────────────┼──► model
                     │                                     │
                     └──► SAM 3D Body: Render ... ─► settings_json ─► [character_json]
                                                                        │
                                                SAM 3D Body: Export Rigged FBX
                                                                        │
                                                             <ComfyUI>/output/*.fbx
```

Tweak the Render node until the preview looks right, pipe its `settings_json` into Export Rigged FBX, and you get a rigged FBX matching exactly what you saw in the preview.

### Output FBX layout

| Piece | Details |
|---|---|
| Armature | ~112 bones (127 MHR joints minus 15 weightless leaves). Rest pose = MHR rest, bone rest orientations match MHR bind rotations |
| Mesh | 18439 verts at rest pose, with `character_json`'s shape / blend shape / bone length changes baked in |
| Vertex groups + armature modifier | One vertex group per bone, populated with the MHR LBS weights. Skinning just works when opened in Blender / Unity / UE |
| Animation | One Action (`SAM3D_Armature|Scene`), full-range (frame 1..30) static pose. Plays cleanly in the Unity Timeline |
| Axes | File on disk: Y-up / -Z-forward (Unity/UE default). Blender internal build is Z-up; the exporter does the axis swap on write (we do NOT use `bake_space_transform` — it would cause a second swap) |

### Notes

- **Blender install required** (see top of this file)
- First invocation has a 3–10 s Blender startup overhead
- An empty `pose_json` (`{"body_pose_params": null, ...}`) just outputs the rest pose — no error
- The `_slot` / `_hint` placeholder keys in the default text are ignored at runtime

## ⚠ Export Animated FBX node (video motion capture, Blender required)

Writes a full **Unity / Unreal-ready animated FBX** straight from a video (IMAGE batch). Feed a sequence of frames via `ComfyUI-VideoHelperSuite`'s `VHS_LoadVideo` (or any other source that emits a batched IMAGE tensor), and the node runs SAM 3D Body on every frame, then bakes all of them as keyframes onto **a character rigged once at its rest pose (body_pose = 0)**. The resulting FBX plays directly in Blender, Unity Animator / Timeline, and Unreal.

See the [demo video](#3-export-motion-captured-fbx-from-a-video) (`docs/sample1.mp4`) near the top of this README for an example of the exported animation.

> **Blender 4.1+ required.** The node spawns `blender.exe --background --python tools/build_animated_fbx.py` as a subprocess to build the armature, bind the LBS weights, write per-frame keyframes, and export the FBX.

### Inputs

| Parameter | Default | Notes |
|---|---|---|
| model | — | From the Load node |
| **images** | — | **Video frames** (IMAGE batch). Wire up `VHS_LoadVideo` or any other batched IMAGE source. The `[B,H,W,C]` tensor's B axis is the total number of frames. |
| **character_json** | placeholder | Character JSON. Wire the Render node's `settings_json` output or paste a preset. The rig is built **once at the rest pose (body_pose = 0)**; every frame is keyframed onto that shared rig. |
| fps | 30.0 | Animation frame rate. Written to `scene.render.fps`. |
| bbox_threshold | 0.8 | Person-detection confidence threshold (per frame). |
| inference_type | `full` | `full` / `body` / `hand` (same meaning as on Process Image to Pose JSON). |
| **root_motion_mode** | `auto_ground_lock` | Vertical-root correction mode (see [details](#root-motion-correction-root_motion_mode)). One of `auto_ground_lock` / `free` / `xz_only`. |
| blender_exe | `C:/Program Files/Blender Foundation/Blender 4.1/blender.exe` | Path to `blender.exe`. |
| output_filename | `sam3d_animated.fbx` | Output FBX name under `<ComfyUI>/output/`. Leave blank for a timestamped name. |
| masks (optional) | — | Per-frame segmentation masks. Used only if the mask count matches the frame count. |

### Outputs

| Output | Notes |
|---|---|
| fbx_path | Absolute path of the written FBX (`<ComfyUI>/output/<name>.fbx`) |

### How it works

1. **Python side**
   - Expands `character_json` and builds **the character's rest mesh + rest skeleton** once, using the same logic as `Export Rigged FBX`. This is the bind pose for the whole animation.
   - Splits `images` into single frames, runs `SAMBody3DEstimator.process_one_image` per frame to get `body_pose_params` / `hand_pose_params` / `global_rot`.
   - Re-runs `mhr_forward` with the character's fixed shape params so the posed joint rotations `[J,3,3]` stay shape-consistent across frames.
   - If no person is detected on a frame, the **previous good pose is reused** so the clip stays contiguous (the very first frame falls back to the rest pose).
   - Prunes weightless leaf joints (same policy as `Export Rigged FBX`) and dumps all frame rotations + rig data to a temp JSON.
2. **Blender (subprocess)**
   - Reconstructs the armature + mesh + LBS weights at the rest pose, identical to `build_rigged_fbx.py`.
   - Sets `scene.frame_start = 1 / frame_end = N / render.fps = fps`.
   - For every frame, computes each bone's local delta rotation from the math and keyframes `pose_bone.rotation_quaternion` (location / scale stay at 0 / 1).
   - Exports the FBX (`bake_anim=True`, `axis_forward=-Z`, `axis_up=Y`).

### Example wiring

```
VHS_LoadVideo (sample1.mp4) ──► images
                                  │
LoadSAM3DBodyModel ──┬────────────┤
                     │            │
LoadImage ──► Process ── Render ─► settings_json ─► character_json
                     │            │
                     └──► SAM 3D Body: Export Animated FBX
                                  │
                       <ComfyUI>/output/sam3d_animated.fbx
```

The bundled `workflows/SAM3Dbody_FBXAnimation.json` ships this exact wiring.

### Importing into Unity

- The FBX is written **Y-up / -Z-forward**, so dropping it into Unity orients it correctly.
- In the FBX's Inspector, set `Rig → Animation Type = Humanoid` to use it as a Humanoid retarget source, or leave it on `Generic` — the original bone names are preserved either way.
- A single Action (`SAM3D_Armature|Scene`) covers all frames; play it from the Animator or a Timeline track directly.

### Notes

- **Blender install required** — same `blender.exe` as the other Blender-dependent features
- Runtime is dominated by the frame count + Blender startup (expect a few seconds per frame plus 5–10 s of Blender overhead)
- Long clips increase memory + JSON size. Prefer verifying on a few hundred frames first.
- Frames where the subject isn't reliably detected get filled in with the previous good pose; lots of missed frames produce choppy motion. Stable lighting and framing help.
- **Root translation and rotation are keyframed** — the node reads the per-frame `pred_cam_t` (subject position in camera space) estimated by SAM 3D Body, anchors it to the first detected frame so the clip starts at the origin, and bakes it onto the root bone's `location` F-Curve. Walking / turning / stepping forward in the source video reaches the FBX directly. This assumes a **static camera** in the source video — if the camera moves, the baked trajectory will be the *camera-relative* motion of the subject, not true world-space movement.
- If the character floats above the ground (or sinks into it) while standing still, the `auto_ground_lock` default of `root_motion_mode` corrects it. See the next section.

### Root motion correction (`root_motion_mode`)

`pred_cam_t` carries depth-estimation noise, absorbs camera tilt, and jitters frame-to-frame, so using it raw can make the character **float in mid-air or sink into the floor while standing still**. `root_motion_mode` picks the correction strategy.

| Mode | Behaviour | Recommended for |
|---|---|---|
| **`auto_ground_lock`** (default) | Per-frame contact detection — identifies which foot is on the ground at each moment, and applies a per-frame Y offset so that foot sits at the rest-pose ground level. Flight phases are filled in by interpolating the offset between the surrounding contact frames | Walking / running / jumping / one-foot balance / two-foot stance / dance — **essentially any mocap clip** |
| **`free`** | Uses `pred_cam_t` as-is. No correction | Intermediate output when you plan to fix the root path in a DCC. Debugging |
| **`xz_only`** | Drops the Y component entirely (horizontal motion only). Jumps are lost too | In-place animations — fighting-game idles / attacks where the animation loops and feet are IK-driven |

**How `auto_ground_lock` works**:

1. Per frame, extract both feet's 3D position from `mhr_forward(global_trans=0)`
2. **Contact detection** (per frame, per foot):
   - Low (`pose_foot_y <= rest_foot_y + 15cm`, pose-frame = drift-free)
   - Still (`|world Y velocity| <= 0.03m/frame`) — using WORLD velocity is what lets us correctly flag jump / flight frames as non-contact even though the pose-frame foot barely moves during a straight-body jump
3. Hysteresis: a foot only counts as in contact if it passes both tests for at least 2 consecutive frames (debounces single-frame flicker)
4. Per frame, if any foot is in contact, compute the offset needed to put its world Y at the rest-pose foot Y. Frames with no contact get a NaN offset, which is then linearly interpolated from surrounding contact frames
5. Smooth the final offset curve with a Savitzky-Golay filter (window 5, order 2)

**Scenario behaviour**:

| Scenario | Contact-detection result | Outcome |
|---|---|---|
| Two-foot stance | Both feet in contact throughout | Flat offset, clip ground-locked |
| One-foot balance | Only supporting foot passes (lifted foot fails the Y threshold) | Supporting foot anchored, lifted foot free |
| Walking | Always at least one foot in contact (alternating + double support) | Smooth per-frame anchor |
| Running | Contact during single-support phases, NaN during flight | Flight interpolated between surrounding contacts |
| Jumping | Contact before takeoff and after landing only (world-velocity excludes flight) | Flight interpolated, jump height preserved as relative pose difference |
| Pure flight clip | Zero contact frames | Fallback: global-min shift (equivalent to the old algorithm) |

**Tunables (hardcoded constants in `nodes/processing/export_animated.py`)**:

| Constant | Value | Meaning |
|---|---|---|
| `_GL_Y_THR` | 0.15 m | How far above `rest_foot_y` still counts as "low" |
| `_GL_V_THR` | 0.03 m/frame | World Y-velocity cutoff (~0.9 m/s at 30 fps) |
| `_GL_MIN_CONTACT_RUN` | 2 | Minimum consecutive contact frames (debouncing) |
| `_GL_SMOOTH_WINDOW` | 5 | Savitzky-Golay window |
| `_GL_SMOOTH_ORDER` | 2 | Savitzky-Golay polynomial order |
| `_GL_MIN_CONTACTS_TOTAL` | 3 | Fewer than this → global-min fallback |

**Reading the log**:
- `ground_lock contact-based: N/M frames with contact, offset range=[+x, +y]` — healthy run. If N is tiny relative to M, accuracy degrades.
- `ground_lock fallback (N/M contact frames < 3): global min correction=±x` — not enough contact frames, fell back to the simple algorithm. Expected for pure in-air clips.

## Developer guide: adding new blend shapes

The `bs_*` sliders are auto-discovered from `presets/face_blendshapes.npz`, so **no Python changes are needed** to add one.

### Steps

1. **Open `tools/bone_backup/all_parts_bs.fbx` in Blender**
2. Select the `mhr_reference` mesh
3. In Object Properties → **Shape Keys**, add a new key and sculpt it (Basis first if it's missing)
4. Export the FBX with the settings documented earlier (Forward=-Z / Up=Y / Scale 1.0)
5. Run the extractor — this single command also syncs every preset and the UI order:

   ```
   "C:/Program Files/Blender Foundation/Blender 4.1/blender.exe" ^
       --background --python tools/extract_face_blendshapes.py
   ```

   - `presets/face_blendshapes.npz` is rebuilt from the FBX
   - `chara_settings_presets/*.json` get the new key added (default 0.0) and stale keys removed
   - `process.py`'s `_UI_BLENDSHAPE_ORDER` gets the new key inserted at the end of its category (face/neck/chest/shoulder/waist/limbs inferred from the name prefix)

6. Refresh ComfyUI — the new slider appears in the UI.

### Editing existing shape values

Re-sculpt the key in Blender, re-export FBX, re-run step 5. Values are **overwritten from source** each time, so there's no manual diff to manage.

### Rebuild everything from scratch

```
del presets\face_blendshapes.npz
del presets\*_vertices.json
```

Then re-run steps 5 and 6. `tools/rebuild_vertex_jsons.py` regenerates the per-object vertex JSON from the npz.

## FBX update workflow (one-liner)

After editing the FBX in Blender:

### 1. Extract blend shapes + auto-sync presets and UI order

```
"C:/Program Files/Blender Foundation/Blender 4.1/blender.exe" ^
    --background --python custom_nodes/ComfyUI-SAM3DBody_utills/tools/extract_face_blendshapes.py
```

### 2. Regenerate the per-object vertex JSON

```
.venv/Scripts/python.exe custom_nodes/ComfyUI-SAM3DBody_utills/tools/rebuild_vertex_jsons.py
```

### 3. Refresh ComfyUI

Reload the browser — the new shape keys and updated UI order show up automatically.

## tools/ script reference

| Script | Run in | Role |
|---|---|---|
| `tools/extract_face_blendshapes.py` | **Blender** (`--background --python`) | Walks all mesh objects + shape keys in `tools/bone_backup/all_parts_bs.fbx`, writes `presets/face_blendshapes.npz` (`base__<obj>`, `delta__<obj>__<shape>`, `meta_shapes`, `meta_objects`, `all_base__<obj>`). Calls `sync_presets_with_npz.sync_all()` at the end to keep presets + UI aligned. |
| `tools/rebuild_vertex_jsons.py` | **ComfyUI venv** | Nearest-neighbour-matches the npz's `all_base__<obj>` positions against MHR rest vertices and writes `presets/<obj>_vertices.json` files. Auto-removes stale JSONs when the FBX object list changes. |
| `tools/sync_presets_with_npz.py` | **ComfyUI venv** or Blender | Standalone sync (normally called automatically at the end of `extract_face_blendshapes.py`). Adds missing keys to preset JSONs with value 0.0, drops stale keys, rewrites `_UI_BLENDSHAPE_ORDER` in `process.py`. |
| `tools/build_rigged_fbx.py` | **Blender** (spawned by the Export Rigged FBX node) | Builds the rigged FBX from the node's intermediate JSON (armature + mesh + LBS weights + posed animation + FBX export). |
| `tools/rename_blendshape_keys.py` | **Blender** | One-off helper for renaming shape keys in `all_parts_bs.fbx` (edit the `RENAMES` dict inside and run). |
| `tools/export_reference_obj.py` | **ComfyUI venv** | Writes `tools/bone_backup/mhr_reference.obj` — a single non-partitioned MHR rest-pose OBJ. Used as a safety backup and as a starting point if the FBX is ever rebuilt from scratch. |

## Acknowledgements

Based on [PozzettiAndrea/ComfyUI-SAM3DBody](https://github.com/PozzettiAndrea/ComfyUI-SAM3DBody). SAM 3D Body is Meta AI's full-body mesh recovery model; Momentum Human Rig is Meta's parametric body model. Both libraries are vendored here under their original licenses.
