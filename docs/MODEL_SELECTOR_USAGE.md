# VNCCS Model Manager and Selector Usage

This guide focuses on the model-management pair:

- `VNCCS Model Manager`
- `VNCCS Model Selector`

For the full node reference, including Position Control, QWEN Detailer, BBox
Extractor, and Pose Studio, see `MODEL_MANAGER_GUIDE.md`.

## What These Nodes Do

`VNCCS Model Manager` gives a workflow a project model repository id. The custom
web UI uses that id to load a remote `model_updater.json`, display install
status, save tokens, and queue downloads.

`VNCCS Model Selector` reads the same manifest and outputs a model path string
that can be connected to standard ComfyUI loaders.

Typical chain:

```text
VNCCS Model Manager.repo_id
  -> VNCCS Model Selector.repo_id
  -> model_path
  -> LoraLoader.lora_name / CheckpointLoaderSimple.ckpt_name / ControlNetLoader.control_net_name
```

## VNCCS Model Manager

Inputs:

| Input | Type | Default |
| --- | --- | --- |
| `repo_id` | `STRING` | `MIUProject/VNCCS` |

Outputs:

| Output | Type | Notes |
| --- | --- | --- |
| `repo_id` | `STRING` | Pass-through output for selectors and other project-aware nodes. |

The manager expects this file in the root of the Hugging Face repository:

```text
model_updater.json
```

The manager UI can:

- Fetch the manifest.
- Show models grouped by `name`.
- Show installed, missing, outdated, and downloading states.
- Queue downloads.
- Save Hugging Face and Civitai tokens.
- Set the active installed version for a model name.

## VNCCS Model Selector

Inputs:

