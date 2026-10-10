import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import sys
import tempfile
import threading
import types
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]


def load_modules():
    from helpers.backend_package import service_package
    load = service_package("vnccs_library_test")
    factory = load("nodes.factory3d.storage")
    library = load("nodes.factory3d.library")
    load("api.factory3d_library")
    return factory, library


def preview_data_url(color=(20, 30, 40, 255)):
    image = Image.new("RGBA", (96, 96), color)
    payload = io.BytesIO()
    image.save(payload, "PNG")
    import base64

    return "data:image/png;base64," + base64.b64encode(payload.getvalue()).decode()


class FactoryLibraryTests(unittest.TestCase):
    def test_colliding_repository_cannot_sync_another_cache(self):
        first, second = "artist/poses__v1", "artist__poses/v1"
        self.library._save_user_repositories([{"repo_id": first}, {"repo_id": second}])
        target = self.library._paths(second, "Things", "a" * 24)["package"]
        target.write_bytes(b"preserved asset")
        hub = types.ModuleType("huggingface_hub")
        hub.hf_hub_download = mock.Mock()
        with mock.patch.dict(sys.modules, {"huggingface_hub": hub}):
            with self.assertRaisesRegex(ValueError, "directory collision"):
                self.library._sync_repository(first, "collision", manage_progress=False)
        hub.hf_hub_download.assert_not_called()
        self.assertEqual(target.read_bytes(), b"preserved asset")

    def test_package_limits_apply_before_manifest_decompression_and_migration(self):
        paths = self.library._paths(self.library.LOCAL_REPOSITORY, "Things", "a" * 24)
        record = {"schema": self.library.SCHEMA, "repository": self.library.LOCAL_REPOSITORY,
                  "category": "Things", "asset_id": "a" * 24}
        manifest = {"schema": self.library.SCHEMA, "padding": "x" * 2048}
        with zipfile.ZipFile(paths["package"], "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            archive.writestr("payload.splat", b"legacy")
        before = paths["package"].read_bytes()
        limits = [(self.factory, "MAX_SCENE_JSON_BYTES", 1024),
                  (self.library, "MAX_EXTRACTED_BYTES", 1024),
                  (self.library, "MAX_PACKAGE_FILES", 1)]
        for owner, name, value in limits:
            with self.subTest(limit=name), mock.patch.object(owner, name, value):
                with mock.patch.object(zipfile.ZipFile, "read", side_effect=AssertionError("must validate before decompressing")):
                    for read in (lambda: self.library._read_package(paths),
                                 lambda: self.library._migrate_package_to_ply_only(paths, record)):
                        with self.assertRaisesRegex(ValueError, "too (large|many)"):
                            read()
                self.assertEqual(paths["package"].read_bytes(), before)
        self.assertEqual(list(paths["package"].parent.glob("*.tmp")), [])

    def test_scene_library_round_trip_preserves_explicit_root_ownership(self):
        scene = self.factory.create_scene("Root objects")
        scene_id = scene["scene_id"]
        scene = self.factory.update_scene(scene_id, {"architecture": {"buildings": [
            {"building_id": "b" * 32, "visible": False},
        ]}})
        created = self.factory.create_primitive_object(scene_id, {"primitive": {"kind": "plane"}})
        self.factory.update_scene(scene_id, {
            "objects": [{"object_id": created["object_id"], "building_id": ""}],
            "cameras": [{"camera_id": "c" * 32, "building_id": ""}],
            "camera_tracks": [{"track_id": "d" * 32, "building_id": ""}],
            "lighting": {"lights": [{"light_id": "e" * 32, "building_id": "",
                                      "level_id": scene["levels"][0]["level_id"]}]},
        })
        record = self.library.save_asset({"scene_id": scene_id, "asset_type": "scene"})
        result = self.library.load_asset(record["asset_id"], repository=record["repository"], category=record["category"])
        restored = self.factory.load_scene(result["scene"]["scene_id"])
        self.assertFalse(restored["architecture"]["buildings"][0]["visible"])
        for entries in (restored["objects"], restored["cameras"], restored["camera_tracks"], restored["lighting"]["lights"]):
            self.assertEqual(entries[0]["building_id"], "")

    def test_invalid_manifest_cannot_replace_or_remove_installed_assets(self):
        valid = {"asset_id": "a" * 24, "category": "Things", "package_path": "a.vnccs3d", "meta_path": "a.json"}
        invalid = [None, {}, {"assets": None}, {"assets": False}, {"assets": {}},
                   {"assets": [None]}, {"assets": [{}]},
                   {"assets": [{**valid, "asset_id": ""}]},
                   {"assets": [{**valid, "category": []}]},
                   {"assets": [{**valid, "package_sha256": "invalid"}]},
                   {"assets": [{**valid, "meta_path": "/absolute.json"}]},
                   {"assets": [valid, {**valid, "asset_id": "b" * 24, "meta_path": ""}]},
                   {"assets": [{**valid, "package_path": "../a.vnccs3d"}]},
                   {"assets": [valid, valid]}]
        paths = self.library._paths("owner/repo", "Things", "a" * 24)
        paths["package"].write_bytes(b"installed package")
        paths["meta"].write_bytes(b"installed metadata")
        manifest = self.root / "remote.json"
        hub = types.ModuleType("huggingface_hub")
        hub.hf_hub_download = mock.Mock(return_value=str(manifest))
        for value in invalid:
            with self.subTest(value=value):
                manifest.write_text(json.dumps(value))
                hub.hf_hub_download.reset_mock()
                with mock.patch.dict(sys.modules, {"huggingface_hub": hub}):
                    with self.assertRaises(ValueError):
                        self.library._sync_repository("owner/repo", "test", manage_progress=False)
                self.assertEqual(hub.hf_hub_download.call_count, 1)
                self.assertEqual(paths["package"].read_bytes(), b"installed package")
                self.assertEqual(paths["meta"].read_bytes(), b"installed metadata")

    def test_explicit_empty_manifest_removes_obsolete_downloads(self):
        paths = self.library._paths("owner/repo", "Things", "a" * 24)
        paths["package"].write_bytes(b"obsolete")
        manifest = self.root / "remote.json"
        manifest.write_text('{"assets": []}')
        hub = types.ModuleType("huggingface_hub")
        hub.hf_hub_download = lambda **kwargs: str(manifest)
        with mock.patch.dict(sys.modules, {"huggingface_hub": hub}):
            self.library._sync_repository("owner/repo", "test", manage_progress=False)
        self.assertFalse(paths["package"].exists())

    def test_parallel_refreshes_do_not_overlap_file_updates(self):
        manifest = self.root / "remote.json"
        manifest.write_text(json.dumps({"assets": [{"asset_id": "a" * 24, "category": "Things",
                                                   "package_path": "a.vnccs3d", "meta_path": "a.json"}]}))
        package = self.root / "remote.vnccs3d"
        package.write_bytes(b"package")
        metadata = self.root / "metadata.json"
        metadata.write_text(json.dumps({"schema": self.library.SCHEMA, "asset_id": "a" * 24}))
        first_entered, release, second_started, second_entered = (threading.Event() for _ in range(4))

        def download(**kwargs):
            if kwargs["filename"] == self.library.MANIFEST_NAME:
                if not first_entered.is_set():
                    first_entered.set()
                    if not release.wait(5):
                        raise TimeoutError("first refresh was not released")
                else:
                    second_entered.set()
                return str(manifest)
            return str(package if kwargs["filename"] == "a.vnccs3d" else metadata)

        def second_refresh():
            second_started.set()
            self.library._sync_repository("owner/repo", "second", manage_progress=False)

        hub = types.ModuleType("huggingface_hub")
        hub.hf_hub_download = download
        with (mock.patch.dict(sys.modules, {"huggingface_hub": hub}),
              mock.patch.object(self.library, "repository_progress_update"), ThreadPoolExecutor(max_workers=2) as pool):
            first = pool.submit(self.library._sync_repository, "owner/repo", "first", manage_progress=False)
            try:
                self.assertTrue(first_entered.wait(5))
                second = pool.submit(second_refresh)
                self.assertTrue(second_started.wait(5))
                self.assertFalse(second_entered.wait(0.2))
            finally:
                release.set()
            first.result(timeout=5)
            second.result(timeout=5)
        paths = self.library._paths("owner/repo", "Things", "a" * 24)
        self.assertEqual(paths["package"].read_bytes(), b"package")
        self.assertEqual(json.loads(paths["meta"].read_text())["repository"], "owner/repo")

    def test_bad_download_checksum_preserves_installed_package(self):
        paths = self.library._paths("owner/repo", "Things", "a" * 24)
        paths["package"].write_bytes(b"known good package")
        paths["meta"].write_text('{"name":"known good asset"}')
        manifest = self.root / "remote-manifest.json"
        manifest.write_text(json.dumps({"assets": [{
            "category": "Things", "asset_id": "a" * 24,
            "package_path": "updated.vnccs3d",
            "meta_path": "updated.json",
            "package_sha256": hashlib.sha256(b"expected bytes").hexdigest(),
        }]}))
        downloaded = self.root / "updated.vnccs3d"
        downloaded.write_bytes(b"wrong bytes")
        hub = types.ModuleType("huggingface_hub")
        hub.hf_hub_download = lambda **kwargs: str(manifest if kwargs["filename"] == self.library.MANIFEST_NAME else downloaded)
        with (
            mock.patch.dict(sys.modules, {"huggingface_hub": hub}),
            mock.patch.object(self.library, "repository_progress_start"),
            mock.patch.object(self.library, "repository_progress_update"),
            mock.patch.object(self.library, "repository_progress_fail") as failed,
        ):
            self.library._sync_repository("owner/repo", "test")
        self.assertIn("SHA256 mismatch", str(failed.call_args.args[-1]))
        self.assertEqual(paths["package"].read_bytes(), b"known good package")
        self.assertEqual(json.loads(paths["meta"].read_text()), {"name": "known good asset"})
        self.assertFalse(paths["package"].with_suffix(paths["package"].suffix + ".tmp").exists())
    @classmethod
    def setUpClass(cls):
        cls.factory, cls.library = load_modules()
        cls.api = sys.modules["vnccs_library_test.api.factory3d_library"]

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.original_factory_root = self.factory._factory_root
        self.original_model_root = self.factory._model_root
        self.original_library_root = self.library._root
        self.factory._factory_root = lambda: self.root / "output"
        self.factory._model_root = lambda: self.root / "models"
        self.library._root = lambda: (self.root / "ModelLibrary").resolve()

    def tearDown(self):
        self.factory._factory_root = self.original_factory_root
        self.factory._model_root = self.original_model_root
        self.library._root = self.original_library_root
        self.temporary.cleanup()

    def _remote_asset(self):
        asset_id = "a" * 24
        paths = self.library._paths("owner/repo", "Things", asset_id)
        paths["package"].write_bytes(b"installed package")
        paths["meta"].write_text(json.dumps({"schema": self.library.SCHEMA, "asset_id": asset_id, "name": "Installed"}))
        package = self.root / "download.vnccs3d"
        package.write_bytes(b"updated package")
        metadata = self.root / "download.json"
        metadata.write_text(json.dumps({"schema": self.library.SCHEMA, "asset_id": asset_id, "name": "Updated"}))
        manifest = self.root / "download-manifest.json"
        manifest.write_text(json.dumps({"assets": [{"asset_id": asset_id, "category": "Things",
            "package_path": "asset.vnccs3d", "meta_path": "asset.json",
            "package_sha256": hashlib.sha256(package.read_bytes()).hexdigest()}]}))
        hub = types.ModuleType("huggingface_hub")
        hub.hf_hub_download = lambda **kwargs: str({self.library.MANIFEST_NAME: manifest,
            "asset.vnccs3d": package, "asset.json": metadata}[kwargs["filename"]])
        return paths, metadata, manifest, hub

    def test_bad_download_metadata_preserves_every_installed_file(self):
        paths, metadata, _manifest, hub = self._remote_asset()
        before = {kind: path.read_bytes() for kind, path in paths.items() if path.exists()}
        for raw in ('{"schema":', '[]', '{}', '{"schema":"future","asset_id":"' + "a" * 24 + '"}'):
            with self.subTest(metadata=raw):
                metadata.write_text(raw)
                with mock.patch.dict(sys.modules, {"huggingface_hub": hub}), self.assertRaises(ValueError):
                    self.library._sync_repository("owner/repo", "bad-meta", manage_progress=False)
                self.assertEqual({kind: path.read_bytes() for kind, path in paths.items() if path.exists()}, before)
                self.assertEqual(list(paths["meta"].parent.glob(".sync-*")), [])

    def test_failed_commit_rolls_back_the_whole_installed_asset(self):
        paths, _metadata, _manifest, hub = self._remote_asset()
        before = {kind: path.read_bytes() for kind, path in paths.items() if path.exists()}
        original_replace = self.library.os.replace
        failed = False
        def replace(source, target):
            nonlocal failed
            if not failed and Path(target) == paths["meta"] and Path(source).name == paths["meta"].name:
                failed = True
                raise OSError("disk full")
            return original_replace(source, target)
        with (mock.patch.dict(sys.modules, {"huggingface_hub": hub}),
              mock.patch.object(self.library.os, "replace", side_effect=replace),
              self.assertRaisesRegex(OSError, "disk full")):
            self.library._sync_repository("owner/repo", "failed-commit", manage_progress=False)
        self.assertTrue(failed)
        self.assertEqual({kind: path.read_bytes() for kind, path in paths.items() if path.exists()}, before)

    def test_unchanged_refresh_does_not_copy_or_replace_installed_files(self):
        _paths, _metadata, _manifest, hub = self._remote_asset()
        with mock.patch.dict(sys.modules, {"huggingface_hub": hub}):
            self.library._sync_repository("owner/repo", "initial", manage_progress=False)
            with (mock.patch.object(self.library.shutil, "copy2", wraps=self.library.shutil.copy2) as copy,
                  mock.patch.object(self.library.os, "replace", wraps=self.library.os.replace) as replace):
                self.library._sync_repository("owner/repo", "unchanged", manage_progress=False)
            copy.assert_not_called()
            self.assertFalse(any(Path(call.args[1]).parent == _paths["meta"].parent for call in replace.call_args_list))

    def test_failed_rollback_retains_recovery_files(self):
        paths, _metadata, _manifest, hub = self._remote_asset()
        old_package = paths["package"].read_bytes()
        old_meta = paths["meta"].read_bytes()
        original_replace = self.library.os.replace
        def replace(source, target):
            if Path(target) == paths["meta"]:
                raise OSError("storage unavailable")
            return original_replace(source, target)
        with (mock.patch.dict(sys.modules, {"huggingface_hub": hub}),
              mock.patch.object(self.library.os, "replace", side_effect=replace),
              self.assertRaisesRegex(OSError, "recovery files preserved")):
            self.library._sync_repository("owner/repo", "failed-rollback", manage_progress=False)
        stages = list(paths["meta"].parent.glob(".sync-*"))
        self.assertEqual(len(stages), 1)
        self.assertEqual((stages[0] / "meta.backup").read_bytes(), old_meta)
        self.assertEqual((stages[0] / "package.backup").read_bytes(), old_package)

    def test_failed_preview_download_preserves_the_installed_asset(self):
        paths, _metadata, manifest, hub = self._remote_asset()
        before = {kind: path.read_bytes() for kind, path in paths.items() if path.exists()}
        value = json.loads(manifest.read_text())
        value["assets"][0]["preview_path"] = "unavailable.png"
        manifest.write_text(json.dumps(value))
        original_download = hub.hf_hub_download
        def download(**kwargs):
            if kwargs["filename"] == "unavailable.png":
                raise OSError("offline")
            return original_download(**kwargs)
        hub.hf_hub_download = download
        with mock.patch.dict(sys.modules, {"huggingface_hub": hub}), self.assertRaisesRegex(OSError, "offline"):
            self.library._sync_repository("owner/repo", "failed-preview", manage_progress=False)
        self.assertEqual({kind: path.read_bytes() for kind, path in paths.items() if path.exists()}, before)

    def test_corrupt_repository_settings_cannot_be_overwritten(self):
        path = self.library._repository_config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        for raw in ('[{"repo_id":"artist/old"}', '{}', '[null]'):
            with self.subTest(raw=raw):
                path.write_text(raw)
                with self.assertRaisesRegex(ValueError, "original file preserved"):
                    self.library._user_repositories()
                with self.assertRaisesRegex(ValueError, "original file preserved"):
                    self.library._save_user_repositories([{"repo_id": "artist/new"}])
                self.assertEqual(path.read_text(), raw)

    def test_auto_refresh_requests_share_one_task_and_release_it_after_failure(self):
        from aiohttp import web
        routes = web.RouteTableDef()
        self.api.register_routes(routes)
        handler = next(route.handler for route in routes if route.path.endswith("/repositories/auto_refresh"))
        state = {"running": False, "task_id": "", "last_started": 0}
        with (mock.patch.object(self.library, "_BACKGROUND_REFRESH_STATE", state),
              mock.patch.object(self.library, "_repositories", return_value=[{"repo_id": "owner/repo", "enabled": True}]),
              mock.patch.object(self.api.threading, "Thread") as thread):
            first = json.loads(asyncio.run(handler(None)).body)
            second = json.loads(asyncio.run(handler(None)).body)
            self.assertEqual(first["task_id"], second["task_id"])
            thread.assert_called_once()
            thread.return_value.start.assert_called_once()
            with mock.patch.object(self.library, "_sync_repository", side_effect=OSError("offline")):
                self.library._sync_repositories(["owner/repo"], first["task_id"], auto_refresh=True)
            self.assertFalse(state["running"])
            self.assertEqual(json.loads(asyncio.run(handler(None)).body)["task_id"], "")
            thread.assert_called_once()
            state["last_started"] = 0
            thread.return_value.start.side_effect = RuntimeError("thread unavailable")
            self.assertEqual(asyncio.run(handler(None)).status, 400)
            self.assertFalse(state["running"])
            self.assertEqual(state["last_started"], 0)

    def test_parametric_scene_and_object_packages_preserve_recipe_and_texture(self):
        scene = self.factory.create_scene("Procedural")
        scene = self.factory.upgrade_scene(scene["scene_id"])
        image = io.BytesIO()
        Image.new("RGBA", (8, 8), (23, 90, 120, 255)).save(image, "PNG")
        scene, texture = self.factory.store_scene_texture(scene["scene_id"], image.getvalue(), "Surface.png")
        created = self.factory.create_primitive_object(scene["scene_id"], {
            "primitive": {"kind": "stairs", "steps": 17, "width": 2, "height": 3, "depth": 4, "texture_id": texture["texture_id"]},
        })
        object_id = created["object_id"]
        for asset_type in ("scene", "object"):
            with self.subTest(asset_type=asset_type):
                record = self.library.save_asset({"scene_id": scene["scene_id"], "object_id": object_id,
                                                  "asset_type": asset_type, "name": "Stairs", "category": "Architecture"})
                target = self.factory.create_scene("Target")
                result = self.library.load_asset(record["asset_id"], repository=record["repository"],
                                                 category=record["category"], scene_id=target["scene_id"])
                restored = self.factory.load_scene(result["scene"]["scene_id"])
                self.assertEqual(restored["schema_version"], 12)
                item = restored["objects"][0]
                self.assertEqual(item["primitive"]["kind"], "stairs")
                self.assertEqual(item["primitive"]["steps"], 17)
                self.assertNotEqual(item["primitive"]["texture_id"], texture["texture_id"])
                with Image.open(self.factory._scene_texture_file(restored, item["primitive"]["texture_id"])) as decoded:
                    self.assertEqual(decoded.getpixel((0, 0)), (23, 90, 120, 255))
                self.assertEqual(self.factory.load_scene(target["scene_id"])["objects"], [])

    def make_scene(self):
        scene = self.factory.create_scene("Library scene")
        object_id = self.factory._new_id()
        root = self.factory.resolve_scene_dir(scene["scene_id"])
        object_root = root / "objects" / object_id
        object_root.mkdir(parents=True)
        Image.new("RGBA", (64, 64), (200, 80, 40, 255)).save(
            object_root / "prepared.png"
        )
        names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
                 "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
        dtype = np.dtype([(name, "<f4") for name in names])
        records = np.zeros(1, dtype=dtype)
        records["rot_0"] = 1
        gaussian = sys.modules[f"{self.factory.__package__}.gaussian_scene"]
        (object_root / "model.ply").write_bytes(gaussian._ply_header(1, dtype) + records.tobytes())
        scene["objects"].append(
            {
                "object_id": object_id,
                "name": "Library object",
                "created_at": 1,
                "gaussians": 1,
                "seed": 7,
                "transform": self.factory.normalize_transform({}),
                "files": {
                    "prepared": f"objects/{object_id}/prepared.png",
                    "ply": f"objects/{object_id}/model.ply",
                },
            }
        )
        scene["layers"] = [{"type": "object", "object_id": object_id}]
        self.factory._save_scene(scene)
        return self.factory.load_scene(scene["scene_id"]), object_id

    def test_object_package_round_trip_is_native_and_incremental(self):
        scene, object_id = self.make_scene()
        record = self.library.save_asset(
            {
                "scene_id": scene["scene_id"],
                "object_id": object_id,
                "asset_type": "object",
                "name": "Saved prop",
                "category": "Props",
                "tags": ["metal"],
                "preview": preview_data_url(),
            }
        )
        self.assertEqual(record["asset_type"], "object")
        self.assertEqual(record["gaussians"], 1)
        self.assertTrue(record["has_preview"])
        self.assertEqual(len(self.library._read_records()), 1)
        paths = self.library._paths(
            record["repository"],
            record["category"],
            record["asset_id"],
        )
        with zipfile.ZipFile(paths["package"], "r") as archive:
            self.assertFalse(
                any(Path(name).suffix.lower() == ".splat" for name in archive.namelist())
            )
            manifest = json.loads(archive.read("manifest.json"))
            self.assertNotIn("splat", manifest["payload"]["object"]["files"])

        result = self.library.load_asset(
            record["asset_id"],
            repository=record["repository"],
            category=record["category"],
            scene_id=scene["scene_id"],
        )
        self.assertFalse(result["created_scene"])
        restored = self.factory.load_scene(scene["scene_id"])
        self.assertEqual(len(restored["objects"]), 2)
        imported = self.factory._object_by_id(restored, result["object_id"])
        self.assertNotIn("splat", imported["files"])
        self.assertEqual(
            self.factory._object_file(restored["scene_id"], imported, "ply").read_bytes(),
            self.factory._object_file(scene["scene_id"], scene["objects"][0], "ply").read_bytes(),
        )

        updated = self.library.update_asset(
            record["asset_id"],
            {
                "repository": record["repository"],
                "old_category": record["category"],
                "name": "Renamed prop",
                "category": "Architecture",
                "description": "Edited through the Pose-style inspector.",
                "tags": ["building"],
            },
        )
        self.assertEqual(updated["name"], "Renamed prop")
        self.assertEqual(updated["category"], "Architecture")
        self.assertFalse(
            self.library._paths(
                record["repository"],
                record["category"],
                record["asset_id"],
            )["meta"].exists()
        )

    def test_failed_preview_update_preserves_the_same_category_asset(self):
        scene, object_id = self.make_scene()
        for with_preview in (False, True):
            with self.subTest(with_preview=with_preview):
                record = self.library.save_asset({"scene_id": scene["scene_id"], "object_id": object_id,
                    "asset_type": "object", "category": "Props", "preview": preview_data_url() if with_preview else None})
                paths = self.library._paths(record["repository"], record["category"], record["asset_id"])
                before = {kind: path.read_bytes() for kind, path in paths.items() if path.exists()}
                with mock.patch.object(self.library, "_atomic_json", side_effect=OSError("disk full")):
                    with self.assertRaisesRegex(OSError, "disk full"):
                        self.library.update_asset(record["asset_id"], {"category": "Props", "name": "Unsaved", "preview": preview_data_url((255, 0, 0, 255))})
                self.assertEqual({kind: path.read_bytes() for kind, path in paths.items() if path.exists()}, before)
                self.assertEqual(list(paths["meta"].parent.glob("*.tmp")), [])
                self.assertEqual(self.library._find_record(record["asset_id"], record["repository"], "Props")[0], record)

    def test_category_move_failure_preserves_readable_original_asset(self):
        scene, object_id = self.make_scene()
        record = self.library.save_asset({"scene_id": scene["scene_id"], "object_id": object_id,
            "asset_type": "object", "category": "Props", "preview": preview_data_url()})
        original = self.library._paths(record["repository"], record["category"], record["asset_id"])
        before = {kind: path.read_bytes() for kind, path in original.items()}
        for operation in ("copyfile", "_atomic_json"):
            with self.subTest(operation=operation):
                owner = self.library.shutil if operation == "copyfile" else self.library
                with mock.patch.object(owner, operation, side_effect=OSError("disk full")):
                    with self.assertRaisesRegex(OSError, "disk full"):
                        self.library.update_asset(record["asset_id"], {"old_category": "Props", "category": "New"})
                self.assertEqual({kind: path.read_bytes() for kind, path in original.items()}, before)
                self.assertEqual(self.library._find_record(record["asset_id"], record["repository"], "Props")[0], record)
                target = self.library._paths(record["repository"], "New", record["asset_id"])
                self.assertFalse(any(path.exists() for path in target.values()))

    def test_failed_preview_rollback_retains_the_original_recovery_file(self):
        scene, object_id = self.make_scene()
        record = self.library.save_asset({"scene_id": scene["scene_id"], "object_id": object_id,
            "asset_type": "object", "category": "Props", "preview": preview_data_url()})
        paths = self.library._paths(record["repository"], record["category"], record["asset_id"])
        before = paths["preview"].read_bytes()
        replace = self.library.os.replace
        installs = []
        def fail_rollback(source, target):
            installs.append(source)
            if len(installs) == 2:
                raise OSError("rollback failed")
            replace(source, target)
        with mock.patch.object(self.library, "_atomic_json", side_effect=OSError("disk full")), \
                mock.patch.object(self.library.os, "replace", side_effect=fail_rollback):
            with self.assertRaisesRegex(OSError, "rollback failed"):
                self.library.update_asset(record["asset_id"], {"category": "Props", "preview": preview_data_url((255, 0, 0, 255))})
        recovery = list(paths["preview"].parent.glob("*.tmp"))
        self.assertEqual(len(recovery), 1)
        self.assertEqual(recovery[0].read_bytes(), before)

    def test_invalid_gaussian_package_does_not_change_scene_or_leave_object_files(self):
        scene, object_id = self.make_scene()
        self.factory._object_file(scene["scene_id"], scene["objects"][0], "ply").write_bytes(b"NOT A PLY")
        record = self.library.save_asset({"scene_id": scene["scene_id"], "object_id": object_id,
            "asset_type": "object", "category": "Props"})
        root = self.factory.resolve_scene_dir(scene["scene_id"])
        before = (root / "scene.json").read_bytes()
        with self.assertRaises(ValueError):
            self.library.load_asset(record["asset_id"], repository=record["repository"],
                                    category=record["category"], scene_id=scene["scene_id"])
        self.assertEqual((root / "scene.json").read_bytes(), before)
        self.assertEqual([path.name for path in (root / "objects").iterdir()], [object_id])

    def test_failed_category_move_cannot_remove_a_concurrent_successful_retry(self):
        scene, object_id = self.make_scene()
        record = self.library.save_asset({"scene_id": scene["scene_id"], "object_id": object_id,
            "asset_type": "object", "category": "Props"})
        entered, release, retry_started, retry_done = (threading.Event() for _ in range(4))
        write = self.library._atomic_json

        def failing_write(path, value):
            if value["name"] == "Fail":
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("test writer timed out")
                raise OSError("disk full")
            write(path, value)

        def update(name):
            if name == "Retry":
                retry_started.set()
            try:
                return self.library.update_asset(record["asset_id"], {
                    "old_category": "Props", "category": "New", "name": name})
            finally:
                if name == "Retry":
                    retry_done.set()

        with mock.patch.object(self.library, "_atomic_json", side_effect=failing_write), ThreadPoolExecutor(2) as pool:
            failed = pool.submit(update, "Fail")
            try:
                self.assertTrue(entered.wait(5))
                retried = pool.submit(update, "Retry")
                self.assertTrue(retry_started.wait(5))
                self.assertFalse(retry_done.wait(.1))
            finally:
                release.set()
            with self.assertRaisesRegex(OSError, "disk full"):
                failed.result(timeout=5)
            retried.result(timeout=5)
        restored, paths = self.library._find_record(record["asset_id"], record["repository"], "New")
        self.assertEqual(restored["name"], "Retry")
        self.assertTrue(paths["package"].is_file())
        self.library.load_asset(record["asset_id"], repository=record["repository"], category="New", scene_id=scene["scene_id"])

    def test_scene_package_preserves_camera_render_lighting_and_layers(self):
        scene, object_id = self.make_scene()
        sky_stream = io.BytesIO()
        Image.new("RGB", (512, 256), (30, 80, 160)).save(sky_stream, "JPEG")
        self.factory.store_scene_skydome(
            scene["scene_id"],
            sky_stream.getvalue(),
            "Studio sky.jpg",
        )
        scene = self.factory.load_scene(scene["scene_id"])
        scene["skydome"].update({"yaw": 72, "pitch": -4, "exposure": 0.6})
        scene["camera"] = {
            "position": [8, 7, 6],
            "target": [1, 2, 3],
            "up": [0, 1, 0],
            "fov": 55,
        }
        saved_camera_id = self.factory._new_id()
        scene["cameras"] = [{
            "camera_id": saved_camera_id,
            "name": "Detail camera",
            "position": [3, 2, 1],
            "target": [0, 0, 0],
            "up": [0, 1, 0],
            "fov": 48,
        }]
        scene["render"] = {
            "width": 1600,
            "height": 900,
            "aspect": "16:9",
            "show_camera_frame": True,
        }
        light_id = self.factory._new_id()
        scene["lighting"] = {
            "preset": "sunset",
            "intensity": 0.8,
            "color": "#ff865f",
            "azimuth": 58,
            "elevation": 11,
            "ambient": 0.28,
            "background": "#25141b",
            "shadows": {
                "enabled": True,
                "quality": "high",
                "bias": -0.0002,
                "normal_bias": 0.0015,
            },
            "lights": [{
                "light_id": light_id,
                "name": "Practical",
                "level_id": scene["levels"][0]["level_id"],
                "building_id": "",
                "kind": "point",
                "position": [1, 2.4, 3],
                "target": [1, 0, 3],
                "color": "#ff0088",
                "intensity": 10,
                "distance": 8,
                "angle": 45,
                "penumbra": 0.2,
                "cast_shadow": True,
                "visible": True,
            }],
        }
        scene["layers"] = [
            {
                "type": "group",
                "group_id": self.factory._new_id(),
                "name": "Architecture",
                "visible": True,
                "children": [object_id],
            }
        ]
        self.factory._save_scene(scene)
        record = self.library.save_asset(
            {
                "scene_id": scene["scene_id"],
                "asset_type": "scene",
                "name": "Complete set",
                "preview": preview_data_url(),
            }
        )
        result = self.library.load_asset(
            record["asset_id"],
            repository=record["repository"],
            category=record["category"],
        )
        self.assertTrue(result["created_scene"])
        restored = self.factory.load_scene(result["scene"]["scene_id"])
        self.assertEqual(restored["camera"]["position"], [8.0, 7.0, 6.0])
        self.assertEqual(len(restored["cameras"]), 1)
        self.assertNotEqual(restored["cameras"][0]["camera_id"], saved_camera_id)
        self.assertEqual(restored["cameras"][0]["position"], [3.0, 2.0, 1.0])
        self.assertEqual(restored["render"]["width"], 1600)
        self.assertEqual(restored["lighting"]["preset"], "sunset")
        self.assertEqual(restored["lighting"]["shadows"]["quality"], "high")
        self.assertEqual(len(restored["lighting"]["lights"]), 1)
        self.assertEqual(restored["lighting"]["lights"][0]["light_id"], light_id)
        self.assertEqual(restored["lighting"]["lights"][0]["name"], "Practical")
        self.assertEqual(restored["lighting"]["lights"][0]["position"], [1.0, 2.4, 3.0])
        self.assertEqual(
            restored["lighting"]["lights"][0]["level_id"],
            restored["levels"][0]["level_id"],
        )
        self.assertEqual(restored["layers"][0]["type"], "group")
        self.assertEqual(len(restored["layers"][0]["children"]), 1)
        self.assertEqual(restored["skydome"]["type"], "skydome")
        self.assertEqual(restored["skydome"]["yaw"], 72.0)
        self.assertEqual(restored["skydome"]["pitch"], -4.0)
        self.assertEqual(restored["skydome"]["exposure"], 0.6)
        with Image.open(self.factory._scene_skydome_file(restored)) as restored_sky:
            self.assertEqual(restored_sky.size, (512, 256))

    def test_failed_library_skydome_install_preserves_the_target_scene(self):
        source = self.factory.create_scene("Source")
        stream = io.BytesIO()
        Image.new("RGB", (16, 8), "blue").save(stream, "PNG")
        self.factory.store_scene_skydome(source["scene_id"], stream.getvalue())
        record = self.library.save_asset({"scene_id": source["scene_id"], "asset_type": "skydome", "name": "Blue"})
        target = self.factory.create_scene("Target")
        stream = io.BytesIO()
        Image.new("RGB", (16, 8), "red").save(stream, "JPEG")
        target = self.factory.store_scene_skydome(target["scene_id"], stream.getvalue())
        root = self.factory.resolve_scene_dir(target["scene_id"])
        before = {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}
        for stage in ("_write_browser_preview", "_save_scene"):
            with self.subTest(stage=stage):
                with mock.patch.object(self.factory, stage, side_effect=OSError("disk error")):
                    with self.assertRaisesRegex(OSError, "disk error"):
                        self.library.load_asset(record["asset_id"], repository=record["repository"],
                                                category=record["category"], scene_id=target["scene_id"])
                self.assertEqual({str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}, before)
        restored = self.library.load_asset(record["asset_id"], repository=record["repository"],
                                           category=record["category"], scene_id=target["scene_id"])
        self.assertEqual(restored["scene"]["skydome"]["name"], "Blue")
        self.assertFalse((root / target["skydome"]["file"]).exists())

    def test_skydome_library_asset_has_fixed_type_and_replaces_scene_background(self):
        source, _object_id = self.make_scene()
        sky_stream = io.BytesIO()
        Image.new("RGB", (640, 320), (120, 55, 180)).save(sky_stream, "PNG")
        self.factory.store_scene_skydome(
            source["scene_id"],
            sky_stream.getvalue(),
            "Nebula.png",
        )
        source = self.factory.update_scene(
            source["scene_id"],
            {
                "skydome": {
                    "yaw": -115,
                    "pitch": 8,
                    "roll": 2,
                    "exposure": -0.4,
                    "blur": 0.15,
                }
            },
        )
        record = self.library.save_asset(
            {
                "scene_id": source["scene_id"],
                "asset_type": "skydome",
                "name": "Saved nebula",
                "category": "Environments",
            }
        )
        self.assertEqual(record["asset_type"], "skydome")
        self.assertEqual(record["gaussians"], 0)
        self.assertTrue(record["has_preview"])

        target = self.factory.create_scene("Target")
        result = self.library.load_asset(
            record["asset_id"],
            repository=record["repository"],
            category=record["category"],
            scene_id=target["scene_id"],
        )
        self.assertFalse(result["created_scene"])
        self.assertRegex(result["skydome_id"], r"^[a-f0-9]{32}$")
        restored = self.factory.load_scene(target["scene_id"])
        self.assertEqual(restored["skydome"]["type"], "skydome")
        self.assertEqual(restored["skydome"]["name"], "Saved nebula")
        self.assertEqual(restored["skydome"]["yaw"], -115.0)
        self.assertEqual(restored["skydome"]["blur"], 0.15)
        with Image.open(self.factory._scene_skydome_file(restored)) as restored_sky:
            self.assertEqual(restored_sky.size, (640, 320))

    def test_legacy_package_splat_is_removed_during_library_migration(self):
        scene, object_id = self.make_scene()
        record = self.library.save_asset(
            {
                "scene_id": scene["scene_id"],
                "object_id": object_id,
                "asset_type": "object",
                "name": "Legacy object",
            }
        )
        paths = self.library._paths(
            record["repository"],
            record["category"],
            record["asset_id"],
        )
        with zipfile.ZipFile(paths["package"], "r") as archive:
            members = {
                name: archive.read(name)
                for name in archive.namelist()
                if name != "manifest.json"
            }
            manifest = json.loads(archive.read("manifest.json"))
        manifest["payload"]["object"]["files"]["splat"] = "payload/object/model.splat"
        temporary = paths["package"].with_suffix(".legacy")
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            for name, data in members.items():
                archive.writestr(name, data, compress_type=zipfile.ZIP_STORED)
            archive.writestr(
                "payload/object/model.splat",
                b"\0" * 32,
                compress_type=zipfile.ZIP_STORED,
            )
            archive.writestr(
                "manifest.json",
                json.dumps(manifest).encode(),
                compress_type=zipfile.ZIP_STORED,
            )
        temporary.replace(paths["package"])

        self.assertEqual(len(self.library._read_records()), 1)
        with zipfile.ZipFile(paths["package"], "r") as archive:
            self.assertNotIn("payload/object/model.splat", archive.namelist())
            migrated = json.loads(archive.read("manifest.json"))
            self.assertNotIn("splat", migrated["payload"]["object"]["files"])

    def test_pose_or_foreign_records_can_never_enter_factory_library(self):
        foreign_id = "a" * 24
        root = self.library._root()
        category = root / self.library.LOCAL_REPOSITORY / "Uncategorized"
        category.mkdir(parents=True)
        (category / f"{foreign_id}.json").write_text(
            """{
              "schema": "vnccs-pose-library/v1",
              "asset_id": "aaaaaaaaaaaaaaaaaaaaaaaa",
              "asset_type": "pose",
              "name": "Fighting A",
              "repository": "local_user_models",
              "category": "Uncategorized"
            }""",
            encoding="utf-8",
        )
        (category / f"{foreign_id}.vnccs3d").write_bytes(b"not-a-gaussian-package")

        self.assertEqual(self.library._read_records(), [])
        with self.assertRaises(FileNotFoundError):
            self.library._find_record(foreign_id)

    def test_routes_register_on_factory_comfyui_route_table(self):
        class RouteTable:
            def __init__(self):
                self.definitions = []

            def _add(self, method, path):
                def decorator(handler):
                    self.definitions.append((method, path, handler))
                    return handler

                return decorator

            def get(self, path):
                return self._add("GET", path)

            def post(self, path):
                return self._add("POST", path)

            def put(self, path):
                return self._add("PUT", path)

            def delete(self, path):
                return self._add("DELETE", path)

        routes = RouteTable()
        original_aiohttp = sys.modules.get("aiohttp")
        sys.modules["aiohttp"] = types.SimpleNamespace(web=types.SimpleNamespace())
        try:
            self.api.register_routes(routes)
        finally:
            if original_aiohttp is None:
                sys.modules.pop("aiohttp", None)
            else:
                sys.modules["aiohttp"] = original_aiohttp
        paths = {(method, path) for method, path, _handler in routes.definitions}
        self.assertIn(("GET", "/vnccs/3d-factory/library/items"), paths)
        self.assertIn(("POST", "/vnccs/3d-factory/library/items"), paths)
        self.assertIn(
            ("PUT", "/vnccs/3d-factory/library/items/{asset_id}"),
            paths,
        )
        self.assertIn(
            ("GET", "/vnccs/3d-factory/library/repositories"),
            paths,
        )

        delete_repository = next(handler for method, path, handler in routes.definitions
                                 if method == "DELETE" and path.endswith("/repositories/{repo_id:.+}"))
        fake_web = types.SimpleNamespace(json_response=lambda payload, status=200:
                                         types.SimpleNamespace(payload=payload, status=status))
        with (mock.patch.dict(sys.modules, {"aiohttp": types.SimpleNamespace(web=fake_web)}),
              mock.patch.object(self.library, "_repositories", return_value=[]),
              mock.patch.object(self.library, "_save_user_repositories") as save,
              mock.patch.object(self.library.shutil, "rmtree") as remove):
            for repo_id in ("", " ", ".", "..", "/", self.library.LOCAL_REPOSITORY,
                            self.library.LOCAL_REPOSITORY.upper(), self.library.LOCAL_REPOSITORY + "/"):
                with self.subTest(repo_id=repo_id):
                    response = asyncio.run(delete_repository(types.SimpleNamespace(match_info={"repo_id": repo_id})))
                    self.assertEqual(response.status, 400)
            save.assert_not_called()
            remove.assert_not_called()
            with mock.patch.object(self.library, "_repositories", return_value=[{"repo_id": "official/models", "builtin": True}]):
                response = asyncio.run(delete_repository(types.SimpleNamespace(match_info={"repo_id": "official/models"})))
                self.assertEqual(response.status, 400)
            save.assert_not_called()
            remove.assert_not_called()

        # The valid remote path still removes only that repository's cache.
        remote = self.library._root() / self.library._repo_dir("artist/models")
        remote.mkdir(parents=True)
        (remote / "cache.json").write_text("{}")
        local = self.library._root() / self.library.LOCAL_REPOSITORY
        local.mkdir()
        with (mock.patch.dict(sys.modules, {"aiohttp": types.SimpleNamespace(web=fake_web)}),
              mock.patch.object(self.library, "_repositories", return_value=[]),
              mock.patch.object(self.library, "_user_repositories", return_value=[{"repo_id": "artist/models"}]),
              mock.patch.object(self.library, "_save_user_repositories") as save):
            # The route captures its web module when registered.
            routes = RouteTable()
            self.api.register_routes(routes)
            delete_repository = next(handler for method, path, handler in routes.definitions
                                     if method == "DELETE" and path.endswith("/repositories/{repo_id:.+}"))
            response = asyncio.run(delete_repository(types.SimpleNamespace(match_info={"repo_id": "artist/models"})))
            self.assertEqual(response.status, 200)
            self.assertFalse(remote.exists())
            self.assertTrue(local.exists())
            save.assert_called_once_with([])

        first, second = "artist/poses__v1", "artist__poses/v1"
        target = self.library._paths(second, "Things", "a" * 24)["package"]
        target.write_bytes(b"preserved asset")
        with (mock.patch.dict(sys.modules, {"aiohttp": types.SimpleNamespace(web=fake_web)}),
              mock.patch.object(self.library, "_repositories", return_value=[{"repo_id": second}]),
              mock.patch.object(self.library, "_user_repositories", return_value=[{"repo_id": second}]),
              mock.patch.object(self.library, "_save_user_repositories") as save,
              mock.patch.object(self.api.threading, "Thread") as worker):
            routes = RouteTable()
            self.api.register_routes(routes)
            add_repository = next(handler for method, path, handler in routes.definitions
                                  if method == "POST" and path.endswith("/repositories/add"))
            delete_repository = next(handler for method, path, handler in routes.definitions
                                     if method == "DELETE" and path.endswith("/repositories/{repo_id:.+}"))
            request = types.SimpleNamespace(headers={}, match_info={"repo_id": first},
                                            json=mock.AsyncMock(return_value={"repo_id": first}))
            for handler in (add_repository, delete_repository):
                response = asyncio.run(handler(request))
                self.assertEqual(response.status, 400)
                self.assertIn("directory collision", response.payload["error"])
            save.assert_not_called()
            worker.assert_not_called()
        self.assertEqual(target.read_bytes(), b"preserved asset")


if __name__ == "__main__":
    unittest.main()
