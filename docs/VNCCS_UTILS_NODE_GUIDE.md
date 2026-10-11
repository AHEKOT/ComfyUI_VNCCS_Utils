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

## Troubleshooting

### Pose Studio does not update from the UI

- The node relies on hidden `unique_id` sync and custom web UI code.
- Refresh the browser page after installing/updating the extension.
- If the workflow was loaded from an older version, save it again after opening the node once.
