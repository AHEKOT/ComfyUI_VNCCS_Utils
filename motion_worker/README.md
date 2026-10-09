# Optional motion worker

ARDY and Kimodo normally run inside ComfyUI. They need no worker or separate installation.
The generic worker entry point remains available for running either backend in an existing
Python environment with its required dependencies.

From the extension folder, start it with that environment's Python:

```sh
python motion_worker/worker.py --family ardy --root <ComfyUI>/models/text_to_motion
# Or select Kimodo:
python motion_worker/worker.py --family kimodo --root <ComfyUI>/models/text_to_motion
```

ComfyUI and the worker must share the same `models/text_to_motion` folder. The worker
advertises available models in `workers/`, reads jobs from `jobs/`, and returns progress
and results through files. Pose Studio uses a running worker when it advertises the
selected model; otherwise generation uses ComfyUI's Python.

The worker keeps one model loaded and unloads it after 600 seconds without jobs.
Use `--idle-unload` to change that interval, or `--models` to select model IDs explicitly.
GPU memory is shared with ComfyUI; a worker does not provide a separate GPU allocation.
