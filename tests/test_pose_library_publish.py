import asyncio
import hashlib
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from test_pose_library_progress import POSE_LIBRARY as library, POSE_API as routes, REPOSITORY_PROGRESS as progress


@pytest.fixture
def publishing(tmp_path, monkeypatch):
    root = tmp_path / "PoseLibrary"
    target = root / library.LOCAL_USER_REPOSITORY / "poses" / "Standing" / "Wave.json"
    target.parent.mkdir(parents=True)
    target.write_text('{"bones": {}, "prompt": "waving"}')
    target.with_suffix(".png").write_bytes(b"preview pixels")
    animation = root / library.LOCAL_USER_REPOSITORY / "animations" / "Standing" / "Walk.json"
    animation.parent.mkdir(parents=True)
    animation.write_text('{"animation": {"frames": []}}')
    config = tmp_path / "user.json"
    config.write_text('{"unrelated": {"keep": true}, "pose_library_publish_repo_id": "owner/old"}')
    monkeypatch.setattr(library, "get_library_path", lambda: str(root))
    monkeypatch.setattr(library, "get_vnccs_user_config", lambda: json.loads(config.read_text()))
    api = SimpleNamespace(create_repo=Mock(), repo_info=Mock(return_value=SimpleNamespace(sha="head")), create_commit=Mock())
    hub = ModuleType("huggingface_hub")
    hub.HfApi = Mock(return_value=api)
    hub.CommitOperationAdd = SimpleNamespace
    utils = ModuleType("huggingface_hub.utils")
    utils.validate_repo_id = Mock()
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    monkeypatch.setitem(sys.modules, "huggingface_hub.utils", utils)
    monkeypatch.setattr(routes, "web", SimpleNamespace(json_response=lambda data, status=200: SimpleNamespace(data=data, status=status)))
    return SimpleNamespace(root=root, target=target, config=config, api=api, hub=hub)


@pytest.mark.parametrize("create", [False, True])
def test_publish_commits_a_consistent_catalog_and_remembers_only_the_target(publishing, create):
    p = publishing
    uploaded = {}
    snapshot_paths = []
    original = p.target.read_bytes()
    def commit(**kwargs):
        assert kwargs["token"] == "write-secret"
        assert kwargs["parent_commit"] == "head"
        p.target.write_text('{"prompt": "changed while uploading"}')
        for operation in kwargs["operations"]:
            value = operation.path_or_fileobj
            uploaded[operation.path_in_repo] = value if isinstance(value, bytes) else Path(value).read_bytes()
            if isinstance(value, str):
                snapshot_paths.append(value)
    p.api.create_commit.side_effect = commit
    result = library.publish_local_repository_to_hf("owner/new", token="write-secret", create=create, private=True, task_id="publish-success")
    p.hub.HfApi.assert_called_once_with(endpoint="https://huggingface.co", token="write-secret")
    if create:
        p.api.create_repo.assert_called_once_with(repo_id="owner/new", repo_type="model", private=True, exist_ok=False, token="write-secret")
    else:
        p.api.create_repo.assert_not_called()
    assert set(uploaded) == {"poses/Standing/Wave.json", "previews/Standing/Wave.png", "animations/Standing/Walk.json", "pose_library.json"}
    assert uploaded["poses/Standing/Wave.json"] == original
    manifest = json.loads(uploaded["pose_library.json"])
    assert len(manifest["poses"]) == 2
    for entry in manifest["poses"]:
        assert hashlib.sha256(uploaded[entry["json_path"]]).hexdigest() == entry["json_sha256"]
    assert result["pose_count"] == result["animation_count"] == 1
    assert result["deleted_count"] == 0
    assert json.loads(p.config.read_text()) == {"unrelated": {"keep": True}, "pose_library_publish_repo_id": "owner/old"}
    settings = Path(library.get_user_repositories_path())
    saved = json.loads(settings.read_text())
    assert saved["local_repository"]["publish_repo_id"] == "owner/new"
    assert saved["local_repository"]["last_publish_result"] == result
    assert "write-secret" not in settings.read_text()
    assert all(not Path(path).exists() for path in snapshot_paths)
    assert progress.get_repository_progress("publish-success")["status"] == "success"


