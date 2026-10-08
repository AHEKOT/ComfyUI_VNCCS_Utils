"""Typed assets, failed syncs, and legacy library compatibility."""

import asyncio
import json
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest

from test_pose_library_progress import POSE_LIBRARY as library


@pytest.fixture
def store(tmp_path, monkeypatch):
    root = tmp_path / "library"
    root.mkdir()
    monkeypatch.setattr(library, "get_library_path", lambda: str(root))
    monkeypatch.setattr(library, "load_pose_repositories", lambda: [{"repo_id": "artist/poses", "enabled": True}])
    monkeypatch.setattr(library, "web", SimpleNamespace(
        json_response=lambda data, status=200: SimpleNamespace(data=data, status=status),
        Response=lambda **kwargs: SimpleNamespace(**kwargs),
    ))
    return root


def request(name="Walk", asset_type="pose", repository="artist/poses", **body):
    return SimpleNamespace(
        match_info={"name": name},
        query={"repository": repository, "category": "Standing", "asset_type": asset_type},
        headers={}, can_read_body=False,
        json=mock.AsyncMock(return_value={"name": name, "asset_type": asset_type, "repository": repository, "category": "Standing", **body}),
    )


def test_same_name_pose_and_animation_keep_separate_files_previews_and_ids(store, tmp_path, monkeypatch):
    legacy = store / "artist__poses" / "Standing" / "Walk.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text('{"animation": {"frames": [0]}}')
    legacy.with_suffix(".png").write_bytes(b"legacy preview")
    entries = [
        {"name": "Walk", "json_path": "poses/Standing/Walk.json", "preview_path": "previews/Standing/Walk.png"},
        {"name": "Walk", "json_path": "animations/Standing/Walk.json", "preview_path": "animation_previews/Standing/Walk.png"},
    ]
    contents = {
        entries[0]["json_path"]: b'{"pose": "still"}', entries[0]["preview_path"]: b"pose preview",
        entries[1]["json_path"]: b'{"animation": {"frames": [1, 2]}}', entries[1]["preview_path"]: b"animation preview",
    }

    def download(_repo, path, **_kwargs):
        target = tmp_path / "download"
        target.write_bytes(contents[path])
        return str(target)

    monkeypatch.setattr(library, "download_hf_file", download)
    result = library.sync_pose_repository_files({"repo_id": "artist/poses"}, {"poses": entries}, False)
    assert result["downloaded_count"] == 2
    assert result["errors"] == []
    assert result["removed_count"] == 2
    assert not legacy.exists()
    repeated = library.sync_pose_repository_files({"repo_id": "artist/poses"}, {"poses": entries}, False)
    assert repeated["downloaded_count"] == 0
    assert repeated["skipped_count"] == 2
    records = asyncio.run(library.list_poses(request())).data["poses"]
    assert {r["id"] for r in records} == {"artist__poses/poses/Standing/Walk", "artist__poses/animations/Standing/Walk"}
    for kind in ("pose", "animation"):
        loaded = asyncio.run(library.get_pose(request(asset_type=kind)))
        assert loaded.data["asset_type"] == kind
        preview = asyncio.run(library.get_preview(request(asset_type=kind)))
        assert preview.body == f"{kind} preview".encode()
    untyped = request()
    untyped.query.pop("asset_type")
    assert asyncio.run(library.get_pose(untyped)).status == 400
    assert asyncio.run(library.delete_pose(untyped)).status == 400
    assert asyncio.run(library.delete_pose(request(asset_type="animation"))).data["success"]
    assert asyncio.run(library.get_pose(request())).data["pose"] == {"pose": "still"}
    assert len(library.scan_poses()) == 1


@pytest.mark.parametrize("manifest", [
    {}, {"poses": None}, {"poses": "invalid"}, {"poses": [None]},
    {"poses": [{}]}, {"poses": [{"json_path": "poses/A.json", "name": []}]},
    {"poses": [{"json_path": "../Walk.json"}]},
    {"poses": [{"json_path": "poses/Standing/Walk.json"}, {"json_path": "poses/Standing/Walk.json"}]},
    {"poses": [{"name": "Walk!", "json_path": "poses/Standing/One.json"}, {"name": "Walk", "json_path": "poses/Standing/Two.json"}]},
    {"poses": [{"json_path": "poses/Standing/Walk.json", "json_sha256": "invalid"}]},
])
def test_invalid_manifest_cannot_download_or_clean_existing_files(store, monkeypatch, manifest):
    target = store / "artist__poses" / "Standing" / "Existing.json"
    target.parent.mkdir(parents=True)
    target.write_text('{"saved": true}')
    download = mock.Mock()
    monkeypatch.setattr(library, "download_hf_file", download)
    with pytest.raises(ValueError):
        library.sync_pose_repository_files({"repo_id": "artist/poses"}, manifest, False)
    download.assert_not_called()
    assert target.read_text() == '{"saved": true}'


