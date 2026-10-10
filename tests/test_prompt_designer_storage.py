import asyncio
import json
import multiprocessing
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from helpers.backend_package import service_package


@pytest.fixture
def storage(tmp_path, monkeypatch):
    load = service_package("vnccs_prompt_storage_test")
    module = load("nodes.prompt_designer_storage")
    monkeypatch.setattr(module, "storage_path", lambda: tmp_path / "PromptLibrary")
    return module


def document(text="{~red|blue}\n", name="Color"):
    return {"version": 1, "blocks": [{"id": "color", "name": name, "text": text}],
            "parts": [{"blockId": "color"}, {"text": "\nlast"}], "seed": ""}


def _process_writer(root, text, ready, results):
    storage = service_package("vnccs_json_storage_process_test")("nodes.prompt_designer_storage")
    storage.storage_path = lambda: Path(root)
    results.put("ready")
    if not ready.wait(15):
        raise RuntimeError("Writers did not become ready")
    try:
        results.put(storage.save_document("b" * 32, document(text), 0))
    except storage.RevisionConflict:
        results.put("conflict")


def test_documents_cards_and_history_survive_reopening(storage):
    identifier = "a" * 32
    first, second = document(), document("green\n\n")
    assert storage.load_document(identifier) == {"revision": 0, "state": None}
    assert storage.save_document(identifier, first, 0) == {"revision": 1}
    assert storage.save_document(identifier, second, 1) == {"revision": 2}
    assert storage.load_document(identifier) == {"revision": 2, "state": second}
    assert storage.list_cards()["cards"] == second["blocks"]
    assert {json.loads(path.read_text())["blocks"][0]["text"] for path in (storage.storage_path() / "history").rglob("*.json")} == {first["blocks"][0]["text"], second["blocks"][0]["text"]}
    backup = storage._document_path(identifier).with_suffix(".backup.json")
    assert json.loads(backup.read_text())["revision"] == 2
    assert json.loads(storage._document_path(identifier).read_text())["state"] == second


def test_prompt_tabs_preserve_inactive_drafts_conditions_and_template_details_on_disk(storage):
    state = document()
    state["promptTabs"] = [
        {"id": "c" * 32, "parts": state["parts"], "seed": "", "afterGenerate": "randomize", "details": {}, "dirty": True},
        {"id": "d" * 32, "parts": [{"text": "inactive draft"}, {"condition": {"blockId": "color", "operator": "equals",
            "value": "red", "then": {"parts": [{"text": "warm "}, {"blockId": "color"}]}, "else": {"text": "cool"}}}],
            "seed": "unfinished", "afterGenerate": "fixed", "cycleIndex": 2,
            "details": {"id": "e" * 32, "revision": 3, "name": "My scene", "category": "Scenes", "color": "#44bb99"}, "dirty": True},
    ]
    state["activePrompt"] = "c" * 32
    storage.save_document("a" * 32, state, 0)
    assert storage.load_document("a" * 32)["state"] == state
    assert storage.list_prompts()["prompts"] == [], "open drafts are not independent saved templates"
    for invalid in [[], [state["promptTabs"][0]] * 2,
            [{**state["promptTabs"][0], "parts": [{"blockId": "missing"}]}],
            [{**state["promptTabs"][0], "details": {"id": "bad", "revision": 1}}]]:
        with pytest.raises(ValueError):
            storage.save_document("a" * 32, {**state, "promptTabs": invalid}, 1)
        assert storage.load_document("a" * 32)["state"] == state


def test_named_prompts_are_independent_json_snapshots_with_metadata_search_and_backup_recovery(storage):
    identifier, workspace = "a" * 32, "b" * 32
    state = document()
    state["savedPrompt"] = {"name": "Quiet scene", "category": "Scenes", "color": "#44bb99"}
    state["parts"].append({"condition": {"blockId": "color", "operator": "equals", "value": "red",
                                      "then": {"text": "warm"}, "else": {"blockId": "color"}}})
    state["parts"].append({"multiPrompt": {"variants": [[{"blockId": "color"}], [{"text": "second"}]]}})
    storage.save_document(identifier, state, 0)
    storage.save_document(workspace, document("changed workspace"), 0)
    result = storage.list_prompts("QUIET")
    assert result["total"] == 1
    assert result["prompts"][0] == {"id": identifier, "revision": 1, **state["savedPrompt"], "text": "\nlast"}
    assert storage.list_prompts("missing")["prompts"] == []
    assert storage.load_document(identifier)["state"] == state
    storage._document_path(identifier).unlink()
    assert storage.list_prompts()["prompts"] == result["prompts"]
    assert storage.load_document(identifier)["state"] == state
    state["savedPrompt"].update(name="Renamed scene", color="#eeaa77")
    storage.save_document(identifier, state, 1)
    assert storage.list_prompts()["prompts"][0]["revision"] == 2
    assert storage.load_document(workspace)["state"] == document("changed workspace")
    removed = {key: value for key, value in state.items() if key != "savedPrompt"}
    storage.save_document(identifier, removed, 2)
    assert storage.list_prompts()["prompts"] == []
    storage._document_path(identifier).unlink()
    assert storage.load_document(identifier)["state"] == removed
    assert storage.list_prompts()["prompts"] == []
    assert storage.list_cards()["total"] == 2


