import hashlib
import json
from pathlib import Path
from unittest.mock import Mock

import pytest
from dulwich import porcelain
from dulwich.config import ConfigDict
from dulwich.objects import Blob, Commit, Tree

from test_pose_library_progress import POSE_LIBRARY as library, REPOSITORY_PROGRESS as progress


@pytest.fixture
def source(tmp_path, monkeypatch):
    repository = porcelain.init(tmp_path / "source")
    monkeypatch.setattr(library, "get_library_path", lambda: str(tmp_path / "PoseLibrary"))
    monkeypatch.setattr(library, "load_pose_repositories", lambda: [])
    yield repository
    repository.close()


def commit_files(repository, files):
    for name, data in files.items():
        target = Path(repository.path) / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    porcelain.add(repository, list(files))
    return porcelain.commit(repository, message=b"Test library", author=b"Test <test@example.com>", committer=b"Test <test@example.com>")


def route_clone_to_fixture(monkeypatch, source):
    clone = porcelain.clone
    calls = []

    def local_clone(url, target, **kwargs):
        assert url == "https://huggingface.co/artist/poses"
        assert kwargs["depth"] == 1
        assert kwargs["bare"] and kwargs["checkout"] is False
        assert isinstance(kwargs["config"], ConfigDict)
        assert list(kwargs["config"].sections()) == [(b"http",)]
        assert list(kwargs["config"].items((b"http",))) == [(b"timeout", b"60")]
        assert kwargs["env"] == {}
        calls.append(target)
        return clone(source, target, **kwargs)

    monkeypatch.setattr(porcelain, "clone", local_clone)
    return calls


def test_260_files_use_one_git_clone_and_no_individual_downloads(source, monkeypatch):
    files, entries = {}, []
    for index in range(130):
        path = f"poses/Standing/Pose{index}.json"
        preview = f"previews/Standing/Pose{index}.png"
        files[path], files[preview] = json.dumps({"index": index}).encode(), f"preview {index}".encode()
        entries.append({"json_path": path, "preview_path": preview,
                        "json_sha256": hashlib.sha256(files[path]).hexdigest(),
                        "preview_sha256": hashlib.sha256(files[preview]).hexdigest()})
    files["pose_library.json"] = json.dumps({"poses": entries}).encode()
    head = commit_files(source, files)
    calls = route_clone_to_fixture(monkeypatch, source)
    download = Mock(side_effect=AssertionError("per-file HTTP regression"))
    monkeypatch.setattr(library, "download_hf_file", download)
    result = library.refresh_pose_repository({"repo_id": "artist/poses"}, task_id="packed-clone")
    assert result["status"] == "ok", result
    assert result["transport"] == "git"
    assert result["sha"] == head.decode()
    assert result["downloaded_count"] == 130 and result["errors"] == []
    assert len(calls) == 1 and not Path(calls[0]).exists()
    assert len(list((Path(library.get_library_path()) / "artist__poses").rglob("*.*"))) == 260
    assert progress.get_repository_progress("packed-clone")["status"] == "success"
    repeated = library.refresh_pose_repository({"repo_id": "artist/poses"})
    assert repeated["downloaded_count"] == 0 and repeated["skipped_count"] == 130
    download.assert_not_called()


def test_only_lfs_assets_use_http_pinned_to_the_cloned_commit(source, monkeypatch, tmp_path):
    preview = b"resolved preview"
    digest = hashlib.sha256(preview).hexdigest()
    pointer = f"version https://git-lfs.github.com/spec/v1\noid sha256:{digest}\nsize {len(preview)}\n".encode()
    files = {"poses/Wave.json": b'{"bones": {}}', "previews/Wave.png": pointer,
             "pose_library.json": json.dumps({"poses": [{"json_path": "poses/Wave.json", "preview_path": "previews/Wave.png", "preview_sha256": digest}]}).encode()}
    head = commit_files(source, files)
    route_clone_to_fixture(monkeypatch, source)
    temporary = tmp_path / "resolved.png"
    temporary.write_bytes(preview)
    download = Mock(return_value=str(temporary))
    monkeypatch.setattr(library, "download_hf_file", download)
    result = library.refresh_pose_repository({"repo_id": "artist/poses"})
    assert result["status"] == "ok", result
    assert result["transport"] == "git+lfs"
    download.assert_called_once_with("artist/poses", "previews/Wave.png", revision=head.decode())
    assert not temporary.exists()


def test_clone_failure_preserves_cache_and_does_not_silently_download_files(source, monkeypatch):
    existing = Path(library.get_library_path()) / "artist__poses" / "poses" / "Standing" / "Saved.json"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b'{"saved": true}')
    monkeypatch.setattr(porcelain, "clone", Mock(side_effect=OSError("connection lost")))
    download = Mock(side_effect=AssertionError("silent fallback"))
    monkeypatch.setattr(library, "download_hf_file", download)
    result = library.refresh_pose_repository({"repo_id": "artist/poses"}, task_id="clone-error")
    assert result["status"] == "error" and "connection lost" in result["last_error"]
    assert existing.read_bytes() == b'{"saved": true}'
    assert progress.get_repository_progress("clone-error")["status"] == "error"
    download.assert_not_called()


@pytest.mark.parametrize("path", ["../secret.json", "/secret.json", "a/../secret.json", "a\\..\\secret.json"])
def test_git_reader_rejects_unsafe_paths(source, path):
    with pytest.raises(ValueError, match="Unsafe repository path"):
        library.read_git_repository_file(source, path)


def test_git_reader_rejects_symlinks_and_oversize_files(source, monkeypatch):
    blob = Blob.from_string(b"outside.json")
    tree = Tree()
    tree.add(b"link.json", 0o120000, blob.id)
    tree.add(b"large.json", 0o100644, blob.id)
    commit = Commit()
    commit.tree = tree.id
    commit.author = commit.committer = b"Test <test@example.com>"
    commit.author_time = commit.commit_time = 1
    commit.author_timezone = commit.commit_timezone = 0
    commit.message = b"Test modes"
    for obj in (blob, tree, commit):
        source.object_store.add_object(obj)
    source.refs[b"HEAD"] = commit.id
    with pytest.raises(ValueError, match="not a regular file"):
        library.read_git_repository_file(source, "link.json")
    monkeypatch.setattr(library, "MAX_POSE_REPOSITORY_FILE_BYTES", 2)
    with pytest.raises(ValueError, match="size limit"):
        library.read_git_repository_file(source, "large.json")
