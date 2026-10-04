"""LLM2Vec text encoder used by ARDY and Kimodo, without peft or patched transformers classes.

ARDY and Kimodo condition on the LLM2Vec embedding of the prompt
(McGill-NLP/LLM2Vec-Meta-Llama-3-8B-Instruct-mntp + -supervised, MIT): Meta Llama 3 8B
Instruct turned bidirectional, two LoRA adapters on top, mean-pooled over the prompt
tokens. Their vendored llm2vec package needs ``peft`` and subclasses transformers'
Llama internals that change between releases. This module reproduces the same
computation on the stock ``LlamaModel``:

* bidirectional attention: every layer's ``is_causal`` is off and the model gets a full
  4D attention mask, which transformers uses as is (4.4x and 5.x alike);
* the adapters are merged into the base weights by hand (``W += B @ A * alpha / r``);
* the prompt is wrapped in the Llama 3 user turn and the embedding is the mean of the
  last hidden state over the prompt's own tokens (LLM2Vec ``skip_instruction``).

To keep ComfyUI's VRAM free the model lives on the CPU and is moved to the GPU only
while a prompt is encoded (``offload=True``).
"""

from __future__ import annotations

import json
from pathlib import Path

import torch

_PROMPT_TEMPLATE = "<|start_header_id|>user<|end_header_id|>\n\n{text}<|eot_id|>"
_LORA_SUFFIXES = (".lora_A.weight", ".lora_B.weight")


def _read_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _adapter_state(folder: Path) -> dict:
    from safetensors.torch import load_file

    path = folder / "adapter_model.safetensors"
    if path.is_file():
        return load_file(str(path))
    path = folder / "adapter_model.bin"
    if path.is_file():
        return torch.load(path, map_location="cpu", weights_only=True)
    raise FileNotFoundError(f"no adapter_model.safetensors in {folder}")


def _module_key(key: str) -> str:
    """``base_model.model.model.layers.3.self_attn.q_proj`` -> ``layers.3.self_attn.q_proj``."""
    index = key.find("layers.")
    if index < 0:
        raise ValueError(f"unexpected LoRA weight name: {key}")
    return key[index:]


def merge_lora(model: torch.nn.Module, adapter_folder: Path) -> int:
    """Merge one LoRA adapter into ``model`` in place. Returns the number of merged layers."""
    config = _read_json(Path(adapter_folder) / "adapter_config.json")
    if config.get("use_dora"):
        raise ValueError(f"{adapter_folder}: DoRA adapters are not supported")
    rank = int(config["r"])
    alpha = float(config.get("lora_alpha", rank))
    scale = alpha / (rank ** 0.5) if config.get("use_rslora") else alpha / rank
    fan_in_fan_out = bool(config.get("fan_in_fan_out"))
    state = _adapter_state(Path(adapter_folder))
    pairs = {}
    for key, value in state.items():
        suffix = next((s for s in _LORA_SUFFIXES if key.endswith(s)), None)
        if suffix is None:
            raise ValueError(f"{adapter_folder}: unsupported adapter weight {key}")
        pairs.setdefault(_module_key(key[: -len(suffix)]), {})[suffix] = value
    modules = dict(model.named_modules())
    for name, pair in pairs.items():
        layer = modules.get(name)
        if layer is None or not hasattr(layer, "weight"):
            raise ValueError(f"{adapter_folder}: the base model has no layer {name}")
        a, b = pair[".lora_A.weight"], pair[".lora_B.weight"]
        delta = (b.float() @ a.float()) * scale
        if fan_in_fan_out:
            delta = delta.T
        with torch.no_grad():
            layer.weight.add_(delta.to(device=layer.weight.device, dtype=layer.weight.dtype))
    return len(pairs)


def make_bidirectional(model: torch.nn.Module) -> None:
    for module in model.modules():
        if hasattr(module, "is_causal"):
            module.is_causal = False


def full_attention_mask(attention_mask: torch.Tensor, dtype: torch.dtype) -> torch.Tensor:
    """[B, L] padding mask -> [B, 1, L, L] additive mask that lets every token see every token."""
    keep = attention_mask[:, None, None, :].to(torch.bool)
    mask = torch.zeros(attention_mask.shape[0], 1, attention_mask.shape[1], attention_mask.shape[1], dtype=dtype,
                       device=attention_mask.device)
    return mask.masked_fill(~keep, torch.finfo(dtype).min)


