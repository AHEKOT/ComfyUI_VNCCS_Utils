# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A ComfyUI custom nodes extension providing utility nodes for image generation workflows. Installed as a folder inside ComfyUI's `custom_nodes/` directory and loaded automatically by ComfyUI on startup.

**Dependencies**: opencv-python, huggingface_hub, aiohttp, kornia, requests, torch, numpy, Pillow

## No Build Step

There is no build, lint, or test command. Changes to Python files take effect after restarting ComfyUI. Changes to JavaScript files in `web/` take effect after refreshing the browser (hard refresh if cached).

To verify the extension loads correctly, check the ComfyUI server console for `[VNCCS ...]` log lines on startup.

## Architecture

### ComfyUI Integration Points

`__init__.py` is the entry point. ComfyUI loads it and reads:
- `NODE_CLASS_MAPPINGS` — dict of node_id → Python class
- `NODE_DISPLAY_NAME_MAPPINGS` — dict of node_id → display name
- `WEB_DIRECTORY = "./web"` — tells ComfyUI to serve all JS from this folder

`__init__.py` also registers custom HTTP endpoints on `PromptServer.instance.routes` (aiohttp) for the character mesh preview (`/vnccs/character_studio/update_preview`) and pose library CRUD.

### Node Structure

Each Python node class must implement:
- `INPUT_TYPES(cls)` classmethod returning a dict of input specs
- `RETURN_TYPES`, `RETURN_NAMES`, `CATEGORY`, `FUNCTION` class attributes
- The method named by `FUNCTION` that does the actual work

### Custom Widgets (JavaScript)

Nodes with interactive UIs have matching JS files in `web/`. ComfyUI loads all `.js` files from `WEB_DIRECTORY` as ES modules. They use:
```js
import { app } from "../../scripts/app.js";   // ComfyUI app
import { api } from "../../scripts/api.js";    // ComfyUI API client
```

Widgets register themselves via `app.registerExtension({ name, ..., nodeCreated })`.

### Pose Studio Architecture (most complex node)

Split across two JS files by design:
- **`vnccs_pose_studio_core.js`** — UI-agnostic Three.js viewer, IK solvers, skeleton rendering. Exports `PoseViewerCore` and `IK_CHAINS`. No ComfyUI dependencies.
- **`vnccs_pose_studio.js`** — ComfyUI node shell. Consumes `PoseViewerCore` exclusively via its public API. All ComfyUI-specific logic lives here.

The Python side (`nodes/pose_studio.py`) handles image rendering at queue time: it receives pose data (bone rotations + camera params) from the JS widget as a JSON string, renders frames using PIL, and outputs them as tensors.

### CharacterData Module

Parses MakeHuman `.mhskel` and `.target` files at runtime to build a morphable 3D human mesh. Data is loaded lazily on first use and cached in `POSE_STUDIO_CACHE` (singleton dict in `pose_studio.py`). Requires MakeHuman data files placed at `CharacterData/makehuman/`.

The `/vnccs/character_studio/update_preview` endpoint (registered in `__init__.py`) accepts morph parameters (age, gender, weight, etc.), solves the mesh via `HumanSolver`, and returns vertices + bone positions as JSON for the Three.js frontend.

### Pose Library

Saved poses are stored in `PoseLibrary/` at the extension root (created at runtime). Each pose is a `.json` file + optional `.png` preview. CRUD endpoints registered in `api/pose_library.py` and mounted in `__init__.py`.

### Model Manager

`nodes/vnccs_model_manager.py` downloads models from HuggingFace using `huggingface_hub`. It reads a `model_updater.json` config from a user-specified HF repo. Downloads run in a background thread queue. Config is cached in memory with a two-tier TTL (5 min for UI, 60 min for remote update checks).

### Three.js Vendoring

Three.js and its extensions (`OrbitControls.js`, `TransformControls.js`) are vendored locally in `web/` to avoid CSP violations and CDN dependencies. Do not replace with CDN imports.

## Key Conventions

- The `EXTENSION_URL` pattern in JS files (`new URL(".", import.meta.url)`) is required to resolve asset paths correctly regardless of the extension's directory name on disk.
- `AnyType` in `vnccs_model_manager.py` is a ComfyUI pattern to create a universal wildcard type that accepts any connection.
- All new API endpoints must use the `/vnccs/` prefix and be registered in `__init__.py` or `api/pose_library.py`.
- Version is tracked in `pyproject.toml` and `CHANGELOG.md`.
