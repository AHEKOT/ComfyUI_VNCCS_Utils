"""Prepared LLM2Vec ConvRot INT4 encoder on the stock bidirectional LlamaModel.

Adapters are already merged in the checkpoint. Prompt wrapping, full attention and
prompt-only pooling preserve the accepted inference path. The encoder is offloaded
between prompts when requested.
"""

from __future__ import annotations

from pathlib import Path

import torch

_PROMPT_TEMPLATE = "<|start_header_id|>user<|end_header_id|>\n\n{text}<|eot_id|>"
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
    """Callable like ARDY's encoder: ``encoder(texts) -> (embeddings [B, 1, D], lengths)``."""

    def __init__(self, base_dir, llm_dim: int = 4096, dtype=torch.bfloat16,
                 device=None, offload: bool = True, pooling_mode: str = "mean", max_length: int = 512):
        from transformers import AutoTokenizer, LlamaModel

        self.llm_dim = int(llm_dim)
        self.offload = bool(offload)
        self.pooling_mode = pooling_mode
        self.max_length = int(max_length)
        self.tokenizer = AutoTokenizer.from_pretrained(str(base_dir), local_files_only=True)
        self.tokenizer.pad_token = self.tokenizer.eos_token
        self.tokenizer.padding_side = "left"
        from transformers import LlamaConfig
        from .convrot import assign_state, compact_embedding, load_state

        config = LlamaConfig.from_pretrained(str(base_dir), local_files_only=True)
        config._attn_implementation = "sdpa"
        with torch.device("meta"):
            model = LlamaModel(config).to(dtype=dtype)
        # RoPE buffers are nonpersistent and therefore absent from the checkpoint.
        model.rotary_emb = type(model.rotary_emb)(config=config)
        compact_embedding(model)
        assign_state(model, load_state(Path(base_dir) / "model.safetensors"))
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
            # Motion autocast must not change the unchanged encoder's arithmetic.
            with torch.autocast(self._device.type, enabled=False):
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
