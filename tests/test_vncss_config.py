import json
import pytest

from nodes.vncss_config import VNCCS_Config, apply_lora_stack, normalize_lora_stack


def _state(payload: dict) -> str:
    return json.dumps(payload)


def test_packages_connected_inputs():
    model, clip, vae = object(), object(), object()
    ref = object()
    result = VNCCS_Config().execute(
        _state({"loras": [], "edit_model": True}),
        model=model,
        clip=clip,
        vae=vae,
        reference_image_1=ref,
    )[0]
    assert result["model"] is model
    assert result["clip"] is clip
    assert result["vae"] is vae
    assert result["edit_model"] is True
    assert result["references"] == {"reference_image_1": ref}


def test_missing_model_raises_config_error():
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] Model input is not connected\."):
        VNCCS_Config().execute(_state({"loras": [], "edit_model": False}), clip=object(), vae=object())


def test_missing_clip_and_vae_raise():
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] CLIP input is not connected\."):
        VNCCS_Config().execute(_state({"loras": []}), model=object(), vae=object())
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] VAE input is not connected\."):
        VNCCS_Config().execute(_state({"loras": []}), model=object(), clip=object())


def test_edit_model_requires_reference_1():
    with pytest.raises(RuntimeError, match=r"\[VNCCS Config\] Edit model requires reference_image_1\."):
        VNCCS_Config().execute(
            _state({"loras": [], "edit_model": True}),
            model=object(), clip=object(), vae=object(),
        )


def test_invalid_node_state_falls_back_to_defaults():
    result = VNCCS_Config().execute("not-json", model=object(), clip=object(), vae=object())[0]
    assert result["edit_model"] is False
    assert result["lora_stack"] == []


def test_normalize_lora_stack_filters_and_defaults():
    stack = normalize_lora_stack([
        {"name": "a.safetensors", "strength": 0.5, "enabled": True},
        {"name": "", "strength": 1.0},
        {"strength": 2.0},
        "junk",
        {"name": "b.safetensors", "strength": "0.8", "enabled": False},
    ])
    assert stack == [
        {"name": "a.safetensors", "strength": 0.5, "enabled": True, "clip_strength": None},
        {"name": "b.safetensors", "strength": 0.8, "enabled": False, "clip_strength": None},
    ]


def test_normalize_lora_stack_parses_clip_strength():
    stack = normalize_lora_stack([
        {"name": "a", "strength": 1.0, "clip_strength": "0.25"},
        {"name": "b", "strength": 1.0, "clip_strength": "junk"},
        {"name": "c", "strength": 1.0},
    ])
    assert [entry["clip_strength"] for entry in stack] == [0.25, None, None]


def test_apply_lora_stack_applies_enabled_in_order(monkeypatch):
    calls = []
    import nodes.vncss_config as vc

    def fake_cached(model, clip, name, strength, clip_strength=None):
        calls.append((name, strength))
        return f"m-{name}", f"c-{name}"

    monkeypatch.setattr(vc, "_apply_lora_cached", fake_cached, raising=False)
    model, clip = apply_lora_stack(
        "m0", "c0",
        [
            {"name": "one", "strength": 0.3, "enabled": True},
            {"name": "off", "strength": 1.0, "enabled": False},
            {"name": "two", "strength": 0.7, "enabled": True},
        ],
    )
    assert calls == [("one", 0.3), ("two", 0.7)]
    assert model == "m-two" and clip == "c-two"


def test_apply_lora_stack_resolves_loras_relative_name(monkeypatch):
    """A name from folder_paths.get_filename_list('loras') must reach the loader as a full path."""
    import comfy.sd
    import comfy.utils
    import nodes.vncss_config as vc

    loaded_paths = []
    lora_calls = []

    def fake_load_torch_file(path, safe_load=True):
        loaded_paths.append(path)
        return {"lora": True}

    def fake_load_lora_for_models(model, clip, lora_sd, strength, clip_strength=1.0):
        lora_calls.append((model, clip, lora_sd, strength, clip_strength))
        return f"m-{strength}", f"c-{clip_strength}"

    monkeypatch.setattr(comfy.utils, "load_torch_file", fake_load_torch_file)
    monkeypatch.setattr(comfy.sd, "load_lora_for_models", fake_load_lora_for_models)

    model, clip = vc.apply_lora_stack(
        "m0", "c0",
        [{"name": "foo.safetensors", "strength": 0.5, "enabled": True}],
    )

    # conftest stubs folder_paths.get_full_path(kind, name) -> "/models/{kind}/{name}".
    assert loaded_paths == ["/models/loras/foo.safetensors"]
    assert lora_calls == [("m0", "c0", {"lora": True}, 0.5, 0.5)]
    assert (model, clip) == ("m-0.5", "c-0.5")


def test_apply_lora_stack_raises_for_unresolvable_name(monkeypatch):
    import folder_paths
    import nodes.vncss_config as vc

    monkeypatch.setattr(folder_paths, "get_full_path", lambda kind, name: None)

    with pytest.raises(RuntimeError) as excinfo:
        vc.apply_lora_stack(
            "m0", "c0",
            [{"name": "bad.safetensors", "strength": 1.0, "enabled": True}],
        )

    assert str(excinfo.value) == "[VNCCS Config] LoRA not found: bad.safetensors"


def test_lora_resolution_normalizes_backslash_separators(monkeypatch):
    import folder_paths
    import nodes.vncss_config as vc

    requested = []

    def fake_get_full_path(kind, name):
        requested.append(name)
        return "/models/loras/subdir/foo.safetensors" if name == "subdir/foo.safetensors" else None

    monkeypatch.setattr(folder_paths, "get_full_path", fake_get_full_path)

    assert vc._resolve_lora_path("subdir\\foo.safetensors") == "/models/loras/subdir/foo.safetensors"
    assert requested == ["subdir\\foo.safetensors", "subdir/foo.safetensors"]


def test_execute_returns_patched_model(monkeypatch):
    import nodes.vncss_config as vc
    monkeypatch.setattr(vc, "_apply_lora_cached",
                        lambda m, c, n, s, cs=None: (f"m-{n}", f"c-{n}"), raising=False)
    result = VNCCS_Config().execute(
        _state({"loras": [{"name": "x", "strength": 0.5, "enabled": True}], "edit_model": False}),
        model="m0", clip="c0", vae="v0",
    )[0]
    assert result["model"] == "m-x"
    assert result["clip"] == "c-x"
    assert result["lora_stack"] == [
        {"name": "x", "strength": 0.5, "enabled": True, "clip_strength": None}
    ]


def test_apply_lora_stack_forwards_clip_strength(monkeypatch):
    import nodes.vncss_config as vc

    calls = []

    def fake_cached(model, clip, name, strength, clip_strength=None):
        calls.append((name, strength, clip_strength))
        return model, clip

    monkeypatch.setattr(vc, "_apply_lora_cached", fake_cached, raising=False)
    apply_lora_stack(
        "m0", "c0",
        [{"name": "one", "strength": 0.5, "enabled": True, "clip_strength": 0.25}],
    )
    assert calls == [("one", 0.5, 0.25)]


def test_execute_collects_reference_image_10():
    """The family limit is 10 reference images (MiniMax H3 / Qwen-Image-2.1)."""
    ref = object()
    result = VNCCS_Config().execute(
        _state({"loras": [], "edit_model": True}),
        model=object(), clip=object(), vae=object(),
        reference_image_1=object(), reference_image_10=ref,
    )[0]
    assert set(result["references"]) == {"reference_image_1", "reference_image_10"}
    assert result["references"]["reference_image_10"] is ref