| Input | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo_id` | `STRING` | `MIUProject/VNCCS` | Connect from Model Manager for consistency. |
| `model_name` | hidden `STRING` | empty | Written by the selector UI card. |
| `version` | hidden `STRING` | `auto` | Written by the selector UI; `auto` uses active registry or latest manifest version. |

Output:

| Output | Type | Notes |
| --- | --- | --- |
| `model_path` | universal string-like type | Loader-compatible relative model path. |

Selection priority:

1. Explicit hidden `version`, when it is not `auto`.
2. Active version from `vnccs_installed_models.json`.
3. Latest manifest version for the selected `model_name`.

The selector performs case-insensitive model-name matching. If the requested
version cannot be found, it falls back to the latest version for that model
name and logs the fallback in the ComfyUI console.

## Manifest Format

Minimal manifest:

```json
{
  "config_version": "1.0",
  "models": [
    {
      "name": "Example LoRA",
      "version": "1.0.0",
      "description": "Short description shown in the VNCCS UI.",
      "hf_repo": "MIUProject/VNCCS",
      "hf_path": "models/loras/example_lora.safetensors",
      "local_path": "models/loras/example_lora.safetensors"
    }
  ]
}
```

Top-level fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `config_version` | string | recommended | Informational manifest version. |
| `models` | list | yes | List of model-version entries. |

Model fields:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | Display name and selector key. Use the same name for multiple versions. |
| `version` | string | yes | Version string. Semantic versions sort best, but plain strings are accepted. |
| `description` | string | recommended | Displayed in UI. |
| `local_path` | string | yes | Must start with `models/` and include the filename. |
| `hf_repo` | string | for HF source | Overrides the manager `repo_id` for this one file. |
| `hf_path` | string | for HF source | File path inside the Hugging Face model repository. |
| `url` | string | for direct source | HTTPS direct download URL or supported Civitai model URL. |

Use either `hf_repo`/`hf_path` or `url` for each model entry.

## Direct URLs and Civitai

Direct URL example:

```json
{
  "name": "Example Direct Model",
  "version": "1.0.0",
  "description": "Downloaded from a direct HTTPS URL.",
  "url": "https://example.com/files/model.safetensors",
  "local_path": "models/loras/example_direct_model.safetensors"
}
```

Civitai model-page URL example:

```json
{
  "name": "Example Civitai LoRA",
  "version": "1.0.0",
  "description": "Downloaded from Civitai.",
  "url": "https://civitai.com/models/12345?modelVersionId=67890",
  "local_path": "models/loras/example_civitai_lora.safetensors"
}
```

When a Civitai page URL contains `modelVersionId`, the manager converts it to:

```text
https://civitai.com/api/download/models/<modelVersionId>
```

If the file requires auth, save a Civitai token in the manager UI.

## Path Rules

`local_path` is intentionally strict:

- It must be relative.
- It must start with `models/`.
- It must include a file path after `models/`.
- It cannot contain `..`.
- It cannot start with `/`, `\`, or `~`.
- It cannot be URL-like.
- It must resolve inside ComfyUI's configured `models_dir`.

Valid examples:

```text
models/loras/characters/example.safetensors
models/checkpoints/example_checkpoint.safetensors
models/controlnet/example_controlnet.safetensors
models/vae/example_vae.safetensors
models/upscale_models/example_upscaler.pth
```

Invalid examples:

```text
../models/loras/bad.safetensors
/tmp/bad.safetensors
~/bad.safetensors
models/../custom_nodes/bad.py
https://example.com/model.safetensors
```

## Loader Path Conversion

The selector returns a path suitable for standard ComfyUI loader dropdowns. It
strips known `models/.../` prefixes:

| Manifest `local_path` | Selector output |
| --- | --- |
| `models/loras/characters/miku.safetensors` | `characters/miku.safetensors` |
| `models/checkpoints/anime/model.safetensors` | `anime/model.safetensors` |
| `models/controlnet/depth.safetensors` | `depth.safetensors` |
| `models/vae/vae-ft.safetensors` | `vae-ft.safetensors` |

Prefixes stripped:

- `models/loras/`
- `models/checkpoints/`
- `models/vae/`
- `models/controlnet/`
- `models/style_models/`
- `models/upscale_models/`
- `models/clip/`
- `models/unet/`
- `models/diffusers/`
- `models/configs/`

If no known prefix matches, the selector returns the normalized `local_path`.

## Recommended Workflows

### Shared Team LoRA

1. Create a Hugging Face model repository for your team.
2. Put `model_updater.json` in the repository root.
3. Add each LoRA version as a separate manifest entry with the same `name` and a different `version`.
4. In ComfyUI, add `VNCCS Model Manager` and set `repo_id`.
5. Add `VNCCS Model Selector`, connect `repo_id`, choose the LoRA in the card UI.
6. Connect `model_path` to `LoraLoader.lora_name`.

### Checkpoint Picker

1. Add checkpoint entries with `local_path` under `models/checkpoints/`.
2. Select a checkpoint in `VNCCS Model Selector`.
3. Connect `model_path` to `CheckpointLoaderSimple.ckpt_name`.

### Private Hugging Face Repository

1. Save `hf_token` in the manager UI.
2. Use either the manager `repo_id` as the source repository or set `hf_repo` per entry.
3. Queue downloads from the manager UI.

## Status Meaning

| Status | Meaning |
| --- | --- |
| `installed` | The active installed version equals the latest manifest version. |
| `outdated` | A model version is installed, but it is not the latest manifest version or the active version needs selection. |
| `missing` | No manifest version for that model name exists on disk. |
| `queued` / `downloading` | Download worker has accepted or is processing the model. |
| `success` | Download finished and the active version registry was updated. |
| `error` | Download/check failed. See the manager UI and ComfyUI console. |

## Local Files Written by the Manager

| File | Location | Purpose |
| --- | --- | --- |
| `vnccs_installed_models.json` | ComfyUI root | Maps model name to active version. |
| `vnccs_user_config.json` | ComfyUI root | Stores `hf_token`, `civitai_token`, and related settings. |
| temporary download files | `<ComfyUI>/temp` | Used while downloads are in progress, then moved into `models/`. |

## Troubleshooting

### The selector card is empty

- Open the selector search UI and choose a model.
- Make sure the manager `repo_id` is connected to the selector.
- Make sure the manifest has a `models` list and each entry has `name`, `version`, and `local_path`.

### The selected model is missing

- Use the manager UI to download it.
- Check that `local_path` points to the same models folder ComfyUI is using.
- If you manually copied the file, use the manager check/refresh action.

### The selector output does not match the loader

- Confirm the manifest path uses a standard prefix such as `models/loras/`.
- For custom model folders not listed above, the selector may return the full normalized path.
- Standard ComfyUI loaders usually expect paths relative to their model subfolder.

### Downloads fail for direct URLs

- The URL must be HTTPS.
- Local/private/reserved network destinations are blocked, including hostnames that resolve to those IP ranges.
- For Civitai, include `modelVersionId` in page URLs or use a direct API/download URL.
- Save `civitai_token` when the Civitai file requires authentication.

### Hugging Face downloads fail

- Check that the repository exists and is a model repository.
- Check that `model_updater.json` exists at the root.
- Save `hf_token` for private repositories.
- Check the ComfyUI console for Hugging Face validation or 404 messages.