class LLM2VecEncoder:
    """Callable like ARDY's / Kimodo's encoder: ``encoder(texts) -> (embeddings [B, 1, D], lengths)``."""

    def __init__(self, base_dir, adapter_dirs=(), llm_dim: int = 4096, dtype=torch.bfloat16,
                 device=None, offload: bool = True, pooling_mode: str = "mean", max_length: int = 512):
        from transformers import AutoTokenizer, LlamaModel

        self.llm_dim = int(llm_dim)
        self.offload = bool(offload)
        self.pooling_mode = pooling_mode
        self.max_length = int(max_length)
        self.tokenizer = AutoTokenizer.from_pretrained(str(base_dir))
        self.tokenizer.pad_token = self.tokenizer.eos_token
        self.tokenizer.padding_side = "left"
        try:
            model = LlamaModel.from_pretrained(str(base_dir), dtype=dtype, attn_implementation="sdpa")
        except TypeError:  # transformers 4.x names the argument torch_dtype
            model = LlamaModel.from_pretrained(str(base_dir), torch_dtype=dtype, attn_implementation="sdpa")
        for folder in adapter_dirs:
            merge_lora(model, Path(folder))
            settings = Path(folder) / "llm2vec_config.json"
            if settings.is_file():
                data = _read_json(settings)
                self.pooling_mode = str(data.get("pooling_mode", self.pooling_mode))
                self.max_length = int(data.get("max_length", self.max_length))
        make_bidirectional(model)
        model.eval()
        for parameter in model.parameters():
            parameter.requires_grad_(False)
        self.model = model
        self._device = torch.device(device) if device is not None else torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if not self.offload:
            self.model.to(self._device)

    # --- interface the motion models use ------------------------------------------

    def to(self, device=None, dtype=None):
        if device is not None:
            self._device = torch.device(device)
        if dtype is not None:
            self.model.to(dtype=dtype)
        if device is not None and not self.offload:
            self.model.to(self._device)
        return self

    def eval(self):
        return self

    def get_device(self):
        return self._device

    def _tokens(self, text: str):
        wrapped = _PROMPT_TEMPLATE.format(text=text.strip())
        features = self.tokenizer([wrapped], return_tensors="pt", padding=True, truncation=True, max_length=self.max_length)
        # The prompt's own tokens (everything after the user header) are pooled.
        own = self.tokenizer([text.strip() + "<|eot_id|>"], add_special_tokens=False, truncation=True,
                             max_length=self.max_length)["input_ids"][0]
        return features, max(1, min(len(own), int(features["attention_mask"].sum())))

    @torch.no_grad()
    def encode_one(self, text: str) -> torch.Tensor:
        features, pooled = self._tokens(text)
        device = self._device
        input_ids = features["input_ids"].to(device)
        mask = features["attention_mask"].to(device)
        dtype = next(self.model.parameters()).dtype
        hidden = self.model(input_ids=input_ids, attention_mask=full_attention_mask(mask, dtype)).last_hidden_state
        if self.pooling_mode == "mean":
            embedding = hidden[0, -pooled:, :].mean(dim=0)
        elif self.pooling_mode in ("eos_token", "last_token"):
            embedding = hidden[0, -1, :]
        else:
            raise ValueError(f"unsupported LLM2Vec pooling mode {self.pooling_mode!r}")
        return embedding.float()

    def __call__(self, text):
        single = isinstance(text, str)
        texts = [text] if single else list(text)
        if self.offload:
            self.model.to(self._device)
        try:
            # One prompt at a time: batching changes the embeddings slightly (LLM2Vec keeps batch_size=1 too).
            embeddings = torch.stack([self.encode_one(item) for item in texts]).to(self._device)
        finally:
            if self.offload:
                self.model.to("cpu")
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
        if embeddings.shape[-1] != self.llm_dim:
            raise ValueError(f"text encoder produced {embeddings.shape[-1]} features, expected {self.llm_dim}")
        embeddings = embeddings[:, None]
        lengths = [1] * len(texts)
        if single:
            return embeddings[0], lengths[0]
        return embeddings, lengths
