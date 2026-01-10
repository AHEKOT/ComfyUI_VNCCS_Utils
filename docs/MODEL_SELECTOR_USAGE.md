# VNCCS Model Selector Usage Guide

The **VNCCS Model Selector** is a powerful interface node designed to simplify model management in ComfyUI. It serves as a visual bridge between your model repository (managed by VNCCS Model Manager) and standard ComfyUI loader nodes.

## Features & Interface

The node presents a "Smart Card" UI that displays the currently selected model's status.

### Status Indicators

The widget uses color-coded indicators to show the state of the selected model:

*   **🟢 Green (Active)**: The model is installed, and the selected version matches the active version. Ready to generate.
*   **🟡 Yellow (Installed/Mismatch)**: The model is installed, but the version might differ from the latest config, or simply exists without robust version tracking. Safe to use.
*   **🔴 Red (Missing)**: The model is selected in the config but the file is missing from your disk. You need to download it.
*   **🔵 Blue / Spinner**: The model is currently downloading or updating.

### Model Selection

1.  **Click the Card**: Left-click anywhere on the model card to open the **Search Modal**.
2.  **Search & Filter**: Type in the search bar to filter models by name.
3.  **Select**: Click a model from the list to select it. If the model is not installed, the card will turn Red, indicating a download is needed (handled via the Manager's "Download All" or specific actions).

### Automatic Updates

The selector communicates with the **VNCCS Model Manager**. When the manager fetches a new `model_updater.json` from the repo, the Selector immediately knows about new versions.
If a new version is available, you will see a small update indicator (e.g., "New: v2.0").

## Integration with Standard Loaders

The most powerful feature of the Model Selector is its **Universal Output**.
It outputs a `STRING` containing the relative path to the model file.

This output is **Auto-Sanitized** to work with standard ComfyUI nodes.

### How to Connect

#### 1. Loading LoRAs
Connect the `model_path` output to the `lora_name` input of a standard **LoraLoader**.

> **Note:** LoraLoader expects paths relative to `models/loras/`.
> The VNCCS Selector automatically detects this and strips `models/loras/` from the full path.
> *   Full Path: `models/loras/characters/miku_v4.safetensors`
> *   Output: `characters/miku_v4.safetensors`

#### 2. Loading Checkpoints
Connect the `model_path` output to the `ckpt_name` input of a **CheckpointLoaderSimple**.

> The node detects `models/checkpoints/` and strips it, ensuring compatibility.

#### 3. Loading ControlNets
Connect to **ControlNetLoader**. Protocol strips `models/controlnet/`.

### Why use this instead of the built-in dropdown?
1.  **Live Updates**: You don't need to restart ComfyUI to see new models downloaded by VNCCS Manager.
2.  **Remote Sync**: Your team/project shares a `model_updater.json`. Everyone uses the same standardized model names, ensuring workflow consistency across different machines.
3.  **Visual Feedback**: You instantly see if you are missing a required model for a workflow.

## Troubleshooting

*   **"Model not found"**: Ensure the `VNCCS Model Manager` node is present in the workflow and has a valid `Repo ID`. Click "Check Models" on the Manager to refresh the cache.
*   **Wrong Path**: If the output path seems wrong (e.g., includes `models/loras/` twice), check your `model_updater.json` and ensure `local_path` is correct relative to ComfyUI root.
