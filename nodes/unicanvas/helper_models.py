"""Lazy downloads of small helper models (SAM 3, rembg ONNX, layer-naming VLMs) into ComfyUI's models dir.

Every helper is a pinned public Hugging Face file set (repo, revision, files), fetched with
``token=False`` on first use into ``<models>/<folder>/``. Nothing is downloaded at import time.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass


@dataclass(frozen=True)
class HelperModel:
    key: str
    label: str
    repo_id: str
    revision: str
    files: tuple[str, ...]
    folder: str


HELPER_MODELS: dict[str, HelperModel] = {
    "sam3": HelperModel(
        key="sam3",
        label="SAM 3",
        repo_id="1038lab/sam3",  # public mirror of the gated facebook/sam3 weights
        revision="ea8e153c669a0284a496c0ec65a53b8e4f5ca7e7",
        files=("sam3.pt",),
        folder="sam3",
    ),
    "rembg_u2net": HelperModel(
        key="rembg_u2net",
        label="rembg u2net",
        repo_id="tomjackson2023/rembg",
        revision="cd3a3d6767a7859efea31ef0f2f373582cf06d82",
        files=("u2net.onnx",),
        folder="rembg",
    ),
    "rembg_isnet": HelperModel(
        key="rembg_isnet",
        label="rembg isnet-general-use",
        repo_id="tomjackson2023/rembg",
        revision="cd3a3d6767a7859efea31ef0f2f373582cf06d82",
        files=("isnet-general-use.onnx",),
        folder="rembg",
    ),
    "smolvlm_256m": HelperModel(
        key="smolvlm_256m",
        label="SmolVLM-256M-Instruct",
        repo_id="HuggingFaceTB/SmolVLM-256M-Instruct",
        revision="7e3e67edbbed1bf9888184d9df282b700a323964",
        files=(
            "added_tokens.json", "chat_template.json", "config.json", "generation_config.json",
            "merges.txt", "model.safetensors", "preprocessor_config.json", "processor_config.json",
            "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json", "vocab.json",
        ),
        folder=os.path.join("LLM", "SmolVLM-256M-Instruct"),
    ),
    "qwen3vl_2b": HelperModel(
        key="qwen3vl_2b",
        label="Qwen3-VL-2B-Instruct",
        repo_id="Qwen/Qwen3-VL-2B-Instruct",
        revision="89644892e4d85e24eaac8bacfd4f463576704203",
        files=(
            "chat_template.json", "config.json", "generation_config.json", "merges.txt",
            "model.safetensors", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
            "video_preprocessor_config.json", "vocab.json",
        ),
        folder=os.path.join("LLM", "Qwen3-VL-2B-Instruct"),
    ),
}

_DOWNLOAD_LOCK = threading.Lock()


def helper_model_dir(helper: HelperModel) -> str:
    import folder_paths

    return os.path.join(folder_paths.models_dir, helper.folder)


def helper_model_ready(key: str) -> bool:
    helper = HELPER_MODELS[key]
    root = helper_model_dir(helper)
    return all(os.path.isfile(os.path.join(root, name)) for name in helper.files)


def ensure_helper_model(key: str) -> str:
    """Directory holding every file of the helper model, downloading what is missing."""
    helper = HELPER_MODELS[key]
    root = helper_model_dir(helper)
    with _DOWNLOAD_LOCK:
        missing = [name for name in helper.files if not os.path.isfile(os.path.join(root, name))]
        if not missing:
            return root
        from huggingface_hub import hf_hub_download

        os.makedirs(root, exist_ok=True)
        for name in missing:
            try:
                hf_hub_download(
                    repo_id=helper.repo_id,
                    filename=name,
                    revision=helper.revision,
                    repo_type="model",
                    local_dir=root,
                    token=False,
                )
            except Exception as exc:
                raise RuntimeError(f"[VNCCS UniCanvas] Downloading {helper.label} ({name}) failed: {exc}") from exc
    return root


def ensure_helper_model_file(key: str, filename: str | None = None) -> str:
    helper = HELPER_MODELS[key]
    root = ensure_helper_model(key)
    return os.path.join(root, filename or helper.files[0])
