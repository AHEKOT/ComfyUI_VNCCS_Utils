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

    def test_manifest_uses_repository_specific_title(self):
        title = POSE_LIBRARY.repository_manifest_title(
            "Totemistyk/General_Poses_PoseStudio",
            "VNCCS Pose Library",
        )

        self.assertEqual(title, "Totemistyk/General_Poses_PoseStudio")

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

    def test_manifest_preserves_a_custom_title(self):
        title = POSE_LIBRARY.repository_manifest_title(
            "owner/repository",
            "Portrait Pose Collection",
        )

        self.assertEqual(title, "Portrait Pose Collection")

    def test_scoped_lookup_never_returns_an_unrelated_legacy_pose(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(POSE_LIBRARY, "get_library_path", return_value=directory),
            mock.patch.object(POSE_LIBRARY, "repository_dir_map", return_value={}),
        ):
            legacy = Path(directory) / "Walk.json"
            legacy.write_text("{}")
            self.assertEqual(POSE_LIBRARY.find_pose_file("Walk")[0], str(legacy))
            for repository, category in [("artist/remote", "Run"), ("artist/remote", None), (None, "Run")]:
                with self.subTest(repository=repository, category=category):
                    self.assertEqual(POSE_LIBRARY.find_pose_file("Walk", repository, category), (None, None, None))
            self.assertEqual(
                POSE_LIBRARY.find_pose_file("Walk", POSE_LIBRARY.LOCAL_USER_REPOSITORY, POSE_LIBRARY.DEFAULT_CATEGORY)[0],
                str(legacy),
            )

    def test_repository_save_failure_preserves_existing_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "repositories.json"
            previous = {"schema_version": 1, "repositories": [{"repo_id": "artist/poses"}]}
            path.write_text(json.dumps(previous))
            def broken_dump(_data, stream, **_kwargs):
                stream.write("{")
                raise OSError("disk full")
            with (
                mock.patch.object(POSE_LIBRARY, "get_user_repositories_path", return_value=str(path)),
                mock.patch.object(POSE_LIBRARY.json, "dump", side_effect=broken_dump),
                self.assertRaisesRegex(OSError, "disk full"),
            ):
                POSE_LIBRARY.save_user_repositories([{"repo_id": "artist/new"}])
            self.assertEqual(json.loads(path.read_text()), previous)
            self.assertEqual(list(Path(directory).glob("*.tmp.*")), [])

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

    def test_remote_publish_is_disabled(self):
        with self.assertRaisesRegex(PermissionError, "Remote publishing is disabled"):
            POSE_LIBRARY.publish_local_repository_to_hf(
                "owner/new-library",
                task_id="publish-test",
            )

    def test_publish_endpoint_never_falls_back_to_saved_repository(self):
        class FakeRequest:
            headers = {}
            can_read_body = False

            async def json(self):
                return {"create": True}

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

        self.assertEqual(response.status, 403)
        self.assertIn("disabled", response.payload["error"])
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

    def test_repository_refresh_downloads_through_public_http(self):
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
                    task_id="http-refresh",
                )

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["transport"], "http")
            self.assertEqual(result["downloaded_count"], 1)
            progress = POSE_LIBRARY.get_repository_progress("http-refresh")
            self.assertEqual(progress["transport"], "http")
            http_manifest.assert_called_once()
            http_asset.assert_called_once()

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

class PoseLibraryCleanupTests(unittest.TestCase):
    def _run_cleanup(self, library_root, expected_json, expected_preview=()):
        with mock.patch.object(POSE_LIBRARY, "get_library_path", return_value=str(library_root)):
            return POSE_LIBRARY.cleanup_local_repository_cache(
                "artist/poses", expected_json, expected_preview,
            )

    def test_cleanup_keeps_expected_files_and_removes_unknown(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pose_dir = root / POSE_LIBRARY.repository_to_dir("artist/poses") / "Kneeling"
            pose_dir.mkdir(parents=True)
            kept = pose_dir / "A.json"
            stale = pose_dir / "B.json"
            kept.write_text("{}", encoding="utf-8")
            stale.write_text("{}", encoding="utf-8")
            removed = self._run_cleanup(root, {str(kept)})
            self.assertTrue(kept.exists())
            self.assertFalse(stale.exists())
            self.assertEqual(len(removed), 1)

    def test_cleanup_compares_paths_with_platform_case_rules(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pose_dir = root / POSE_LIBRARY.repository_to_dir("artist/poses") / "Kneeling"
            pose_dir.mkdir(parents=True)
            target = pose_dir / "A.json"
            target.write_text("{}", encoding="utf-8")
            # Emulate a case-insensitive filesystem where the manifest category
            # casing differs from the directory that already exists.
            with mock.patch.object(POSE_LIBRARY.os.path, "normcase", side_effect=lambda p: p.lower()):
                self._run_cleanup(root, {str(pose_dir.parent / "kneeling" / "A.json")})
            self.assertTrue(target.exists())


if __name__ == "__main__":
    unittest.main()
