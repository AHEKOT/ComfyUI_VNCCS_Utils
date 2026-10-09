# Optional ARDY worker

ARDY normally runs inside ComfyUI. The isolated worker is optional; its code and CLI
belong to the [standalone package](../nodes/posestudio/ttm/README.md).

```sh
python motion_worker/worker.py --family ardy --root /path/to/ComfyUI/models/text_to_motion
```

Install the package's dependencies in the worker environment. ComfyUI and the worker
must share the same model root. `--models ardy-core-rp-20fps-h40` selects the model
explicitly. `--idle-unload 600` frees the model and encoder after ten idle minutes;
zero keeps them loaded. Closing the Motion panel requests an unload. The node does not
start a worker automatically.
