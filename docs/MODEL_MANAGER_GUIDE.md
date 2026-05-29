# VNCCS Utils Node Guide

This document is the main user guide for the ComfyUI nodes shipped by
`ComfyUI_VNCCS_Utils`.

Registered nodes:

| Display name | Internal name | Category | Main purpose |
| --- | --- | --- | --- |
| VNCCS Position Control | `VNCCS_PositionControl` | `VNCCS` | Build a camera-angle prompt string from sliders. |
| VNCCS Visual Camera Control | `VNCCS_VisualPositionControl` | `VNCCS` | Same prompt builder, controlled by the custom visual JS widget. |
| VNCCS QWEN Detailer | `VNCCS_QWEN_Detailer` | `VNCCS/detailing` | Detect image regions, regenerate them with a Qwen image/edit model, and paste them back. |
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
  "include_trigger": true
}
```

The output is the same `prompt` string as `VNCCS Position Control`.

Use this node when you prefer an interactive camera UI instead of raw sliders.
If the hidden JSON is missing or invalid, the node falls back to front,
eye-level, medium shot, with `<sks>` enabled.

## VNCCS QWEN Detailer

`VNCCS QWEN Detailer` is a region-detailing node. It detects one or more regions
with an Impact Pack-compatible `BBOX_DETECTOR`, crops each region, generates a
replacement with a Qwen image/edit model, color-matches it if requested, and
pastes it back into the original image.

Required inputs:

| Input | Type | Purpose |
| --- | --- | --- |
| `image` | `IMAGE` | Source image. Batches are rejected; use one image at a time. |
| `bbox_detector` | `BBOX_DETECTOR` | Detector that returns Impact Pack-style SEGS. |
| `model` | `MODEL` | Diffusion model used for the replacement crop. |
| `clip` | `CLIP` | Qwen-compatible text/vision encoder. |
| `vae` | `VAE` | VAE used for reference latent encoding and decode. |
| `prompt` | `STRING` | User edit prompt. |
| `threshold` | `FLOAT` | Detector confidence threshold. |
| `dilation` | `INT` | Expands or shrinks detected crop regions. |
| `drop_size` | `INT` | Detector minimum object size. |
| `feather` | `INT` | Paste blending feather. |
| `steps` | `INT` | Sampling steps. |
| `cfg` | `FLOAT` | Classifier-free guidance. |
| `seed` | `INT` | Sampling seed. |
| `sampler_name` | enum | ComfyUI sampler. |
| `scheduler` | enum | ComfyUI scheduler. |
| `denoise` | `FLOAT` | Denoise strength for the crop generation. |
| `tiled_vae_decode` | `BOOLEAN` | Decode generated crop with tiled VAE. |
| `tile_size` | `INT` | Tile size for tiled decode. |

Optional inputs:

| Input | Type | Purpose |
| --- | --- | --- |
| `controlnet_image` | `IMAGE` | Optional control image. It is resized to match `image` if needed. |
| `image2` | `IMAGE` | Optional second visual reference sent to Qwen. |
| `sam_model_opt` | `SAM_MODEL` | Optional SAM refinement from Impact Pack. |
| `segm_detector_opt` | `SEGM_DETECTOR` | Optional segmentation refinement from Impact Pack. |
| `sam_detection_hint` | enum | SAM point/mask hint mode. |
| `sam_dilation` | `INT` | SAM mask dilation. |
| `sam_threshold` | `FLOAT` | SAM threshold. |
| `sam_bbox_expansion` | `INT` | SAM bbox expansion. |
| `sam_mask_hint_threshold` | `FLOAT` | SAM mask hint threshold. |
| `sam_mask_hint_use_negative` | enum | Negative hint behavior. |
| `target_size` | enum | Long-side target for Qwen crop processing. Available values include 512, 768, 1024, 1344, 1536, 2048. |
| `upscale_method` | enum | Resize method: nearest-exact, bilinear, area, bicubic, or lanczos. |
| `crop_method` | enum | `center` or `disabled`. |
| `instruction` | `STRING` | System-style instruction prepended to the Qwen prompt template. |
| `inpaint_mode` | `BOOLEAN` | Blacks out the detected bbox inside the crop and asks Qwen to fill it. |
| `inpaint_prompt` | `STRING` | Prefix used when `inpaint_mode` is enabled. |
| `color_match_method` | enum | `disabled` or `kornia_reinhard`. |
| `seam_fix` | `BOOLEAN` | Uses Poisson blending when enabled; otherwise standard paste. |
| `qwen_2511` | `BOOLEAN` | Applies the `reference_latents_method=index_timestep_zero` conditioning patch for Qwen 2.5/2.5.1-style workflows. |
| `distortion_fix` | `BOOLEAN` | Squares the crop before Qwen processing and unsquares it before paste-back to reduce aspect drift. |

Output:

| Output | Type | Notes |
| --- | --- | --- |
| `image` | `IMAGE` | Original image with detected regions replaced. If no region is detected, the original image is returned. |

Recommended workflow:

1. Load an image.
2. Connect an Impact Pack bbox detector, such as a face/person detector.
3. Connect Qwen image/edit `MODEL`, `CLIP`, and `VAE`.
4. Set `threshold` so only the intended region is detected.
5. Start with `target_size=1024`, `steps=4`, `cfg=1.0`, `denoise=1.0`.
6. Enable `distortion_fix` for faces, hands, or tall/narrow crops.
7. Enable `color_match_method=kornia_reinhard` when the patch does not match the original image lighting.

Important limits and behavior:

- `image`, `controlnet_image`, and `image2` batches are rejected.
- Detected regions smaller than 10 pixels in width or height are skipped.
- `controlnet_image` is resized to match `image` before region cropping.
- If `kornia` is not installed, color matching is skipped with a console warning.
- If no valid segment remains after dilation/size checks, the original image is returned.

## VNCCS BBox Extractor

`VNCCS BBox Extractor` is a utility node for checking detector regions. It runs
the same bbox detector style as QWEN Detailer, crops all valid detections, pads
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

Use this node before QWEN Detailer when you need to tune `threshold`,
`dilation`, or detector choice.

## VNCCS Model Manager

`VNCCS Model Manager` is a UI/control node for project model manifests. It
passes through a Hugging Face repository id and the web UI uses that id to load
`model_updater.json`, show install state, save tokens, and queue downloads.

Input:

| Input | Type | Default |
| --- | --- | --- |
| `repo_id` | `STRING` | `MIUProject/VNCCS` |

Output:

| Output | Type | Notes |
| --- | --- | --- |
| `repo_id` | `STRING` | Pass this into `VNCCS Model Selector` so both nodes use the same manifest. |

Manifest location:

- The manager expects `model_updater.json` at the root of the Hugging Face model repository named by `repo_id`.
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
| `local_path` | string | Install path. Must start with `models/` and resolve inside ComfyUI's models directory. |

Download source, choose one:

| Field | Type | Purpose |
| --- | --- | --- |
| `hf_repo` + `hf_path` | string | Download a file from a Hugging Face model repository. If `hf_repo` is omitted, the manager uses the node's `repo_id`. |
| `url` | string | Direct HTTPS download URL. Civitai model-page URLs with `modelVersionId` are converted to Civitai API download URLs. |

Security and path rules:

- `local_path` must be relative and must start with `models/`.
- Absolute paths, `..`, `~`, URL-like paths, and paths outside `folder_paths.models_dir` are rejected.
- Direct URLs must use HTTPS.
- Localhost, private, loopback, link-local, multicast, reserved IPs, and hostnames resolving to those ranges are rejected.
- Direct downloads have a 100 GiB safety cap and use temporary files before install.
- User tokens are stored in `vnccs_user_config.json`; the file is chmodded to `0600` where supported.

Supported token fields:

| Field | Used for |
| --- | --- |
| `hf_token` | Private Hugging Face repositories/files. |
| `civitai_token` | Civitai downloads requiring authorization. |
| `token` | Legacy alias for `civitai_token`. |

Local state files:

| File | Purpose |
| --- | --- |
| `vnccs_installed_models.json` | Active version registry by model name. |
| `vnccs_user_config.json` | HF/Civitai tokens and other user-level settings. |

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
| `unique_id` | hidden | Used for frontend/backend sync. |

Outputs:

| Output | Type | Notes |
| --- | --- | --- |
| `images` | `IMAGE` list | One image per pose tab in LIST mode, or one grid image in GRID mode. |
| `lighting_prompt` | `STRING` list | Lighting prompt per output image. |

## Troubleshooting

### The model selector outputs an empty string

- Check that `model_name` is selected in the selector UI.
- Check that `repo_id` points to a repository containing `model_updater.json`.
- Check that the manifest entry has a valid `local_path` under `models/`.
- Check the ComfyUI console for `VNCCS ModelSelector` messages.

### A download is rejected

- Direct URLs must be HTTPS.
- Hostnames resolving to local/private networks are blocked.
- `local_path` must stay inside ComfyUI's models directory.
- For private HF or Civitai models, save the relevant token in the manager UI.

### QWEN Detailer returns the original image

- No bbox segment was detected or all segments were smaller than 10 px.
- Lower `threshold`, reduce negative `dilation`, or test with `VNCCS BBox Extractor`.
- Make sure the detector returns Impact Pack-compatible SEGS.

### QWEN Detailer crop looks warped

- Enable `distortion_fix`.
- Increase `target_size`.
- Use `VNCCS BBox Extractor` to verify the crop is not too narrow or too loose.

### Pose Studio does not update from the UI

- The node relies on hidden `unique_id` sync and custom web UI code.
- Refresh the browser page after installing/updating the extension.
- If the workflow was loaded from an older version, save it again after opening the node once.
