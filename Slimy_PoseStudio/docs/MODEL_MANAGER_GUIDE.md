# VNCCS Model Selector Configuration Guide

The VNCCS Model Selector operates based on a configuration file named `model_updater.json`, which must be located at the root of your HuggingFace repository. This file defines the list of models available for download and selection within the interface.

A template file is available at `templates/template-model_updater.json`.

## Structure of `model_updater.json`

The root object must contain a `models` list and a `config_version`.

```json
{
    "models": [
        { ... model 1 ... },
        { ... model 2 ... }
    ],
    "config_version": "1.0"
}
```

## Model Object Fields

Each object in the `models` array describes a single model (LoRA, Checkpoint, ControlNet, etc.).

### Required Fields

| Field | Type | Description |
| :--- | :--- | :--- |
| `name` | string | **Display Name** of the model in the widget. Should be unique and descriptive. |
| `version` | string | **Version** of the model (e.g., "1.0.0", "v2.5"). Used for update checking. |
| `local_path` | string | **Local Path** for saving the file in ComfyUI. Path is relative to the ComfyUI root (e.g., `models/loras/my_model.safetensors`). |
| `description` | string | A short description displayed under the model name. |

### Download Source Fields (Choose One Option)

#### Option A: Download from HuggingFace (Recommended)

Use this option if the model file is hosted on Hugging Face.

| Field | Type | Description |
| :--- | :--- | :--- |
| `hf_repo` | string | Repository ID (e.g., `MIUProject/VNCCS`). |
| `hf_path` | string | Path to the file inside the repository (e.g., `models/loras/my_model.safetensors`). |

#### Option B: Direct Link / Civitai

Use this option for downloading from Civitai or via a direct URL.

| Field | Type | Description |
| :--- | :--- | :--- |
| `url` | string | Direct download link. <br>For Civitai, it supports links like `https://civitai.com/models/123?modelVersionId=456` (automatically converted to API download). |

> **Civitai Note:** If the model requires authorization, the user will be prompted to enter their API Key in the interface.

## Configuration Examples

### Example 1: LoRA from HuggingFace

```json
{
    "name": "VN Character Sheet",
    "hf_repo": "MIUProject/VNCCS",
    "hf_path": "models/loras/vn_character_sheet_v4.safetensors",
    "local_path": "models/loras/vn_character_sheet_v4.safetensors",
    "version": "4.0.0",
    "description": "Latest V4 LoRA for creating consistent character sheets."
}
```

### Example 2: Model from Civitai

```json
{
    "name": "Anime Aesthetic LoRA",
    "url": "https://civitai.com/models/929497?modelVersionId=2241189",
    "local_path": "models/loras/styles/anime_aesthetic.safetensors",
    "version": "1.0.0",
    "description": "Style downloaded directly from Civitai."
}
```

## Path Handling (`local_path`)

The VNCCS Manager automatically detects the category of the model based on standard ComfyUI paths.

When you connect the node output to standard loaders (e.g., `LoraLoader`), the manager **automatically strips** standard prefixes to ensure the path is valid for that loader.

*   If `local_path` = `models/loras/characters/miku.safetensors`
*   The node returns string: `characters/miku.safetensors` (suitable for LoraLoader)

Supported prefixes for automatic truncation:
*   `models/loras/`
*   `models/checkpoints/`
*   `models/vae/`
*   `models/controlnet/`
*   `models/upscale_models/`
... and other standard folders.

## Deployment

1. Create a `model_updater.json` file based on the template.
2. Upload it to the root of your HuggingFace repository.
3. In the **VNCCS Model Manager** node, specify your `Repo ID`.
4. The Manager will automatically fetch the model list from your JSON.
