"""Local Marigold appearance decomposition, run after the Qwen view pass."""

from pathlib import Path
from typing import Any, Callable

MARIGOLD_DIRECTORY = "geometry_estimation/marigold-iid-appearance-v1-1"
MARIGOLD_FILES = (
    "model_index.json", "scheduler/scheduler_config.json",
    "text_encoder/config.json", "text_encoder/model.fp16.safetensors",
    "tokenizer/merges.txt", "tokenizer/special_tokens_map.json",
    "tokenizer/tokenizer_config.json", "tokenizer/vocab.json",
    "unet/config.json", "unet/diffusion_pytorch_model.fp16.safetensors",
    "vae/config.json", "vae/diffusion_pytorch_model.fp16.safetensors",
)
MARIGOLD_WEIGHT_SPECS = {
    f"{MARIGOLD_DIRECTORY}/{name}": {
        "repo_id": "prs-eth/marigold-iid-appearance-v1-1",
        "revision": "e7280a0a0fc5a0df0b36050882b3d8b77da22fd9",
        "filename": name,
        "directory": MARIGOLD_DIRECTORY,
    }
    for name in MARIGOLD_FILES
}


def appearance_maps(prediction: Any) -> tuple[Any, Any, Any]:
    """The pinned model predicts sRGB albedo and linear R=roughness/G=metallicity."""
    import torch

    value = torch.as_tensor(prediction).float()
    if value.ndim != 4 or value.shape[0] != 2 or value.shape[-1] != 3:
        raise RuntimeError("Marigold returned an unexpected appearance map layout")
    if not bool(torch.isfinite(value).all()):
        raise RuntimeError("Marigold returned non-finite appearance maps")
    value = value.clamp(0, 1)
    return value[0], value[1, ..., 0:1], value[1, ..., 1:2]


def extract_materials(
    model_directory: Path,
    views: list[dict[str, Any]],
    output_dir: Path,
    seed: int,
    *,
    check_cancel: Callable[[], None],
    on_view: Callable[[int, tuple[Any, Any, Any]], None],
) -> None:
    import torch
    import comfy.model_management as model_management
    from diffusers import MarigoldIntrinsicsPipeline
    from PIL import Image

    from .generation import release_runtime_memory

    check_cancel()
    release_runtime_memory()
    device = model_management.get_torch_device()
    dtype = torch.float32 if device.type == "cpu" else torch.float16
    pipeline = None
    hook = None
    try:
        pipeline = MarigoldIntrinsicsPipeline.from_pretrained(
            str(model_directory), local_files_only=True, token=False,
            use_safetensors=True, variant="fp16", torch_dtype=dtype,
            low_cpu_mem_usage=False,
        ).to(device)
        pipeline.set_progress_bar_config(disable=True)
        hook = pipeline.unet.register_forward_pre_hook(lambda _module, _args: check_cancel())
        for index, view in enumerate(views):
            check_cancel()
            with Image.open(output_dir / view["refined"]) as image:
                result = pipeline(
                    image.convert("RGB"), num_inference_steps=4, ensemble_size=1,
                    processing_resolution=768, match_input_resolution=True,
                    generator=torch.Generator(device="cpu").manual_seed(seed + index),
                    output_type="np",
                )
            check_cancel()
            on_view(index, appearance_maps(result.prediction))
    finally:
        if hook is not None:
            hook.remove()
        if pipeline is not None:
            pipeline.to("cpu")
        del pipeline
        release_runtime_memory()