def test_publish_filters_unrelated_json_and_downloads_the_result(publishing, tmp_path, monkeypatch):
    p = publishing
    legacy_dir = p.root / library.LOCAL_USER_REPOSITORY / "Standing"
    legacy_dir.mkdir()
    legacy_assets = {
        "Legacy": b'{"bonePositions": {"hip": [0, 0, 0]}, "custom": "keep"}',
        "Set": b'{"type": "pose_set", "poses": [{"bones": {}}]}',
        "Scene": b'{"type": "scene_pose", "characters": [{"poses": [{"bones": {}}]}]}',
    }
    for name, data in legacy_assets.items():
        (legacy_dir / f"{name}.json").write_bytes(data)
    saved, status = library.save_pose({"name": "Saved", "category": "Standing", "pose": {"prompt": "keep"}})
    assert status == 200
    saved_bytes = (p.root / saved["path"]).read_bytes()

    unrelated = p.target.with_name("settings.json")
    unrelated.write_bytes(b'{"sample_setting": "private"}')
    unrelated.with_suffix(".png").write_bytes(b"unrelated preview")
    remote = {}

    def commit(**kwargs):
        for operation in kwargs["operations"]:
            source = operation.path_or_fileobj
            remote[operation.path_in_repo] = source if isinstance(source, bytes) else Path(source).read_bytes()

    p.api.create_commit.side_effect = commit
    result = library.publish_local_repository_to_hf("owner/new", token="write-secret", task_id="publish-filtered")
    assert result["ignored_json_count"] == 1
    assert "Ignored 1 JSON" in progress.get_repository_progress("publish-filtered")["message"]
    assert unrelated.read_bytes() == b'{"sample_setting": "private"}'
    assert unrelated.with_suffix(".png").read_bytes() == b"unrelated preview"
    manifest = json.loads(remote.pop("pose_library.json"))
    expected = {
        **{f"poses/Standing/{name}.json": data for name, data in legacy_assets.items()},
        "poses/Standing/Saved.json": saved_bytes,
        "poses/Standing/Wave.json": p.target.read_bytes(),
        "previews/Standing/Wave.png": p.target.with_suffix(".png").read_bytes(),
        "animations/Standing/Walk.json": b'{"animation": {"frames": []}}',
    }
    assert remote == expected

    def download(_repo_id, path, **_kwargs):
        staged = tmp_path / "download"
        staged.write_bytes(remote[path])
        return str(staged)

    monkeypatch.setattr(library, "download_hf_file", download)
    synced = library.sync_pose_repository_files({"repo_id": "owner/new"}, manifest, False)
    assert synced["errors"] == []
    assert synced["downloaded_count"] == result["asset_count"] == 6
    downloaded = p.root / "owner__new"
    for path, data in expected.items():
        local_path = path.replace("previews/", "poses/", 1) if path.startswith("previews/") else path
        assert (downloaded / local_path).read_bytes() == data


@pytest.mark.parametrize("failure", ["create", "upload", "corrupt pose", "empty library", "oversize"])
def test_failed_publish_keeps_the_previous_link_and_redacts_credentials(publishing, monkeypatch, failure):
    p = publishing
    before = p.config.read_bytes()
    if failure == "create":
        p.api.create_repo.side_effect = RuntimeError("already exists write-secret")
    elif failure == "upload":
        p.api.create_commit.side_effect = RuntimeError("offline write-secret")
    elif failure == "corrupt pose":
        p.target.write_text("broken JSON")
    elif failure == "empty library":
        for path in p.root.rglob("*.json"):
            path.unlink()
    else:
        monkeypatch.setattr(library, "MAX_POSE_REPOSITORY_SYNC_BYTES", 1)
    library.load_local_repository_settings()
    settings = Path(library.get_user_repositories_path())
    saved = settings.read_bytes()
    with pytest.raises(RuntimeError) as error:
        library.publish_local_repository_to_hf("owner/new", token="write-secret", create=True, task_id="publish-failure")
    assert "write-secret" not in str(error.value)
    assert "write-secret" not in progress.get_repository_progress("publish-failure")["message"]
    assert p.config.read_bytes() == before
    assert settings.read_bytes() == saved
    if failure != "upload":
        p.api.create_commit.assert_not_called()


def test_corrupt_config_is_retained_and_reported_after_remote_commit(publishing):
    p = publishing
    settings = Path(library.get_user_repositories_path())
    settings.write_text("broken JSON")
    with pytest.raises(RuntimeError, match="published, but its target could not be saved"):
        library.publish_local_repository_to_hf("owner/new", token="write-secret")
    assert settings.read_text() == "broken JSON"
    p.api.create_commit.assert_called_once()


