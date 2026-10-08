"""Declarative LoRA requirements: families state their own LoRAs instead of hand-writing apply_loras."""

from unittest import mock

import pytest

from helpers.unicanvas_package import load_unicanvas_package

load_unicanvas_package("nodes")

from nodes.unicanvas import loras
from nodes.unicanvas.loras import LoraRequirement, _apply_lora_requirements, _apply_lora_stack
from nodes.unicanvas.models.registry import _get_unicanvas_model_module


@pytest.fixture()
def applied(monkeypatch):
    calls = []

    def fake_apply(model, clip, name, strength, clip_strength=None):
        calls.append((name, strength, clip_strength))
        return model, clip

    monkeypatch.setattr(loras, "_apply_lora_cached", fake_apply)
    monkeypatch.setattr(loras, "_get_lora_full_path", lambda name: f"/loras/{name.lower()}")
    return calls


# --- LoraRequirement semantics -------------------------------------------------------


def test_requirement_reads_name_and_strength_from_settings():
    rule = LoraRequirement(name_setting="lora", strength_setting="lora_strength")
    assert rule.resolve({"lora": "a.safetensors", "lora_strength": 0.4}) == ("a.safetensors", 0.4)


def test_requirement_falls_back_to_default_name_and_skips_without_one():
    assert LoraRequirement(name_setting="lora", default_name="d.safetensors").resolve({}) == ("d.safetensors", 1.0)
    assert LoraRequirement(name_setting="lora").resolve({}) is None


def test_requirement_honours_enabled_switch_and_canonical_match():
    rule = LoraRequirement(name_setting="lora", enabled_setting="turbo", match="dir/turbo.safetensors")
    assert rule.resolve({"lora": "dir/turbo.safetensors"}) is None
    assert rule.resolve({"lora": "other.safetensors", "turbo": True}) is None
    assert rule.resolve({"lora": "dir\\turbo.safetensors", "turbo": True}) == ("dir\\turbo.safetensors", 1.0)


def test_requirement_skips_zero_and_non_positive_strength():
    assert LoraRequirement(name_setting="lora", strength_setting="s").resolve({"lora": "a", "s": 0}) is None
    rule = LoraRequirement(name_setting="lora", strength_setting="s", default_strength=0.0, require_positive_strength=True)
    assert rule.resolve({"lora": "a"}) is None
    assert rule.resolve({"lora": "a", "s": -0.5}) is None
    assert rule.resolve({"lora": "a", "s": ""}) is None


def test_requirement_fixed_strength_ignores_the_setting():
    rule = LoraRequirement(name_setting="lora", strength_setting="s", fixed_strength=1.0)
    assert rule.resolve({"lora": "a", "s": 0.2}) == ("a", 1.0)


def test_requirement_limited_to_draw_modes():
    rule = LoraRequirement(name_setting="lora", draw_modes=frozenset({"inpaint"}))
    assert rule.resolve({"lora": "a", "draw_mode": "img2img"}) is None
    assert rule.resolve({"lora": "a", "draw_mode": "inpaint"}) == ("a", 1.0)


def test_requirement_resolver_runs_only_for_matching_names():
    resolver = mock.Mock(return_value="downloaded/turbo.safetensors")
    rule = LoraRequirement(name_setting="lora", resolver=resolver, resolve_match="turbo.safetensors")
    assert rule.resolve({"lora": "style.safetensors"}) == ("style.safetensors", 1.0)
    resolver.assert_not_called()
    assert rule.resolve({"lora": "x/turbo.safetensors"}) == ("downloaded/turbo.safetensors", 1.0)


def test_requirement_describe_is_json_safe():
    rule = LoraRequirement(name_setting="lora", required=True, draw_modes=frozenset({"inpaint", "img2img"}))
    described = rule.describe()
    assert described["required"] is True
    assert described["draw_modes"] == ["img2img", "inpaint"]
    assert "resolver" not in described


def test_requirements_apply_before_the_stack_and_dedupe(applied):
    rules = (LoraRequirement(name_setting="edit", fixed_strength=1.0, clip_strength=0.0),)
    model, clip, skip = _apply_lora_requirements("m", "c", rules, {"edit": "Edit.safetensors"})
    _apply_lora_stack(model, clip, [
        {"name": "edit.safetensors", "strength": 0.3},
        {"name": "style.safetensors", "strength": 0.7, "clip_strength": 0.5},
        "not-a-dict",
    ], skip)
    assert applied == [("Edit.safetensors", 1.0, 0.0), ("style.safetensors", 0.7, 0.5)]