@pytest.mark.parametrize("metadata", [None, {}, {"name": "", "category": ""},
    {"name": "A", "category": [], "color": "#aabbcc"}, {"name": "A", "category": "", "color": "red"},
    {"name": "A", "category": "", "extra": True}])
def test_invalid_saved_prompt_metadata_cannot_change_an_existing_document(storage, metadata):
    identifier = "a" * 32
    original = document()
    storage.save_document(identifier, original, 0)
    with pytest.raises(ValueError, match="saved prompt"):
        storage.save_document(identifier, {**original, "savedPrompt": metadata}, 1)
    assert storage.load_document(identifier)["state"] == original


def test_successful_history_is_bounded_without_removing_old_or_failed_drafts(storage, monkeypatch):
    identifier = "a" * 32
    storage.save_document(identifier, document("original"), 0)
    history = storage.storage_path() / "history"
    legacy = history / "existing-archive.json"
    legacy.write_bytes(b"existing retained bytes")
    replace = storage.os.replace
    def interrupt(source, target):
        if target == storage._document_path(identifier):
            raise OSError("interrupted write")
        return replace(source, target)
    with monkeypatch.context() as patch:
        patch.setattr(storage.os, "replace", interrupt)
        with pytest.raises(OSError, match="interrupted write"):
            storage.save_document(identifier, document("failed draft"), 1)
    failed = next(path for path in history.glob("*.json") if path != legacy)
    failed_bytes = failed.read_bytes()
    for revision in range(1, storage._HISTORY_LIMIT + 6):
        storage.save_document(identifier, document(f"successful {revision}"), revision)
    assert len(list((history / identifier).glob("*.json"))) == storage._HISTORY_LIMIT
    assert failed.read_bytes() == failed_bytes
    assert legacy.read_bytes() == b"existing retained bytes"
    assert storage.load_document(identifier)["state"] == document(f"successful {storage._HISTORY_LIMIT + 5}")
    assert json.loads(storage._document_path(identifier).with_suffix(".backup.json").read_text())["state"] == storage.load_document(identifier)["state"]


def test_conflicting_writers_keep_both_snapshots_without_overwriting(storage):
    identifier = "b" * 32
    def save(text):
        try:
            return storage.save_document(identifier, document(text), 0)
        except storage.RevisionConflict:
            return "conflict"
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(save, ["first", "second"]))
    assert results.count("conflict") == 1
    assert {"revision": 1} in results
    assert len(list((storage.storage_path() / "history").rglob("*.json"))) == 2
    current = storage.load_document(identifier)
    assert current["state"]["blocks"][0]["text"] in {"first", "second"}
    assert storage.save_document(identifier, current["state"], 0) == {"revision": 1}


def test_separate_server_processes_preserve_both_json_drafts(storage):
    context = multiprocessing.get_context("spawn")
    ready, results = context.Event(), context.Queue()
    writers = [context.Process(target=_process_writer, args=(str(storage.storage_path()), text, ready, results)) for text in ["first", "second"]]
    try:
        for writer in writers:
            writer.start()
        assert [results.get(timeout=15), results.get(timeout=15)] == ["ready", "ready"]
        ready.set()
        outcomes = [results.get(timeout=15), results.get(timeout=15)]
        assert outcomes.count("conflict") == 1
        assert {"revision": 1} in outcomes
        for writer in writers:
            writer.join(timeout=15)
            assert writer.exitcode == 0
        drafts = [json.loads(path.read_text()) for path in (storage.storage_path() / "history").rglob("*.json")]
        assert {draft["blocks"][0]["text"] for draft in drafts} == {"first", "second"}
        assert storage.load_document("b" * 32)["revision"] == 1
    finally:
        for writer in writers:
            if writer.is_alive():
                writer.terminate()
                writer.join(timeout=5)
        results.close()


