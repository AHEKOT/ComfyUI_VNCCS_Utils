import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def _load_pose_library():
    aiohttp_module = types.ModuleType("aiohttp")
    aiohttp_module.web = types.SimpleNamespace()
    previous = sys.modules.get("aiohttp")
    sys.modules["aiohttp"] = aiohttp_module
    try:
        spec = importlib.util.spec_from_file_location("vnccs_pose_library_progress_test", ROOT / "api" / "pose_library.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if previous is None:
            sys.modules.pop("aiohttp", None)
        else:
            sys.modules["aiohttp"] = previous


POSE_LIBRARY = _load_pose_library()


class PoseLibraryProgressTests(unittest.TestCase):
    def test_progress_registry_is_bounded(self):
        POSE_LIBRARY._REPOSITORY_PROGRESS.clear()
        now = 10_000.0
        for index in range(POSE_LIBRARY._REPOSITORY_PROGRESS_MAX + 20):
            POSE_LIBRARY._REPOSITORY_PROGRESS[str(index)] = {
                "status": "running",
                "updated_at": now + index,
            }

        POSE_LIBRARY._prune_repository_progress(now + POSE_LIBRARY._REPOSITORY_PROGRESS_MAX + 20)

        self.assertEqual(len(POSE_LIBRARY._REPOSITORY_PROGRESS), POSE_LIBRARY._REPOSITORY_PROGRESS_MAX)

    def test_completed_progress_expires(self):
        POSE_LIBRARY._REPOSITORY_PROGRESS.clear()
        POSE_LIBRARY._REPOSITORY_PROGRESS["finished"] = {
            "status": "success",
            "updated_at": 1.0,
        }

        POSE_LIBRARY._prune_repository_progress(1.0 + POSE_LIBRARY._REPOSITORY_PROGRESS_TTL_SECONDS + 1)

        self.assertNotIn("finished", POSE_LIBRARY._REPOSITORY_PROGRESS)

    def test_generated_manifest_uses_repository_specific_title(self):
        manifest = POSE_LIBRARY.build_pose_manifest(
            "Totemistyk/General_Poses_PoseStudio",
            {"title": "VNCCS Pose Library", "poses": []},
            [],
            set(),
        )

        self.assertEqual(manifest["title"], "Totemistyk/General_Poses_PoseStudio")

    def test_repository_id_accepts_a_hugging_face_tree_url(self):
        self.assertEqual(
            POSE_LIBRARY.normalize_repo_id(
                "https://huggingface.co/Totemistyk/General_Poses_PoseStudio/tree/main"
            ),
            "Totemistyk/General_Poses_PoseStudio",
        )
        self.assertEqual(
            POSE_LIBRARY.normalize_repo_id("https://example.com/owner/repository"),
            "",
        )

    def test_project_defaults_include_totemistyk_second_and_enabled(self):
        repositories = POSE_LIBRARY.load_default_repositories()

        self.assertEqual(
            [repo["repo_id"] for repo in repositories[:2]],
            [
                "MIUProject/VNCCS_PoseLibrary_Main",
                "Totemistyk/General_Poses_PoseStudio",
            ],
        )
        self.assertTrue(repositories[1]["enabled"])
        self.assertTrue(repositories[1]["builtin"])
        self.assertEqual(repositories[1]["title"], "General Poses PoseStudio")

    def test_git_clone_uses_one_shot_os_temp_without_directory_promotion(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary) / "one-shot-clone"

            def clone_into_checkout(command):
                self.assertEqual(command[-1], str(checkout))
                (checkout / ".git").mkdir(parents=True)
                return ""

            with (
                mock.patch.object(POSE_LIBRARY.shutil, "which", return_value="/usr/bin/git"),
                mock.patch.object(
                    POSE_LIBRARY.tempfile,
                    "mkdtemp",
                    side_effect=lambda **kwargs: (checkout.mkdir(), str(checkout))[1],
                ) as make_temp,
                mock.patch.object(POSE_LIBRARY, "run_pose_repository_git", side_effect=clone_into_checkout),
                mock.patch.object(POSE_LIBRARY.os, "replace") as promote_directory,
            ):
                result = POSE_LIBRARY.update_git_pose_repository_checkout("artist/poses")

            self.assertEqual(result, str(checkout))
            self.assertEqual(make_temp.call_args.kwargs, {"prefix": "vnccs_pose_repository_"})
            promote_directory.assert_not_called()

    def test_generated_manifest_preserves_a_custom_title(self):
        manifest = POSE_LIBRARY.build_pose_manifest(
            "owner/repository",
            {"title": "Portrait Pose Collection", "poses": []},
            [],
            set(),
        )

        self.assertEqual(manifest["title"], "Portrait Pose Collection")

    def test_legacy_generic_titles_are_normalized_while_loading_repositories(self):
        with (
            mock.patch.object(POSE_LIBRARY, "load_default_repositories", return_value=[{
                "repo_id": "official/main",
                "title": "Official Pose Library",
                "builtin": True,
            }]),
            mock.patch.object(POSE_LIBRARY, "load_user_repositories", return_value=[
                {
                    "repo_id": "official/main",
                    "title": "VNCCS Pose Library",
                    "builtin": False,
                },
                {
                    "repo_id": "artist/poses",
                    "title": "VNCCS Pose Library",
                    "builtin": False,
                },
            ]),
        ):
            repositories = {
                item["repo_id"]: item
                for item in POSE_LIBRARY.load_pose_repositories()
            }

        self.assertEqual(repositories["official/main"]["title"], "Official Pose Library")
        self.assertEqual(repositories["artist/poses"]["title"], "artist/poses")

    def test_create_publish_is_exclusive_and_uploads_only_to_requested_target(self):
        calls = {"create": [], "uploads": []}

        class FakeHfApi:
            def __init__(self, token=None):
                self.token = token

            def create_repo(self, **kwargs):
                calls["create"].append(kwargs)

            def list_repo_files(self, **_kwargs):
                return []

            def upload_file(self, **kwargs):
                recorded = dict(kwargs)
                if kwargs.get("path_in_repo", "").endswith(".json"):
                    recorded["uploaded_json"] = json.loads(
                        Path(kwargs["path_or_fileobj"]).read_text(encoding="utf-8")
                    )
                calls["uploads"].append(recorded)

        fake_hub = types.ModuleType("huggingface_hub")
        fake_hub.HfApi = FakeHfApi
        with tempfile.TemporaryDirectory() as temporary:
            pose_path = Path(temporary) / "pose.json"
            saved_pose = {
                "cameraParams": {
                    "offset_x": 2.5,
                    "offset_y": -1.25,
                    "zoom": 1.75,
                    "yaw_deg": 15,
                    "pitch_deg": -5,
                },
                "sam_projection": {
                    "fov": 37.5,
                    "cameraPosition": {"x": -1.25, "y": 12.5, "z": 42},
                },
            }
            pose_path.write_text(json.dumps(saved_pose), encoding="utf-8")
            local_pose = {
                "name": "Standing",
                "category": "General",
                "tags": [],
                "asset_type": "pose",
                "json_path": str(pose_path),
                "preview_path": "",
                "preview_type": "",
                "hub_json_path": "poses/General/Standing.json",
                "hub_preview_path": "",
                "json_sha256": POSE_LIBRARY.sha256_file(pose_path),
                "preview_sha256": "",
            }
            with (
                mock.patch.dict(sys.modules, {"huggingface_hub": fake_hub}),
                mock.patch.object(POSE_LIBRARY, "collect_local_pose_files", return_value=[local_pose]),
                mock.patch.object(POSE_LIBRARY, "load_remote_pose_manifest", return_value={}),
                mock.patch.object(POSE_LIBRARY, "save_vnccs_user_config"),
            ):
                result = POSE_LIBRARY.publish_local_repository_to_hf(
                    "owner/new-library",
                    token="hf_test",
                    create=True,
                    task_id="publish-test",
                )

        self.assertEqual(result["repo_id"], "owner/new-library")
        self.assertEqual(calls["create"], [{
            "repo_id": "owner/new-library",
            "repo_type": "model",
            "private": False,
            "exist_ok": False,
        }])
        self.assertTrue(calls["uploads"])
        self.assertEqual(
            {call["repo_id"] for call in calls["uploads"]},
            {"owner/new-library"},
        )
        pose_upload = next(
            call for call in calls["uploads"]
            if call["path_in_repo"] == "poses/General/Standing.json"
        )
        self.assertEqual(
            pose_upload["uploaded_json"],
            saved_pose,
        )

    def test_publish_endpoint_never_falls_back_to_saved_repository(self):
        class FakeRequest:
            headers = {}
            can_read_body = False

            async def json(self):
                return {"create": True, "hf_token": "hf_test"}

        class FakeResponse:
            def __init__(self, payload, status=200):
                self.payload = payload
                self.status = status

        fake_web = types.SimpleNamespace(
            json_response=lambda payload, status=200: FakeResponse(payload, status),
        )
        with (
            mock.patch.object(POSE_LIBRARY, "web", fake_web),
            mock.patch.object(
                POSE_LIBRARY,
                "get_vnccs_user_config",
                return_value={"pose_library_publish_repo_id": "owner/old-library"},
            ),
            mock.patch.object(POSE_LIBRARY, "publish_local_repository_to_hf") as publish,
        ):
            response = asyncio.run(POSE_LIBRARY.publish_local_pose_repository(FakeRequest()))

        self.assertEqual(response.status, 400)
        self.assertEqual(response.payload["error"], "Repository id is required")
        publish.assert_not_called()

    def test_add_repository_downloads_it_before_responding(self):
        class FakeRequest:
            headers = {}
            can_read_body = False

            async def json(self):
                return {
                    "repo_id": "artist/new-poses",
                    "task_id": "add-and-sync",
                }

        class FakeResponse:
            def __init__(self, payload, status=200):
                self.payload = payload
                self.status = status

        refreshed = {
            "repo_id": "artist/new-poses",
            "title": "artist/new-poses",
            "status": "ok",
            "pose_count": 12,
            "animation_count": 0,
            "downloaded_count": 12,
        }
        fake_web = types.SimpleNamespace(
            json_response=lambda payload, status=200: FakeResponse(payload, status),
        )
        saved = []
        with (
            mock.patch.object(POSE_LIBRARY, "web", fake_web),
            mock.patch.object(POSE_LIBRARY, "load_pose_repositories", side_effect=[[], [refreshed]]),
            mock.patch.object(POSE_LIBRARY, "load_user_repositories", return_value=[]),
            mock.patch.object(POSE_LIBRARY, "save_user_repositories", side_effect=lambda repos: saved.extend(repos)),
            mock.patch.object(POSE_LIBRARY, "refresh_pose_repository", return_value=refreshed) as refresh,
            mock.patch.object(POSE_LIBRARY, "persist_refreshed_repositories") as persist,
        ):
            response = asyncio.run(POSE_LIBRARY.add_pose_repository(FakeRequest()))

        self.assertEqual(response.status, 200)
        self.assertEqual(response.payload["task_id"], "add-and-sync")
        self.assertEqual(response.payload["refreshed"], refreshed)
        self.assertEqual(saved[0]["repo_id"], "artist/new-poses")
        refresh.assert_called_once()
        self.assertEqual(refresh.call_args.args[0]["repo_id"], "artist/new-poses")
        self.assertEqual(refresh.call_args.kwargs["task_id"], "add-and-sync")
        persist.assert_called_once_with([refreshed])

    def test_git_checkout_imports_manifest_assets_without_http_requests(self):
        with tempfile.TemporaryDirectory() as temporary:
            library_root = Path(temporary) / "PoseLibrary"
            checkout = Path(temporary) / "checkout"
            json_source = checkout / "poses" / "General" / "Standing.json"
            preview_source = checkout / "previews" / "General" / "Standing.webp"
            json_source.parent.mkdir(parents=True)
            preview_source.parent.mkdir(parents=True)
            json_source.write_bytes(b'{"pose": true}')
            preview_source.write_bytes(b"RIFF-test-webp")
            manifest = {
                "poses": [{
                    "name": "Standing",
                    "category": "General",
                    "json_path": "poses/General/Standing.json",
                    "preview_path": "previews/General/Standing.webp",
                    "json_sha256": POSE_LIBRARY.sha256_file(json_source),
                    "preview_sha256": POSE_LIBRARY.sha256_file(preview_source),
                }],
            }

            with (
                mock.patch.object(POSE_LIBRARY, "get_library_path", return_value=str(library_root)),
                mock.patch.object(POSE_LIBRARY, "download_hf_file") as http_download,
            ):
                result = POSE_LIBRARY.sync_pose_repository_files(
                    {"repo_id": "artist/poses"},
                    manifest,
                    token=None,
                    source_root=str(checkout),
                )

            target = library_root / "artist__poses" / "General"
            self.assertEqual((target / "Standing.json").read_bytes(), json_source.read_bytes())
            self.assertEqual((target / "Standing.webp").read_bytes(), preview_source.read_bytes())
            self.assertEqual(result["downloaded_count"], 1)
            self.assertEqual(result["errors"], [])
            http_download.assert_not_called()

    def test_git_lfs_pointer_falls_back_before_modifying_the_library(self):
        with tempfile.TemporaryDirectory() as temporary:
            library_root = Path(temporary) / "PoseLibrary"
            checkout = Path(temporary) / "checkout"
            json_source = checkout / "poses" / "General" / "Standing.json"
            json_source.parent.mkdir(parents=True)
            json_source.write_text(
                "version https://git-lfs.github.com/spec/v1\n"
                "oid sha256:0123456789abcdef\n"
                "size 12345\n",
                encoding="utf-8",
            )
            manifest = {
                "poses": [{
                    "name": "Standing",
                    "category": "General",
                    "json_path": "poses/General/Standing.json",
                    "json_sha256": POSE_LIBRARY.sha256_file(json_source),
                }],
            }

            with mock.patch.object(POSE_LIBRARY, "get_library_path", return_value=str(library_root)):
                with self.assertRaises(POSE_LIBRARY.GitRepositorySyncUnavailable):
                    POSE_LIBRARY.sync_pose_repository_files(
                        {"repo_id": "artist/poses"},
                        manifest,
                        token=None,
                        source_root=str(checkout),
                    )

            self.assertFalse((library_root / "artist__poses" / "General" / "Standing.json").exists())

    def test_public_repository_refresh_prefers_shallow_git_checkout(self):
        class FakeHfApi:
            def repo_info(self, **_kwargs):
                return types.SimpleNamespace(sha="git-sha", private=False)

        fake_hub = types.ModuleType("huggingface_hub")
        fake_hub.HfApi = FakeHfApi
        with tempfile.TemporaryDirectory() as temporary:
            library_root = Path(temporary) / "PoseLibrary"
            checkout = Path(temporary) / "checkout"
            pose_source = checkout / "poses" / "General" / "Standing.json"
            pose_source.parent.mkdir(parents=True)
            pose_source.write_bytes(b'{"pose": true}')
            (checkout / "pose_library.json").write_text(
                json.dumps({
                    "title": "VNCCS Pose Library",
                    "poses": [{
                        "name": "Standing",
                        "category": "General",
                        "json_path": "poses/General/Standing.json",
                        "json_sha256": POSE_LIBRARY.sha256_file(pose_source),
                    }],
                }),
                encoding="utf-8",
            )

            with (
                mock.patch.dict(sys.modules, {"huggingface_hub": fake_hub}),
                mock.patch.object(POSE_LIBRARY, "get_library_path", return_value=str(library_root)),
                mock.patch.object(POSE_LIBRARY, "get_hf_token", return_value=None),
                mock.patch.object(
                    POSE_LIBRARY,
                    "update_git_pose_repository_checkout",
                    return_value=str(checkout),
                ) as git_checkout,
                mock.patch.object(POSE_LIBRARY, "download_hf_file_with_progress") as http_manifest,
                mock.patch.object(POSE_LIBRARY, "download_hf_file") as http_asset,
            ):
                result = POSE_LIBRARY.refresh_pose_repository(
                    {"repo_id": "artist/poses", "enabled": True},
                    task_id="git-refresh",
                )

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["transport"], "git")
            self.assertEqual(result["title"], "artist/poses")
            self.assertEqual(result["downloaded_count"], 1)
            git_checkout.assert_called_once_with("artist/poses", task_id="git-refresh")
            http_manifest.assert_not_called()
            http_asset.assert_not_called()
            self.assertFalse(checkout.exists())

    def test_git_failure_automatically_retries_through_http(self):
        class FakeHfApi:
            def repo_info(self, **_kwargs):
                return types.SimpleNamespace(sha="remote-sha", private=False)

        fake_hub = types.ModuleType("huggingface_hub")
        fake_hub.HfApi = FakeHfApi
        with tempfile.TemporaryDirectory() as temporary:
            library_root = Path(temporary) / "PoseLibrary"
            downloaded_pose = Path(temporary) / "downloaded-pose.json"
            downloaded_pose.write_bytes(b'{"pose": true}')
            manifest_download = Path(temporary) / "downloaded-manifest.json"
            manifest_download.write_text(
                json.dumps({
                    "poses": [{
                        "name": "Standing",
                        "category": "General",
                        "json_path": "poses/General/Standing.json",
                        "json_sha256": POSE_LIBRARY.sha256_file(downloaded_pose),
                    }],
                }),
                encoding="utf-8",
            )

            with (
                mock.patch.dict(sys.modules, {"huggingface_hub": fake_hub}),
                mock.patch.object(POSE_LIBRARY, "get_library_path", return_value=str(library_root)),
                mock.patch.object(POSE_LIBRARY, "get_hf_token", return_value=None),
                mock.patch.object(
                    POSE_LIBRARY,
                    "update_git_pose_repository_checkout",
                    side_effect=POSE_LIBRARY.GitRepositorySyncUnavailable("Git is unavailable"),
                ),
                mock.patch.object(
                    POSE_LIBRARY,
                    "download_hf_file_with_progress",
                    return_value=str(manifest_download),
                ) as http_manifest,
                mock.patch.object(
                    POSE_LIBRARY,
                    "download_hf_file",
                    return_value=str(downloaded_pose),
                ) as http_asset,
            ):
                result = POSE_LIBRARY.refresh_pose_repository(
                    {"repo_id": "artist/poses", "enabled": True},
                    task_id="http-fallback",
                )

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["transport"], "http")
            self.assertEqual(result["git_error"], "Git is unavailable")
            self.assertEqual(result["downloaded_count"], 1)
            progress = POSE_LIBRARY.get_repository_progress("http-fallback")
            self.assertEqual(progress["git_error"], "Git is unavailable")
            self.assertEqual(progress["transport"], "http")
            http_manifest.assert_called_once()
            http_asset.assert_called_once()

    def test_failed_clone_removes_its_one_shot_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary) / "failed-clone"
            checkout.mkdir()

            with (
                mock.patch.object(POSE_LIBRARY.shutil, "which", return_value="/usr/bin/git"),
                mock.patch.object(POSE_LIBRARY.tempfile, "mkdtemp", return_value=str(checkout)),
                mock.patch.object(
                    POSE_LIBRARY,
                    "run_pose_repository_git",
                    side_effect=POSE_LIBRARY.GitRepositorySyncUnavailable("clone timeout"),
                ),
            ):
                with self.assertRaises(POSE_LIBRARY.GitRepositorySyncUnavailable):
                    POSE_LIBRARY.update_git_pose_repository_checkout("artist/poses")

            self.assertFalse(checkout.exists())

    def test_pose_library_walker_hides_internal_git_checkout(self):
        with tempfile.TemporaryDirectory() as temporary:
            library_root = Path(temporary)
            visible = library_root / "artist__poses" / "General"
            hidden = library_root / POSE_LIBRARY.POSE_REPOSITORY_LEGACY_GIT_CACHE_DIR / "artist__poses"
            visible.mkdir(parents=True)
            hidden.mkdir(parents=True)
            (visible / "Standing.json").write_text("{}", encoding="utf-8")
            (hidden / "pose_library.json").write_text("{}", encoding="utf-8")

            walked_files = {
                str(Path(root, filename).relative_to(library_root))
                for root, _dirs, files in POSE_LIBRARY.walk_pose_library(str(library_root))
                for filename in files
            }

            self.assertEqual(walked_files, {str(Path("artist__poses/General/Standing.json"))})


if __name__ == "__main__":
    unittest.main()
