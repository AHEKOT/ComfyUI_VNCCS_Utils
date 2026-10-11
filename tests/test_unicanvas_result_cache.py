"""Bound queued result retention without importing model/runtime dependencies."""

import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("draw_result_cache_test", Path(__file__).resolve().parents[1] / "nodes/unicanvas/progress.py")
progress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress)


@pytest.fixture(autouse=True)
def empty_cache():
    progress._DRAW_RESULTS.clear()
    yield
    progress._DRAW_RESULTS.clear()


def test_oldest_results_are_evicted_by_count(monkeypatch):
    monkeypatch.setattr(progress, "_DRAW_RESULTS_MAX", 2)
    for draw_id in ("old", "middle", "new"):
        progress._store_draw_result(draw_id, {"images": [{"filename": f"{draw_id}.png"}], "mask": None})
    assert progress._get_draw_result("old") == {"present": False}
    assert progress._get_draw_result("middle")["present"]
    assert progress._get_draw_result("new") == {"present": True, "images": [{"filename": "new.png"}], "mask": None}


def test_images_and_mask_both_count_toward_byte_limit(monkeypatch):
    result = {"images": ["image" * 10], "mask": "mask" * 10}
    progress._store_draw_result("first", result)
    size = progress._DRAW_RESULTS["first"]["size_bytes"]
    monkeypatch.setattr(progress, "_DRAW_RESULTS_MAX_BYTES", size * 2)
    progress._store_draw_result("second", result)
    progress._store_draw_result("third", result)
    assert list(progress._DRAW_RESULTS) == ["second", "third"]
    assert sum(item["size_bytes"] for item in progress._DRAW_RESULTS.values()) <= size * 2
    monkeypatch.setattr(progress, "_DRAW_RESULTS_MAX_BYTES", size - 1)
    progress._store_draw_result("oversized", result)
    assert not progress._DRAW_RESULTS


def test_replacing_an_id_makes_it_newest_and_does_not_double_count(monkeypatch):
    monkeypatch.setattr(progress, "_DRAW_RESULTS_MAX", 2)
    for draw_id in ("first", "second", "first", "third"):
        progress._store_draw_result(draw_id, {"images": [draw_id]})
    assert list(progress._DRAW_RESULTS) == ["first", "third"]
    assert progress._get_draw_result("first")["images"] == ["first"]


def test_polling_is_repeatable_and_ttl_still_expires_results(monkeypatch):
    monkeypatch.setattr(progress.time, "time", lambda: 100)
    progress._store_draw_result("fresh", {"images": ["image"], "mask": "mask"})
    assert progress._get_draw_result("fresh") == progress._get_draw_result("fresh")
    assert progress._get_draw_result("fresh")["present"]
    monkeypatch.setattr(progress.time, "time", lambda: 101 + progress._DRAW_RESULTS_TTL_SECONDS)
    assert progress._get_draw_result("fresh") == {"present": False}