# --- Built-in families declare their LoRAs --------------------------------------------


def _family_loras(mode, settings):
    module = _get_unicanvas_model_module(mode)
    module.apply_loras("model", "clip", settings)


def test_sdxl_turbo_lora_only_with_turbo_switch_and_canonical_file(applied):
    from nodes.unicanvas.models.sdxl import SDXL_TURBO_LORA_NAME

    _family_loras("sdxl", {"dmd_lora_name": SDXL_TURBO_LORA_NAME, "turbo_enabled": False})
    _family_loras("sdxl", {"dmd_lora_name": "other.safetensors", "turbo_enabled": True})
    assert applied == []
    _family_loras("sdxl", {"dmd_lora_name": SDXL_TURBO_LORA_NAME, "turbo_enabled": True, "dmd_lora_strength": 0.8})
    assert applied == [(SDXL_TURBO_LORA_NAME, 0.8, None)]


def test_anima_turbo_lora_keeps_clip_untouched(applied):
    from nodes.unicanvas.models.anima import ANIMA_TURBO_LORA_NAME

    _family_loras("anima", {"dmd_lora_name": ANIMA_TURBO_LORA_NAME, "turbo_enabled": True})
    assert applied == [(ANIMA_TURBO_LORA_NAME, 1.0, 0.0)]


def test_qwen21_lora_resolves_the_turbo_download(applied, monkeypatch):
    from nodes.unicanvas.models import qwen_image21

    monkeypatch.setattr(qwen_image21, "resolve_qwen21_turbo_lora", lambda: "viggle/resolved.safetensors")
    _family_loras("qwen_image21", {"qwen_lora_name": "any.safetensors", "qwen_lora_strength": 0.5})
    _family_loras("qwen_image21", {"qwen_lora_name": qwen_image21.QWEN21_TURBO_LORA_NAME, "qwen_lora_strength": 1.0})
    assert applied == [("any.safetensors", 0.5, 0.0), ("viggle/resolved.safetensors", 1.0, 0.0)]


def test_krea2_edit_lora_is_required_fixed_and_deduped(applied):
    from nodes.unicanvas.models.krea2_edit import KREA2_EDIT_DEFAULTS

    name = KREA2_EDIT_DEFAULTS["krea2_edit_lora_name"]
    module = _get_unicanvas_model_module("krea2_edit")
    assert any(rule.required for rule in module.lora_requirements)
    module.apply_loras("m", "c", {"lora_stack": [{"name": name, "strength": 0.2}, {"name": "s.safetensors", "strength": 0.7}]})
    assert applied == [(name, 1.0, 0.0), ("s.safetensors", 0.7, None)]


def test_families_without_own_loras_apply_only_the_stack(applied):
    for mode in ("flux_klein", "z_image"):
        applied.clear()
        _family_loras(mode, {"lora_stack": [{"name": "s.safetensors", "strength": 0.5}], "turbo_enabled": True})
        assert applied == [("s.safetensors", 0.5, None)], mode


def test_no_family_overrides_apply_loras():
    """LoRA behaviour is declared (lora_requirements), never re-implemented per family."""
    from nodes.unicanvas.models import UNICANVAS_MODEL_MODULES
    from nodes.unicanvas.models.base import UniCanvasModelModule

    for module in {m.key: m for m in UNICANVAS_MODEL_MODULES.values()}.values():
        assert type(module).apply_loras is UniCanvasModelModule.apply_loras, module.key