def test_multi_prompt_text_and_references_survive_disk_save_and_backup_recovery(storage):
    identifier = "a" * 32
    saved = document()
    saved["parts"] = [{"text": "shared\n"}, {"multiPrompt": {"variants": [
        [{"text": "first "}, {"blockId": "color"}], [{"text": "second\n\n"}, {"blockId": "color"}]]}}, {"text": "\nend"}]
    storage.save_document(identifier, saved, 0)
    storage._document_path(identifier).write_bytes(b"damaged current JSON")
    assert storage.load_document(identifier) == {"revision": 1, "state": saved}


def test_card_preferences_survive_backup_recovery_and_library_deduplication(storage):
    first, second = document(), document()
    first["blocks"][0].update(mode="cycle", color="#ff8fa3")
    second["blocks"][0].update(mode="random", color="#b8a9e8")
    storage.save_document("a" * 32, first, 0)
    storage.save_document("b" * 32, second, 0)
    assert storage.list_cards()["total"] == 2
    storage._document_path("a" * 32).write_bytes(b"damaged JSON")
    assert storage.load_document("a" * 32)["state"] == first
    assert storage.load_document("b" * 32)["state"] == second
    assert {json.dumps(card, sort_keys=True) for card in storage.list_cards()["cards"]} == {
        json.dumps(first["blocks"][0], sort_keys=True), json.dumps(second["blocks"][0], sort_keys=True)}


@pytest.mark.parametrize("damage", ["invalid", "empty", "missing"])
def test_validated_backup_recovers_latest_state_and_retains_damaged_original(storage, damage):
    identifier = "c" * 32
    saved = document("authored text\n\n")
    storage.save_document(identifier, saved, 0)
    path = storage._document_path(identifier)
    if damage == "missing":
        path.unlink()
    else:
        path.write_bytes(b"" if damage == "empty" else b"damaged JSON")
    assert storage.load_document(identifier) == {"revision": 1, "state": saved}
    if damage != "missing":
        damaged = list(path.parent.glob(f"{identifier}.corrupt.*.json"))
        assert len(damaged) == 1 and damaged[0].read_bytes() == (b"" if damage == "empty" else b"damaged JSON")


def test_bad_json_and_bad_backup_are_not_reset(storage):
    identifier = "d" * 32
    storage.save_document(identifier, document(), 0)
    path = storage._document_path(identifier)
    backup = path.with_suffix(".backup.json")
    path.write_bytes(b"bad current")
    backup.write_bytes(b"bad backup")
    with pytest.raises(storage.StorageError):
        storage.save_document(identifier, document("new"), 1)
    assert path.read_bytes() == b"bad current"
    assert backup.read_bytes() == b"bad backup"


@pytest.mark.parametrize("replacement", ["not JSON", json.dumps(document("valid JSON but damaged content"))])
def test_document_checksums_recover_semantic_damage_before_it_can_overwrite_backup(storage, replacement):
    identifier = "a" * 32
    original = document("saved original")
    storage.save_document(identifier, original, 0)
    path = storage._document_path(identifier)
    if replacement == "not JSON":
        path.write_text(replacement)
    else:
        record = json.loads(path.read_text())
        record["state"] = json.loads(replacement)
        path.write_text(json.dumps(record))
    assert storage.load_document(identifier) == {"revision": 1, "state": original}
    assert len(list(path.parent.glob(f"{identifier}.corrupt.*.json"))) == 1


def test_backup_write_failure_keeps_current_state(storage, monkeypatch):
    identifier = "e" * 32
    original = document("original")
    storage.save_document(identifier, original, 0)
    def fail(path, record):
        raise OSError("disk full")
    monkeypatch.setattr(storage, "_backup", fail)
    with pytest.raises(OSError, match="disk full"):
        storage.save_document(identifier, document("replacement"), 1)
    assert storage.load_document(identifier) == {"revision": 1, "state": original}


def test_interrupted_atomic_replace_retains_current_json_and_the_pending_draft(storage, monkeypatch):
    identifier = "a" * 32
    old, changed = document("saved old text"), document("new pending text")
    storage.save_document(identifier, old, 0)
    path = storage._document_path(identifier)
    original = path.read_bytes()
    replace = storage.os.replace
    def interrupt(source, target):
        if target == path:
            raise OSError("interrupted write")
        return replace(source, target)
    monkeypatch.setattr(storage.os, "replace", interrupt)
    with pytest.raises(OSError, match="interrupted write"):
        storage.save_document(identifier, changed, 1)
    assert path.read_bytes() == original
    assert storage.load_document(identifier) == {"revision": 1, "state": old}
    assert {json.loads(item.read_text())["blocks"][0]["text"] for item in (storage.storage_path() / "history").rglob("*.json")} == {"saved old text", "new pending text"}
    assert not list(storage.storage_path().rglob("*.tmp"))


