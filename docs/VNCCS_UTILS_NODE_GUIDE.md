# VNCCS Utils Node Guide

This document is the main user guide for the ComfyUI nodes shipped by
`ComfyUI_VNCCS_Utils`.

Registered nodes:

| Display name | Internal name | Category | Main purpose |
| --- | --- | --- | --- |
| VNCCS Position Control | `VNCCS_PositionControl` | `VNCCS` | Build a camera-angle prompt string from sliders. |
| VNCCS Visual Camera Control | `VNCCS_VisualPositionControl` | `VNCCS` | Same prompt builder, controlled by the custom visual JS widget. |
| VNCCS BBox Extractor | `VNCCS_BBox_Extractor` | `VNCCS/detailing` | Crop detected bounding-box regions into an image batch. |
| VNCCS Pose Studio | `VNCCS_PoseStudio` | `VNCCS/pose` | Interactive 3D pose, body, camera, lighting, and pose-library workspace. |
| VNCCS Apply Crop Guide | `VNCCS_ApplyCropGuide` | `VNCCS/pose` | Crop any image with a Pose Studio `crop_json` at the image's own resolution. |
| VNCCS Character Export | `VNCCS_CharacterExport` | `VNCCS/pose` | Split multi-character Pose Studio images into per-character control crops and masks. |

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
| `depth` … `character_id` | `IMAGE` / `MASK` lists | Auxiliary control images aligned with `images`. |
| `crop_json` | `STRING` list | Crop guide of each image (see [Crop Guide](VNCCS_POSE_STUDIO_USAGE.md#crop-guide)). |
| `crop_image` | `IMAGE` list | Crop of each full image, for checking the composition. |
| `crop_preview` | `IMAGE` list | Each full image with the guide drawn. |
| `character_json` | `STRING` list | Per-character information of each image (see [Per-character export](VNCCS_POSE_STUDIO_USAGE.md#per-character-export)). |
| `character_passes` | `IMAGE` list | One batch per exported character: solo normal, solo depth and full-body silhouette. |

## VNCCS Apply Crop Guide

Crops images with the rectangle of a Pose Studio `crop_json`, typically the images
generated from Pose Studio's uncropped `images`. Pure image processing: no resize and
no interpolation; the normalized rectangle is converted to pixels of each input image
with the same rounding as Pose Studio.

| Input | Type | Notes |
| --- | --- | --- |
| `image` | `IMAGE` | Image(s) to crop. |
| `crop_json` | `STRING` | Pose Studio `crop_json` output. |
| `aspect_mismatch` | `error` / `stretch` | When the image aspect ratio differs from the capture by more than 1 %: stop (default) or scale the rectangle per axis (only for images that were resized without padding or cropping). |

| Output | Type | Notes |
| --- | --- | --- |
| `cropped_image` | `IMAGE` list | One item per input pairing; crops of different sizes stay separate list items. |

Details are in [Apply Crop Guide](VNCCS_POSE_STUDIO_USAGE.md#vnccs-apply-crop-guide).

## VNCCS Character Export

Crops every character of a multi-character Pose Studio image into its own control
images, for generating characters separately and compositing them. Pure image
processing on Pose Studio outputs of one LIST run.

| Input | Type | Notes |
| --- | --- | --- |
| `images` | `IMAGE` | Pose Studio `images`. |
| `character_id` | `IMAGE` | Pose Studio `character_id`. |
| `character_json` | `STRING` | Pose Studio `character_json`. |
| `character_passes` | `IMAGE` | Pose Studio `character_passes`. |
| `margin` | `INT` | Pixels around each character's full-body bounds (default 64). |
| `align` | `8` / `64` | Crop width and height are multiples of this value (default 8). |
| `depth_normalization` | `scene` / `character` | One depth scale for the image, or 255..32 per character (default `scene`). |

| Output | Type | Notes |
| --- | --- | --- |
| `normal_solo`, `depth_solo` | `IMAGE` list | The character alone, including parts hidden by others, cropped. |
| `character_id` | `IMAGE` list | Crop of the full Character ID pass. |
| `mask_visible` | `IMAGE` list | White where the character is visible in the full render, for compositing. |
| `mask_full` | `IMAGE` list | White on the full-body silhouette, for inpainting ranges. |
| `rgb` | `IMAGE` list | Crop of `images`, for checking. |
| `meta` | `STRING` list | One JSON per image with each character's `crop_rect`, bounds, `z_order` and `visible_ratio`. |

Per-kind lists have one item per character (image first, then ascending slot). Details are
in [Per-character export](VNCCS_POSE_STUDIO_USAGE.md#vnccs-character-export).

## Troubleshooting

### Pose Studio does not update from the UI

- The node relies on hidden `unique_id` sync and custom web UI code.
- Refresh the browser page after installing/updating the extension.
- If the workflow was loaded from an older version, save it again after opening the node once.
