# Isolated motion worker

Pose Studio's text-to-motion models (ARDY, Kimodo, HY-Motion, UniMate) pin their own
`torch`, `transformers` and `numpy` versions. Installed into ComfyUI's Python they replace
the versions ComfyUI and other node packs need, and they conflict with each other (ARDY wants
transformers 5.8.1, Kimodo 5.1.0, HY-Motion 4.53.3). So each model family runs in its **own
environment**, as a separate process next to ComfyUI:

```
 ComfyUI (unchanged Python)                     motion worker (own venv or container)
 Pose Studio ── job JSON ──▶ models/text_to_motion/jobs/<worker>/inbox ──▶ loads the model
             ◀─ progress / result JSON ─ status/, outbox/ ◀──────────────── generates
             ◀─ heartbeat: models it serves ─ workers/<worker>.json
```

They share only the `models/text_to_motion` folder. ComfyUI never imports the model code,
never holds its model lock for a motion and never evicts its own models from VRAM, so your
other workflows keep running while a motion is generated. The worker frees its model after
10 minutes without jobs (`--idle-unload`, seconds). Model weights and code checkouts stay in
`models/text_to_motion`, the same place as before.

The normal way is a **venv** per model family (`ardy`, `kimodo`, `hymotion`, `unimate`), the
same pattern ComfyUI itself uses. Docker is only an optional alternative for people who
already run it. The Text to Motion panel shows a model as *ready* as soon as its worker runs.

## venv (recommended; Linux, macOS, Windows, ComfyUI portable)

From `custom_nodes/ComfyUI_VNCCS_Utils`:

```sh
motion_worker/install.sh ardy        # once: creates motion_worker/envs/ardy
motion_worker/run.sh ardy            # keep it running next to ComfyUI
```

Windows: `motion_worker\install.bat ardy`, then `motion_worker\run.bat ardy`.

- No Python on the machine, or ComfyUI portable (its embedded Python cannot make venvs)?
  Install [uv](https://docs.astral.sh/uv/) once
  (Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`,
  Linux/macOS: `curl -LsSf https://astral.sh/uv/install.sh | sh`). When uv is present the
  scripts use it and it downloads Python 3.11 into the venv by itself (`PYTHON_VERSION` picks
  another); without uv they use the system Python (`py -3.11` on Windows, `python3` elsewhere).
  ComfyUI's own Python is never used or changed.
- `install.sh` installs PyTorch from `TORCH_INDEX` (default CUDA 12.6 wheels:
  `TORCH_INDEX=https://download.pytorch.org/whl/cu124 motion_worker/install.sh hymotion`),
  then `requirements/<family>.txt`. Set `PYTHON=python3.11` to choose the interpreter.
- ARDY builds a C++ extension: install CMake and a C++17 compiler first.
- ARDY and Kimodo use the gated Llama 3 text encoder: request access on
  <https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct> and run
  `motion_worker/envs/ardy/bin/hf auth login` once
  (Windows: `motion_worker\envs\ardy\Scripts\hf.exe auth login`).
- HY-Motion and UniMate also need their code in `models/text_to_motion/code/...` (the panel
  shows the clone commands). Do not install those repositories' `requirements.txt` anywhere.
- The environments live in `motion_worker/envs/`. Updating the extension by deleting and
  re-cloning it removes them; run `install.sh` again then.

## Docker (optional; Linux with the NVIDIA Container Toolkit)

```sh
docker compose -f motion_worker/docker-compose.yml --profile ardy up -d --build
```

The container restarts with Docker, mounts `${COMFYUI_MODELS:-../../../models}/text_to_motion`
as its shared folder and your Hugging Face cache (`${HF_CACHE:-~/.cache/huggingface}`, so a
`hf auth login` on the host is enough), and writes files as `UID:GID` (default 1000) so ComfyUI
can clean them up: `UID=$(id -u) GID=$(id -g) docker compose ...`. Several profiles can run at
once (`--profile ardy --profile hymotion`).

## Several workers, one GPU

Every worker is independent; run only the ones you use. The GPU is shared with ComfyUI:
`TEXT_ENCODER_DEVICE=cpu` keeps the 8B text encoder of ARDY / Kimodo on the CPU (slower
prompts, about 14 GB less VRAM), and a short `--idle-unload` gives memory back sooner.
