"""Performance options: tiled VAE proxy, EasyCache gating and the progress summary."""

from __future__ import annotations

from nodes.unicanvas import performance


class _Vae:
    def __init__(self):
        self.calls = []

    def decode(self, samples):
        self.calls.append("decode")
        return "full"

    def decode_tiled(self, samples):
        self.calls.append("decode_tiled")
        return "tiled"

    def encode(self, pixels):
        self.calls.append("encode")
        return "full"

    def encode_tiled(self, pixels):
        self.calls.append("encode_tiled")
        return "tiled"


def test_vae_chunking_is_off_by_default_and_tiles_when_on():
    vae = _Vae()
    assert performance.apply_vae_chunking(vae, {}) is vae
    chunked = performance.apply_vae_chunking(vae, {"vae_chunking": True})
    assert chunked.decode("s") == "tiled" and chunked.encode("p") == "tiled"
    assert vae.calls == ["decode_tiled", "encode_tiled"]
    assert performance.apply_vae_chunking(chunked, {"vae_chunking": True}) is chunked


def test_step_cache_is_on_by_default_for_long_runs_only(monkeypatch):
    calls = []
    monkeypatch.setattr(performance, "_call_comfy_node", lambda name, **kw: calls.append((name, kw)) or ("cached",))
    assert performance.apply_step_cache("model", {}, 20) == "cached"
    assert calls[0][0] == "EasyCache" and calls[0][1]["model"] == "model"
    assert performance.apply_step_cache("model", {}, 6) == "model"
    assert performance.apply_step_cache("model", {"step_cache": False}, 30) == "model"
    assert performance.step_cache_skip_reason({}, 6) == "6 steps"


def test_missing_easycache_node_samples_uncached(monkeypatch):
    def boom(name, **kw):
        raise KeyError(name)

    monkeypatch.setattr(performance, "_call_comfy_node", boom)
    assert performance.apply_step_cache("model", {}, 30) == "model"


def test_performance_label_names_attention_cache_and_vae(monkeypatch):
    monkeypatch.setattr(performance, "attention_backend", lambda: "attention_comfy_kitchen_int8")
    label = performance.performance_label({"vae_chunking": True}, cached=True)
    assert label == "attention comfy_kitchen_int8 · EasyCache on · VAE chunked"
    assert "EasyCache off (6 steps)" in performance.performance_label({}, cached=False, cache_note="6 steps")