def test_a_lora_is_never_applied_twice(applied, monkeypatch):
    aliases = {"viggle/Turbo.safetensors": "/loras/viggle/turbo.safetensors",
               "viggle/turbo.safetensors": "/loras/viggle/turbo.safetensors",
               "turbo.safetensors": "/loras/viggle/turbo.safetensors",
               "Turbo.safetensors": "/loras/viggle/turbo.safetensors",
               "loras/turbo.safetensors": "/loras/viggle/turbo.safetensors"}
    monkeypatch.setattr(loras, "_get_lora_full_path", lambda name: aliases.get(name, f"/loras/{name}"))
    rules = (LoraRequirement(name_setting="turbo"), LoraRequirement(name_setting="again"))
    # The linked config stack already carries the turbo file: the family rule skips it.
    settings = {
        "turbo": "viggle/Turbo.safetensors",
        "again": "turbo.safetensors",
        "_external": {"lora_stack": [{"name": "loras/turbo.safetensors", "strength": 1.0, "enabled": True}]},
    }
    model, clip, skip = _apply_lora_requirements("m", "c", rules, settings)
    assert applied == []
    # Disabled or zero-strength config entries do not count as applied.
    settings["_external"]["lora_stack"][0]["enabled"] = False
    _apply_lora_requirements("m", "c", rules, settings)
    assert applied == [("viggle/Turbo.safetensors", 1.0, None)]
    applied.clear()
    # The user stack drops its own duplicates and files a rule already applied.
    _apply_lora_stack("m", "c", [
        {"name": "style.safetensors", "strength": 0.0},
        {"name": "style.safetensors", "strength": 0.6},
        {"name": "sub/style.safetensors", "strength": 0.9},
        {"name": "Turbo.safetensors", "strength": 1.0},
    ], ["viggle/turbo.safetensors"])
    assert applied == [("style.safetensors", 0.0, None), ("style.safetensors", 0.6, None),
                       ("sub/style.safetensors", 0.9, None)]


def test_vncss_config_applies_each_lora_once(monkeypatch):
    from nodes import vncss_config

    calls = []
    monkeypatch.setattr(vncss_config, "_apply_lora_cached", lambda m, c, name, strength, clip_strength=None: calls.append(name) or (m, c))
    stack = vncss_config.normalize_lora_stack([
        {"name": "a.safetensors", "enabled": False},
        {"name": "A.safetensors"},
        {"name": "dir/a.safetensors"},
        {"name": "b.safetensors"},
    ])
    vncss_config.apply_lora_stack("m", "c", stack)
    assert calls == ["A.safetensors", "dir/a.safetensors", "b.safetensors"]


def test_different_lora_files_with_same_basename_both_apply(applied, monkeypatch):
    monkeypatch.setattr(loras, "_get_lora_full_path", lambda name: f"/loras/{name}")
    _apply_lora_stack("m", "c", [{"name": "portraits/adapter.safetensors"},
                                  {"name": "styles/adapter.safetensors"},
                                  {"name": "portraits/adapter.safetensors"}])
    assert [name for name, *_ in applied] == ["portraits/adapter.safetensors", "styles/adapter.safetensors"]


def test_loaded_lora_weights_are_not_retained_by_a_global_cache(monkeypatch):
    import weakref
    import comfy.sd
    import comfy.utils

    class Weights:
        pass

    references = []

    def load(path, safe_load):
        weights = Weights()
        references.append(weakref.ref(weights))
        return weights

    monkeypatch.setattr(loras, "_get_lora_full_path", lambda name: f"/loras/{name}")
    monkeypatch.setattr(comfy.utils, "load_torch_file", load)
    monkeypatch.setattr(comfy.sd, "load_lora_for_models", lambda model, clip, weights, *args: (model, clip))
    for name in ("a", "b", "a"):
        assert loras._apply_lora_cached("m", "c", name, 1) == ("m", "c")
    assert len(references) == 3
    assert all(reference() is None for reference in references)


def test_lora_identity_resolves_installed_files_and_default_aliases(tmp_path, monkeypatch):
    import folder_paths

    for name in ("portraits/adapter.safetensors", "styles/adapter.safetensors"):
        file = tmp_path / name
        file.parent.mkdir()
        file.touch()
    monkeypatch.setattr(folder_paths, "get_full_path", lambda kind, name: str(tmp_path / name)
                        if (tmp_path / name).is_file() else None)
    monkeypatch.setattr(folder_paths, "get_filename_list", lambda kind: ["portraits/adapter.safetensors", "styles/adapter.safetensors"])
    assert not loras._lora_name_in("styles/adapter.safetensors", ["portraits/adapter.safetensors"])
    assert loras._lora_name_in("adapter.safetensors", ["portraits/adapter.safetensors"])
