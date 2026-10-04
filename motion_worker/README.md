# Isolated motion worker

**ARDY and Kimodo do not need this:** they are built into VNCCS Utils and run in ComfyUI's
own Python like UniCanvas Draw (see `api/text_to_motion/vendor/`).

The optional models **HY-Motion** and **UniMate** pin their own `torch`, `transformers` and
`numpy` versions (HY-Motion: torch 2.5.1, transformers 4.53.3, numpy below 2). Installed into
ComfyUI's Python they would replace the versions ComfyUI and other node packs need. So if you
want them, each runs in its **own environment**, as a separate process next to ComfyUI:

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

The normal way is a **venv** per model family (`hymotion`, `unimate`), the
same pattern ComfyUI itself uses. Docker is only an optional alternative for people who
already run it. The Text to Motion panel shows a model as *ready* as soon as its worker runs.

## venv (recommended; Linux, macOS, Windows, ComfyUI portable)

From `custom_nodes/ComfyUI_VNCCS_Utils`:

```sh
motion_worker/install.sh hymotion    # once: creates motion_worker/envs/hymotion
motion_worker/run.sh hymotion        # keep it running next to ComfyUI
```

Windows: `motion_worker\install.bat hymotion`, then `motion_worker\run.bat hymotion`.

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
- HY-Motion and UniMate also need their code in `models/text_to_motion/code/...` (the panel
  shows the clone commands). Do not install those repositories' `requirements.txt` anywhere.
- The environments live in `motion_worker/envs/`. Updating the extension by deleting and
  re-cloning it removes them; run `install.sh` again then.

## Docker (optional; Linux with the NVIDIA Container Toolkit)

```sh
docker compose -f motion_worker/docker-compose.yml --profile hymotion up -d --build
```

The container restarts with Docker, mounts `${COMFYUI_MODELS:-../../../models}/text_to_motion`
as its shared folder and your Hugging Face cache (`${HF_CACHE:-~/.cache/huggingface}`, so a
`hf auth login` on the host is enough), and writes files as `UID:GID` (default 1000) so ComfyUI
can clean them up: `UID=$(id -u) GID=$(id -g) docker compose ...`. Several profiles can run at
once (`--profile hymotion --profile unimate`).

## Several workers, one GPU

Every worker is independent; run only the ones you use. The GPU is shared with ComfyUI:
a short `--idle-unload` gives memory back sooner.