@pytest.mark.parametrize("repo_id", ["owner/poses", "another-user/custom-library"])
def test_published_link_survives_shared_config_reset_and_fresh_backend(publishing, monkeypatch, repo_id):
    from helpers.backend_package import service_package

    library.save_user_repositories([{"repo_id": "community/catalog", "enabled": True}])
    result = library.publish_local_repository_to_hf(repo_id, token="write-secret")
    original = library.get_local_repository_info()
    publishing.config.write_text('{}')
    fresh = service_package("restarted_publish_test")("nodes.posestudio.library")
    monkeypatch.setattr(fresh, "get_library_path", lambda: str(publishing.root))
    monkeypatch.setattr(fresh, "get_vnccs_user_config", lambda: {})
    restored = fresh.get_local_repository_info()
    assert restored["publish_repo_id"] == repo_id
    assert restored["last_publish"] == original["last_publish"]
    assert restored["last_publish_result"] == result
    assert [repo["repo_id"] for repo in fresh.load_user_repositories()] == ["community/catalog"]
    fresh.save_user_repositories([{"repo_id": "different/catalog", "enabled": False}])
    assert fresh.get_local_repository_info() == restored
    fresh.save_user_repositories([])
    assert fresh.get_local_repository_info() == restored


def test_legacy_publish_link_migrates_once_without_linking_download_catalogs(publishing):
    history = {"uploaded_count": 7}
    publishing.config.write_text(json.dumps({"pose_library_publish_repo_id": "previous/published",
        "pose_library_last_publish": 1234, "pose_library_last_publish_result": history, "unrelated": "keep"}))
    library.save_user_repositories([{"repo_id": "community/download-only", "enabled": True}])
    info = library.get_local_repository_info()
    assert (info["publish_repo_id"], info["last_publish"], info["last_publish_result"]) == ("previous/published", 1234, history)
    publishing.config.write_text('{"pose_library_publish_repo_id": "stale/target"}')
    assert library.get_local_repository_info() == info
    settings = json.loads(Path(library.get_user_repositories_path()).read_text())
    assert settings["repositories"][0]["repo_id"] == "community/download-only"
    assert "unrelated" not in settings


def test_added_catalog_does_not_become_a_publish_target(publishing):
    publishing.config.write_text('{}')
    library.save_user_repositories([{"repo_id": "community/download-only", "enabled": True}])
    assert library.get_local_repository_info()["publish_repo_id"] == ""


def test_corrupt_publish_settings_are_reported_instead_of_not_linked(publishing):
    settings = Path(library.get_user_repositories_path())
    settings.write_text('{"repositories": [], "local_repository": []}')
    response = asyncio.run(routes.list_pose_repositories(None))
    assert response.status == 500
    assert "local repository settings must be an object" in response.data["error"]
    assert settings.read_text() == '{"repositories": [], "local_repository": []}'


@pytest.mark.parametrize("payload", [[], {}, {"repo_id": "owner/new"}, {"repo_id": "owner/new", "token": True},
                                     {"repo_id": "owner/new", "token": "write-secret", "create": "false"}])
def test_publish_request_validation_never_uses_a_saved_target_or_implicit_credentials(publishing, payload):
    request = SimpleNamespace(headers={}, can_read_body=False, json=AsyncMock(return_value=payload))
    response = asyncio.run(routes.publish_local_pose_repository(request))
    assert response.status == 400
    publishing.hub.HfApi.assert_not_called()


def test_publish_route_returns_updated_link_and_rejects_oversize_requests(publishing):
    request = SimpleNamespace(headers={}, can_read_body=False, json=AsyncMock(return_value={
        "repo_id": "https://huggingface.co/owner/new/tree/main", "token": "write-secret", "create": False,
    }))
    response = asyncio.run(routes.publish_local_pose_repository(request))
    assert response.status == 200
    assert response.data["local_repository"]["publish_repo_id"] == "owner/new"
    assert "write-secret" not in json.dumps(response.data)
    request.headers = {"Content-Length": "16385"}
    request.json.reset_mock()
    assert asyncio.run(routes.publish_local_pose_repository(request)).status == 413
    request.json.assert_not_called()
