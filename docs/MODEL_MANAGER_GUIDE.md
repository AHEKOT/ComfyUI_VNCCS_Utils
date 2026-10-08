# VNCCS Utils Node Guide

This document is the main user guide for the ComfyUI nodes shipped by
`ComfyUI_VNCCS_Utils`.

Registered nodes:

| Display name | Internal name | Category | Main purpose |
| --- | --- | --- | --- |
| VNCCS Position Control | `VNCCS_PositionControl` | `VNCCS` | Build a camera-angle prompt string from sliders. |
| VNCCS Visual Camera Control | `VNCCS_VisualPositionControl` | `VNCCS` | Same prompt builder, controlled by the custom visual JS widget. |
| VNCCS BBox Extractor | `VNCCS_BBox_Extractor` | `VNCCS/detailing` | Crop detected bounding-box regions into an image batch. |
| VNCCS Model Manager | `VNCCS_ModelManager` | `VNCCS/manager` | Fetch a model manifest, display model install state, and queue downloads. |
| VNCCS Model Selector | `VNCCS_ModelSelector` | `VNCCS/manager` | Select one manifest model and output a loader-compatible model path. |
| VNCCS Pose Studio | `VNCCS_PoseStudio` | `VNCCS/pose` | Interactive 3D pose, body, camera, lighting, and pose-library workspace. |

The bundled `vnccs_sam3d` package is used by Pose Studio for image-to-pose import
and also contains standalone SAM 3D Body node classes. Those classes are not
registered by the top-level `__init__.py` in this repository version, but their
behavior is documented in `VNCCS_POSE_STUDIO_USAGE.md` because Pose Studio calls
the same backend path.

## VNCCS Position Control

`VNCCS Position Control` outputs a text prompt fragment for camera/view control.
It is useful when a LoRA or edit model expects explicit view tokens.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `azimuth` | `INT` slider | `0` | 0 to 360, step 45. Mapped to front, side, back, and quarter views. |
| `elevation` | `INT` slider | `0` | -30 to 60, step 30. Mapped to low, eye-level, elevated, and high-angle shots. |
| `distance` | enum | `medium shot` | `close-up`, `medium shot`, or `wide shot`. |
| `include_trigger` | `BOOLEAN` | `True` | Adds `<sks>` when enabled. |

Output:

| Output | Type | Example |
| --- | --- | --- |
| `prompt` | `STRING` | `<sks> front-right quarter view eye-level shot medium shot` |

Azimuth mapping:

| Azimuth | Prompt phrase |
| --- | --- |
| 0 or 360 | `front view` |
| 45 | `front-right quarter view` |
| 90 | `right side view` |
| 135 | `back-right quarter view` |
| 180 | `back view` |
| 225 | `back-left quarter view` |
| 270 | `left side view` |
| 315 | `front-left quarter view` |

Elevation mapping:

| Elevation | Prompt phrase |
| --- | --- |
| -30 | `low-angle shot` |
| 0 | `eye-level shot` |
| 30 | `elevated shot` |
| 60 | `high-angle shot` |

Typical use:

1. Add `VNCCS Position Control`.
2. Connect `prompt` into a prompt-combining node or directly append it to your text prompt.
3. Disable `include_trigger` when your workflow already adds `<sks>` elsewhere.

## VNCCS Visual Camera Control

`VNCCS Visual Camera Control` is the visual-widget version of Position Control.
The Python node has a hidden `camera_data` string input. The web extension writes
JSON into that hidden input:

```json
{
  "azimuth": 0,
  "elevation": 0,
  "distance": "medium shot",
  "include_trigger": true,
  "random": false,
  "random_azimuth_mode": "full"
}
```

The output is the same `prompt` string as `VNCCS Position Control`.

Use this node when you prefer an interactive camera UI instead of raw sliders.
Enable `Random` to choose a different azimuth, elevation, and distance for
every queued generation, including every item in a batched queue.
When `Random` is enabled, choose `360°` to use every azimuth or `Front ±45°`
to restrict azimuth to front-left (`315°`), front (`0°`), and front-right
(`45°`). Elevation and distance remain randomized in both modes.
If the hidden JSON is missing or invalid, the node falls back to front,
eye-level, medium shot, with `<sks>` enabled.

## VNCCS BBox Extractor

`VNCCS BBox Extractor` is a utility node for checking detector regions. It runs
an Impact Pack-compatible bbox detector, crops all valid detections, pads
them to a common size, and returns them as an image batch.

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `image` | `IMAGE` | required | Source image. Batches are rejected. |
| `bbox_detector` | `BBOX_DETECTOR` | required | Impact Pack-style detector. |
| `threshold` | `FLOAT` | `0.5` | Detection confidence threshold. |
| `dilation` | `INT` | `300` | Expands or shrinks each crop region. |
| `drop_size` | `INT` | `10` | Detector minimum object size. |

Output:

| Output | Type | Notes |
| --- | --- | --- |
| `images` | `IMAGE` | Batch of cropped detections. Returns a 1x1 black image if no valid region is detected. |

Use this node to tune `threshold`,
`dilation`, or detector choice.

## VNCCS Model Manager

`VNCCS Model Manager` is a UI/control node for project model manifests. It
passes through a Hugging Face repository id and the web UI uses that id to load
`model_updater.json`, show install state, and queue downloads.
Only the fixed `MIUProject/VNCCS` manifest repository is accepted.

