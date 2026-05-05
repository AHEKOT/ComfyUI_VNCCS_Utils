import os
import folder_paths

# Model files are always stored under ComfyUI's models/sam3dbody folder.
# The path is derived from folder_paths.models_dir so it tracks whatever
# the user's ComfyUI install has configured as the models root, without
# requiring a UI input that drifts per environment.
MODEL_DIR = os.path.join(folder_paths.models_dir, "sam3dbody")
DEVICE_OPTIONS = ["Auto", "CUDA", "CPU"]


def _resolve_device(device_mode: str) -> str:
    import torch

    normalized = (device_mode or "Auto").strip().lower()
    if normalized == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if normalized == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("[SAM3DBody] CUDA was selected, but CUDA is not available.")
        return "cuda"
    if normalized == "cpu":
        return "cpu"
    raise ValueError(f"[SAM3DBody] Unsupported device mode: {device_mode}")


class LoadSAM3DBodyModel:
    """
    Prepares SAM 3D Body model configuration.

    Model files live in a fixed folder (`<ComfyUI>/models/sam3dbody/`);
    missing weights are auto-downloaded from HuggingFace on first use.
    The actual model is loaded lazily inside the isolated worker when
    inference runs.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "device_mode": (DEVICE_OPTIONS, {
                    "default": "Auto",
                    "tooltip": "Auto tries CUDA first and falls back to CPU if CUDA cannot be used"
                }),
            },
        }

    RETURN_TYPES = ("SAM3D_MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "load_model"
    CATEGORY = "SAM3DBody"

    def load_model(self, device_mode):
        """Prepare model config (actual loading happens in inference nodes)."""
        resolved_device = _resolve_device(device_mode)

        model_path = MODEL_DIR
        ckpt_path = os.path.join(model_path, "model.ckpt")
        mhr_path = os.path.join(model_path, "assets", "mhr_model.pt")

        # Check if model exists locally, download if not
        model_exists = os.path.exists(ckpt_path) and os.path.exists(mhr_path)

        if not model_exists:
            try:
                from huggingface_hub import snapshot_download

                print(f"[SAM3DBody] Model not found locally. Downloading from HuggingFace to {model_path} ...")
                os.makedirs(model_path, exist_ok=True)
                snapshot_download(
                    repo_id="jetjodh/sam-3d-body-dinov3",
                    local_dir=model_path
                )
                print(f"[SAM3DBody] Download complete.")

            except Exception as e:
                raise RuntimeError(
                    f"\n[SAM3DBody] Download failed.\n\n"
                    f"Please manually download from:\n"
                    f"  https://huggingface.co/jetjodh/sam-3d-body-dinov3\n\n"
                    f"And place the model files at:\n"
                    f"  {model_path}/\n"
                    f"    +-- model.ckpt          (SAM 3D Body checkpoint)\n"
                    f"    +-- model_config.yaml   (model configuration)\n"
                    f"    \\-- assets/\n"
                    f"        \\-- mhr_model.pt    (Momentum Human Rig model)\n\n"
                    f"Download error: {e}"
                ) from e

        # Return config dict (not the actual model)
        model_config = {
            "model_path": model_path,
            "ckpt_path": ckpt_path,
            "mhr_path": mhr_path,
            "device_mode": device_mode,
            "device": resolved_device,
        }

        return (model_config,)


# Register node
NODE_CLASS_MAPPINGS = {
    "LoadSAM3DBodyModel": LoadSAM3DBodyModel,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadSAM3DBodyModel": "Load SAM 3D Body Model",
}
