import json
import pathlib
import sys
import types

if "__init__" not in sys.modules:
    _shell = types.ModuleType("__init__")
    _shell.__path__ = [str(pathlib.Path(__file__).resolve().parent.parent)]
    sys.modules["__init__"] = _shell

import pytest

from helpers.unicanvas_package import load_unicanvas_package

load_unicanvas_package("nodes")

from nodes.unicanvas import user_prefs


@pytest.fixture()
def prefs(tmp_path, monkeypatch):
    monkeypatch.setattr(sys.modules["folder_paths"], "get_user_directory", lambda: str(tmp_path), raising=False)
    return tmp_path / "vnccs" / user_prefs.FILE_NAME


ENTRY = {"diffusion_model_name": "a.safetensors", "clip_name": "c.safetensors", "at": 5,
         "lora_stack": [{"name": "l.safetensors", "strength": "0.7"}, {"name": "", "strength": 1}], "junk": 1}


def test_round_trip_is_versioned_and_sanitized(prefs):
    document = user_prefs.remember_model_choice("diffusion|anima", ENTRY)
    assert document["schema"] == user_prefs.SCHEMA_VERSION
    stored = json.loads(prefs.read_text(encoding="utf-8"))
    assert stored["entries"]["diffusion|anima"] == {
        "diffusion_model_name": "a.safetensors", "clip_name": "c.safetensors",
        "lora_stack": [{"name": "l.safetensors", "strength": 0.7}], "at": 5,
    }
    assert user_prefs.load_model_memory()["entries"] == stored["entries"]


def test_legacy_unversioned_file_is_migrated(prefs):
    prefs.parent.mkdir(parents=True)
    prefs.write_text(json.dumps({"checkpoint|sdxl": {"ckpt_name": "x.safetensors"}}), encoding="utf-8")
    loaded = user_prefs.load_model_memory()
    assert loaded["schema"] == 1 and loaded["entries"]["checkpoint|sdxl"]["ckpt_name"] == "x.safetensors"


def test_newer_schema_is_read_but_not_downgraded(prefs):
    prefs.parent.mkdir(parents=True)
    raw = json.dumps({"schema": 9, "entries": {"k": {"clip_name": "c", "future_entry": True},
                                             "future_only": {"unknown": [1, 2]}}, "future": True})
    prefs.write_text(raw, encoding="utf-8")
    assert user_prefs.load_model_memory()["future"] is True
    with pytest.raises(ValueError, match="newer version.*original file preserved"):
        user_prefs.remember_model_choice("k2", {"clip_name": "d"})
    assert prefs.read_text(encoding="utf-8") == raw
    assert not prefs.with_suffix(".json.tmp").exists()


def test_corrupt_file_and_bad_input(prefs):
    prefs.parent.mkdir(parents=True)
    prefs.write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError, match="original file preserved"):
        user_prefs.load_model_memory()
    with pytest.raises(ValueError, match="original file preserved"):
        user_prefs.remember_model_choice("valid", ENTRY)
    assert prefs.read_text(encoding="utf-8") == "{not json"
    for key, entry in [("", ENTRY), ("k", {}), ("k", "x"), (None, ENTRY)]:
        with pytest.raises(ValueError):
            user_prefs.remember_model_choice(key, entry)


def test_only_the_newest_entries_are_kept(prefs):
    for index in range(user_prefs.MAX_ENTRIES + 5):
        user_prefs.remember_model_choice(f"k{index}", {"clip_name": "c", "at": index})
    entries = user_prefs.load_model_memory()["entries"]
    assert len(entries) == user_prefs.MAX_ENTRIES and "k0" not in entries and f"k{user_prefs.MAX_ENTRIES + 4}" in entries