Input:

| Input | Type | Default |
| --- | --- | --- |
| `repo_id` | `STRING` | `MIUProject/VNCCS` |

Output:

| Output | Type | Notes |
| --- | --- | --- |
| `repo_id` | `STRING` | Pass this into `VNCCS Model Selector` so both nodes use the same manifest. |

Manifest location:

- The manager expects `model_updater.json` at the root of `MIUProject/VNCCS`. Other manifest repositories are rejected before cache or network access.
- The manager caches the manifest briefly to avoid excessive remote HEAD/fetch requests.
- Use the UI refresh/check action when you need to force a fresh check.

`model_updater.json` format:

```json
{
  "config_version": "1.0",
  "models": [
    {
      "name": "Example LoRA",
      "version": "1.0.0",
      "description": "Short text shown in the manager UI.",
      "hf_repo": "MIUProject/VNCCS",
      "hf_path": "models/loras/example.safetensors",
      "local_path": "models/loras/example.safetensors"
    }
  ]
}
```

Required model fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `name` | string | Display name and selector key. Multiple entries may share a name if they are different versions. |
| `version` | string | Version string. Parsed with `packaging.version` when available; otherwise string-sorted. |
| `description` | string | UI description. |
| `local_path` | string | Install path. Must name a file in a known model folder under ComfyUI's models directory. |

Download source:

| Field | Type | Purpose |
| --- | --- | --- |
| `hf_repo` + `hf_path` | string | Download a file from a Hugging Face model repository. If `hf_repo` is omitted, the manager uses the node's `repo_id`. |

Security and path rules:

- `local_path` must be relative and start with `models/<known-folder>/`.
- Known folders are `checkpoints`, `loras`, `vae`, `controlnet`, `style_models`, `upscale_models`, `clip`, `clip_vision`, `text_encoders`, `unet`, `diffusion_models`, `diffusers`, `model_patches`, `embeddings`, `configs`, `sam3dbody`, and `birefnet`.
- Absolute/UNC paths, drive prefixes, alternate data streams, `..`, `~`, and symlinks escaping `folder_paths.models_dir` are rejected.
- Existing files and symlinks are never replaced. An existing target returns HTTP 409; a target created while downloading also prevents installation.
- Downloads have a 100 GiB safety cap. Completed temporary files are published atomically without replacement; the model filesystem must support hard links.
- Direct URLs and credential storage are disabled. Hugging Face downloads explicitly disable credentials.

Local state files:

| File | Purpose |
| --- | --- |
| `vnccs_installed_models.json` | Active version registry by model name. |
| `vnccs_user_config.json` | User-level settings; it cannot change the trusted manifest repository. |

## VNCCS Model Selector

`VNCCS Model Selector` reads the same manifest as the manager and outputs one
selected model path. See `MODEL_SELECTOR_USAGE.md` for the focused selector
guide.

Minimal manager/selector setup:

1. Add `VNCCS Model Manager`.
2. Set `repo_id`.
3. Add `VNCCS Model Selector`.
4. Connect manager `repo_id` to selector `repo_id`.
5. Use the selector UI card to choose a model.
6. Connect selector `model_path` into a standard ComfyUI loader input such as `lora_name`, `ckpt_name`, or `control_net_name`.

## VNCCS Pose Studio

`VNCCS Pose Studio` is the interactive pose/body/camera/lighting node. It has
its own complete guide in `VNCCS_POSE_STUDIO_USAGE.md`.

Inputs:

| Input | Type | Notes |
| --- | --- | --- |
| `pose_data` | hidden `STRING` | JSON written by the custom UI. |
| `pose_image` | optional `IMAGE` | Available in Studio mode; disabled in Pose Manager mode. When connected, it runs SAM 3D Body import and applies the result to the frontend pose. |
| `camera_prompt` | settings-controlled `STRING` socket | Available while `Directional Skydome` is enabled. Accepts `VNCCS Visual Camera Control`; each resolved execution prompt rotates the exported skydome and is appended as natural camera text. Disabling the setting removes the socket and skydome. |
| `unique_id` | hidden | Used for frontend/backend sync. |

Outputs:

| Output | Type | Notes |
| --- | --- | --- |
| `images` | `IMAGE` list | One image per pose tab in LIST mode, or one grid image in GRID mode. |
| `lighting_prompt` | `STRING` list | Combined lighting, pose, and connected camera prompt per output image. |

## Troubleshooting

### The model selector outputs an empty string

- Check that `model_name` is selected in the selector UI.
- Check that `repo_id` is `MIUProject/VNCCS`.
- Check that the manifest entry has a valid `local_path` under `models/`.
- Check the ComfyUI console for `VNCCS ModelSelector` messages.

### A download is rejected

- Only the fixed `MIUProject/VNCCS` manifest is accepted; model assets must be public Hugging Face files.
- `local_path` must name a file inside a known model folder without escaping through symlinks.
- Existing targets are preserved. Use a different versioned filename or manage replacement manually on disk.

### Pose Studio does not update from the UI

- The node relies on hidden `unique_id` sync and custom web UI code.
- Refresh the browser page after installing/updating the extension.
- If the workflow was loaded from an older version, save it again after opening the node once.
