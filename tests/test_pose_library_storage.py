"""Typed assets, failed syncs, and legacy library compatibility."""

import asyncio
import json
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest

from test_pose_library_progress import POSE_LIBRARY as library


def test_failed_preview_install_preserves_previous_file(tmp_path, monkeypatch):
    previous = tmp_path / "Walk.webp"
    previous.write_bytes(b"old preview")
    prepared = tmp_path / "prepared.webp"
    prepared.write_bytes(b"new preview")
    with mock.patch.object(library.os, "replace", side_effect=OSError("disk error")):
        with pytest.raises(OSError, match="disk error"):
            library.install_prepared_preview(str(tmp_path), "Walk", (str(prepared), ".webp"))
    assert previous.read_bytes() == b"old preview"
    older_format = tmp_path / "Walk.png"
    older_format.write_bytes(b"older preview")
    library.install_prepared_preview(str(tmp_path), "Walk", (str(prepared), ".webp"))
    assert previous.read_bytes() == b"new preview"
    assert not older_format.exists()


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


def test_rename_to_existing_pose_preserves_both_assets(store):
    directory = store / "artist__poses" / "poses" / "Standing"
    directory.mkdir(parents=True)
    for name in ("A", "B"):
        (directory / f"{name}.json").write_text(json.dumps({"pose": name}))
        (directory / f"{name}.png").write_bytes(name.encode())
    before = {path.name: path.read_bytes() for path in directory.iterdir()}
    result = asyncio.run(library.save_pose(request(name="B", old_name="A", pose={"pose": "edited"})))
    assert result.status == 409
    assert {path.name: path.read_bytes() for path in directory.iterdir()} == before


def test_same_pose_can_be_updated_and_renamed_to_free_name(store):
    directory = store / "artist__poses" / "poses" / "Standing"
    directory.mkdir(parents=True)
    (directory / "A.json").write_text('{"pose": "old"}')
    (directory / "A.png").write_bytes(b"preview")
    assert asyncio.run(library.save_pose(request(name="A", pose={"pose": "updated"}))).status == 200
    assert json.loads((directory / "A.json").read_text())["pose"] == "updated"
    assert asyncio.run(library.save_pose(request(name="B", old_name="A", pose={"pose": "renamed"}))).status == 200
    assert not (directory / "A.json").exists()
    assert (directory / "B.png").read_bytes() == b"preview"


def test_rename_rechecks_collision_after_async_preview_preparation(store, monkeypatch):
    directory = store / "artist__poses" / "poses" / "Standing"
    directory.mkdir(parents=True)
    (directory / "A.json").write_text('{"pose": "original"}')
    prepared = directory / "prepared.webp"

    def prepare(*args):
        (directory / "B.json").write_text('{"pose": "concurrent save"}')
        prepared.write_bytes(b"preview")
        return str(prepared), ".webp"

    monkeypatch.setattr(library, "prepare_preview_file", prepare)
    result = asyncio.run(library.save_pose(request(name="B", old_name="A", pose={"pose": "edited"}, preview="image")))
    assert result.status == 409
    assert json.loads((directory / "A.json").read_text()) == {"pose": "original"}
    assert json.loads((directory / "B.json").read_text()) == {"pose": "concurrent save"}
    assert not prepared.exists()


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


@pytest.mark.parametrize("failed_file", ["Walk.webp", "Walk.json"])
def test_failed_save_restores_the_previous_pose_and_preview(store, monkeypatch, failed_file):
    directory = store / "artist__poses" / "poses" / "Standing"
    directory.mkdir(parents=True)
    (directory / "Walk.json").write_text('{"pose": "old"}')
    (directory / "Walk.webp").write_bytes(b"old preview")
    (directory / "Walk.png").write_bytes(b"older format")
    before = {path.name: path.read_bytes() for path in directory.iterdir()}
    prepared = directory / "prepared.webp"

    def prepare(*args):
        prepared.write_bytes(b"new preview")
        return str(prepared), ".webp"

    replace = library.os.replace

    def fail_install(source, target):
        if Path(target).name == failed_file and not Path(source).name.startswith("vnccs_preview_backup_"):
            raise OSError("disk error")
        return replace(source, target)

    monkeypatch.setattr(library, "prepare_preview_file", prepare)
    monkeypatch.setattr(library.os, "replace", fail_install)
    result = asyncio.run(library.save_pose(request(pose={"pose": "new"}, preview="image")))
    assert result.status == 400
    assert {path.name: path.read_bytes() for path in directory.iterdir()} == before


@pytest.mark.parametrize("with_new_preview", [False, True])
def test_failed_rename_keeps_source_and_removes_uncommitted_destination(store, monkeypatch, with_new_preview):
    directory = store / "artist__poses" / "poses" / "Standing"
    directory.mkdir(parents=True)
    (directory / "A.json").write_text('{"pose": "old"}')
    (directory / "A.webp").write_bytes(b"old preview")
    before = {path.name: path.read_bytes() for path in directory.iterdir()}
    prepared = directory / "prepared.webp"

    def prepare(*args):
        prepared.write_bytes(b"new preview")
        return str(prepared), ".webp"

    replace = library.os.replace

    def fail_commit(source, target):
        if Path(target).name == "B.json":
            raise OSError("disk error")
        return replace(source, target)

    monkeypatch.setattr(library, "prepare_preview_file", prepare)
    monkeypatch.setattr(library.os, "replace", fail_commit)
    result = asyncio.run(library.save_pose(request(name="B", old_name="A", pose={"pose": "new"},
                                                   preview="image" if with_new_preview else None)))
    assert result.status == 400
    assert {path.name: path.read_bytes() for path in directory.iterdir()} == before


def test_successful_preview_update_retires_old_formats_only_after_commit(store, monkeypatch):
    directory = store / "artist__poses" / "poses" / "Standing"
    directory.mkdir(parents=True)
    (directory / "Walk.json").write_text('{"pose": "old"}')
    (directory / "Walk.png").write_bytes(b"old preview")
    prepared = directory / "prepared.webp"
    prepared.write_bytes(b"new preview")
    monkeypatch.setattr(library, "prepare_preview_file", lambda *args: (str(prepared), ".webp"))
    result = asyncio.run(library.save_pose(request(pose={"pose": "new"}, preview="image")))
    assert result.status == 200
    assert json.loads((directory / "Walk.json").read_text())["pose"] == "new"
    assert (directory / "Walk.webp").read_bytes() == b"new preview"
    assert sorted(path.name for path in directory.iterdir()) == ["Walk.json", "Walk.webp"]