def test_valid_empty_manifest_can_remove_stale_cache(store):
    target = store / "artist__poses" / "Standing" / "Existing.json"
    target.parent.mkdir(parents=True)
    target.write_text("{}")
    result = library.sync_pose_repository_files({"repo_id": "artist/poses"}, {"poses": []}, False)
    assert result["removed_count"] == 1


def test_failed_download_retains_the_entire_previous_cache(store, monkeypatch):
    target = store / "artist__poses" / "Standing" / "Existing.json"
    target.parent.mkdir(parents=True)
    target.write_text("{}")
    monkeypatch.setattr(library, "download_hf_file", mock.Mock(side_effect=OSError("offline")))
    result = library.sync_pose_repository_files({"repo_id": "artist/poses"}, {"poses": [{"json_path": "poses/Standing/Walk.json"}]}, False)
    assert result["errors"] == ["poses/Standing/Walk.json: offline"]
    assert result["removed_count"] == 0
    assert target.exists()


def test_copy_failure_preserves_old_file_and_removes_partial_stage(store, tmp_path, monkeypatch):
    source = tmp_path / "source.json"
    source.write_text('{"new": true}')
    target = store / "saved.json"
    target.write_text('{"old": true}')

    def fail_copy(_source, destination):
        Path(destination).write_bytes(b"partial")
        raise OSError("disk full")

    monkeypatch.setattr(library.shutil, "copy2", fail_copy)
    with pytest.raises(OSError, match="disk full"):
        library.copy_if_changed(str(source), str(target))
    assert target.read_text() == '{"old": true}'
    assert list(store.iterdir()) == [target]


def test_saving_legacy_asset_migrates_only_its_type_and_keeps_preview(store):
    repository = library.LOCAL_USER_REPOSITORY
    legacy = store / repository / "Standing" / "Walk.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text('{"pose": "old"}')
    legacy.with_suffix(".png").write_bytes(b"old preview")
    animation = asyncio.run(library.save_pose(request(asset_type="animation", repository=repository, pose={"animation": {"frames": []}})))
    assert animation.status == 200
    saved = asyncio.run(library.save_pose(request(repository=repository, pose={"pose": "new"})))
    assert saved.status == 200
    assert not legacy.exists()
    assert (store / saved.data["path"]).with_suffix(".png").read_bytes() == b"old preview"
    assert asyncio.run(library.get_pose(request(asset_type="animation", repository=repository))).data["pose"]["animation"] == {"frames": []}
    assert {p["asset_type"] for p in library.collect_local_pose_files()} == {"pose", "animation"}


@pytest.mark.parametrize("full", [False, True])
def test_large_animation_listing_reads_and_serializes_off_the_event_loop(store, monkeypatch, full):
    path = store / "artist__poses" / "animations" / "Standing" / "Walk.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"animation": {"frames": list(range(10000))}}))
    original = library.read_pose_json
    original_response = library.web.json_response
    threads, serialization_threads = [], []

    def read(path):
        threads.append(threading.get_ident())
        return original(path)

    monkeypatch.setattr(library, "read_pose_json", read)

    def response(*args, **kwargs):
        serialization_threads.append(threading.get_ident())
        return original_response(*args, **kwargs)

    monkeypatch.setattr(library.web, "json_response", response)
    event_loop_thread = threading.get_ident()
    query = request()
    query.query["full"] = "true" if full else "false"
    response = asyncio.run(library.list_poses(query))
    assert response.data["poses"][0]["asset_type"] == "animation"
    assert bool(response.data["poses"][0]["data"]) == full
    assert threads and all(t != event_loop_thread for t in threads)
    assert serialization_threads and all(t != event_loop_thread for t in serialization_threads)


def test_refresh_reports_asset_failure_as_error(store, tmp_path, monkeypatch):
    import sys
    import types

    hub = types.ModuleType("huggingface_hub")
    hub.HfApi = lambda: SimpleNamespace(repo_info=lambda **kwargs: SimpleNamespace(sha="revision"))
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"poses": [{"json_path": "poses/Standing/Walk.json"}]}')
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    monkeypatch.setattr(library, "download_hf_file_with_progress", lambda **kwargs: str(manifest))
    monkeypatch.setattr(library, "download_hf_file", mock.Mock(side_effect=OSError("offline")))
    result = library.refresh_pose_repository({"repo_id": "artist/poses"}, task_id="failed-assets")
    assert result["status"] == "error"
    assert "offline" in result["last_error"]
    assert result["errors"] == ["poses/Standing/Walk.json: offline"]
    assert library.get_repository_progress("failed-assets")["status"] == "error"


def test_background_refresh_does_not_turn_a_sync_error_into_success(store, monkeypatch):
    failure = {"repo_id": "artist/poses", "status": "error", "last_error": "offline"}
    monkeypatch.setattr(library, "refresh_pose_repository", lambda *args, **kwargs: failure)
    monkeypatch.setattr(library, "persist_refreshed_repositories", mock.Mock())
    library.run_background_enabled_repository_refresh("failed-background")
    progress = library.get_repository_progress("failed-background")
    assert progress["status"] == "error"
    assert "artist/poses: offline" in progress["message"]