def test_backup_failure_after_commit_keeps_new_json_and_retry_is_idempotent(storage, monkeypatch):
    identifier = "a" * 32
    old, changed = document("old"), document("new")
    storage.save_document(identifier, old, 0)
    backup = storage._backup
    def fail_after_commit(path, record):
        if record and record["revision"] == 2:
            raise OSError("backup full")
        return backup(path, record)
    monkeypatch.setattr(storage, "_backup", fail_after_commit)
    with pytest.raises(OSError, match="backup full"):
        storage.save_document(identifier, changed, 1)
    assert storage.load_document(identifier) == {"revision": 2, "state": changed}
    monkeypatch.setattr(storage, "_backup", backup)
    assert storage.save_document(identifier, changed, 1) == {"revision": 2}
    assert json.loads(storage._document_path(identifier).with_suffix(".backup.json").read_text())["state"] == changed


def test_missing_document_is_restored_in_card_listing_and_corrupt_archives_are_ignored(storage):
    identifier = "a" * 32
    saved = document("recoverable card")
    storage.save_document(identifier, saved, 0)
    path = storage._document_path(identifier)
    path.unlink()
    path.with_name(f"{identifier}.corrupt.123.json").write_text("retain these broken bytes")
    assert storage.list_cards()["cards"] == saved["blocks"]
    assert json.loads(path.read_text())["state"] == saved
    assert path.with_name(f"{identifier}.corrupt.123.json").read_text() == "retain these broken bytes"


def test_library_deduplicates_content_without_dropping_conflicting_card_versions(storage):
    for index in range(53):
        storage.save_document(f"{index:032x}", document(f"text {index}", f"Card {index:02}"), 0)
    storage.save_document("f" * 32, document("text 0", "Card 00"), 0)
    assert storage.list_cards()["total"] == 53
    assert len(storage.list_cards()["cards"]) == 50
    assert len(storage.list_cards(offset=50)["cards"]) == 3
    assert storage.list_cards("CARD 01")["cards"][0]["text"] == "text 1"
    storage.save_document("f" * 32, document("other", "Card 00"), 1)
    assert len(storage.list_cards("Card 00")["cards"]) == 2


@pytest.mark.parametrize("identifier", ["../escape", "", "A" * 32, None])
def test_paths_are_never_selected_by_untrusted_names(storage, identifier):
    with pytest.raises(ValueError, match="document ID"):
        storage.load_document(identifier)
    assert not storage.storage_path().exists()


def test_storage_route_limits_conflicts_and_failure_status(storage, monkeypatch):
    load = service_package("vnccs_prompt_storage_test")
    route = load("api.prompt_designer_library")
    identifier = "a" * 32
    async def call(data=None, method="PUT", length=None):
        raw = json.dumps(data).encode()
        async def read(): return raw
        request = SimpleNamespace(method=method, match_info={"document_id": identifier},
                                  headers={"Content-Length": str(len(raw) if length is None else length)}, read=read)
        return await route.document(request)
    payload = {"revision": 0, "state": document()}
    assert asyncio.run(call(payload)).status == 200
    payload["state"] = document("different")
    assert asyncio.run(call(payload)).status == 409
    assert asyncio.run(call(None)).status == 400
    assert asyncio.run(call(payload, length=2**30)).status == 413
    payload["revision"] = True
    assert asyncio.run(call(payload)).status == 400
    assert asyncio.run(call(method="GET")).status == 200
    def fail(identifier): raise OSError("unavailable")
    monkeypatch.setattr(route, "load_document", fail)
    response = asyncio.run(call(method="GET"))
    assert response.status == 500
    assert "not reset" in json.loads(response.body)["error"]


def test_library_path_matches_neighboring_node_libraries(tmp_path, monkeypatch):
    load = service_package("vnccs_prompt_storage_path_test")
    module = load("nodes.prompt_designer_storage")
    monkeypatch.setattr(module, "_EXTENSION_ROOT", str(tmp_path))
    assert module.storage_path() == tmp_path / "PromptLibrary"
    assert module._document_path("a" * 32) == tmp_path / "PromptLibrary" / "user" / ("a" * 32 + ".json")


def test_library_route_validates_queries_and_returns_saved_cards(storage):
    route = service_package("vnccs_prompt_storage_test")("api.prompt_designer_library")
    storage.save_document("a" * 32, document(name="Unique saved card"), 0)
    async def call(query): return await route.library(SimpleNamespace(query=query))
    response = asyncio.run(call({"q": "unique", "offset": "0"}))
    assert response.status == 200
    assert json.loads(response.body)["cards"] == document(name="Unique saved card")["blocks"]
    for query in [{"offset": "not a number"}, {"offset": "-1"}, {"q": "x" * 129}]:
        assert asyncio.run(call(query)).status == 400
