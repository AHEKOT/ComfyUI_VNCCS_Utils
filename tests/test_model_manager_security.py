import asyncio
import importlib.util
import json
import queue
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


class _FakeRoutes:
    def get(self, *_args, **_kwargs):
        return lambda function: function

    def post(self, *_args, **_kwargs):
        return lambda function: function


def _load_model_manager_module():
    server_module = types.ModuleType("server")
    server_module.PromptServer = types.SimpleNamespace(
        instance=types.SimpleNamespace(routes=_FakeRoutes()),
    )
    folder_paths_module = types.ModuleType("folder_paths")
    folder_paths_module.base_path = str(ROOT)
    folder_paths_module.models_dir = str(ROOT / "models")
    huggingface_module = types.ModuleType("huggingface_hub")
    huggingface_module.hf_hub_download = lambda **_kwargs: ""
    huggingface_module.hf_hub_url = lambda repo_id, filename: f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
    aiohttp_module = types.ModuleType("aiohttp")
    aiohttp_web_module = types.ModuleType("aiohttp.web")
    aiohttp_web_module.json_response = lambda *args, **kwargs: (args, kwargs)
    aiohttp_module.web = aiohttp_web_module
    stubs = {
        "server": server_module,
        "folder_paths": folder_paths_module,
        "huggingface_hub": huggingface_module,
        "aiohttp": aiohttp_module,
        "aiohttp.web": aiohttp_web_module,
    }
    previous = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        name = "vnccs_model_manager_security_testmodule"
        spec = importlib.util.spec_from_file_location(name, ROOT / "nodes" / "vnccs_model_manager.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


MODEL_MANAGER = _load_model_manager_module()


class ModelManagerSecurityTests(unittest.TestCase):
    def setUp(self):
        MODEL_MANAGER.download_status.clear()

    def test_untrusted_manifest_is_rejected_before_cache_or_network_access(self):
        with mock.patch.object(MODEL_MANAGER, "hf_hub_download") as download:
            for repo_id in ("attacker/models", "", None, ["MIUProject/VNCCS"]):
                with self.subTest(repo_id=repo_id), self.assertRaises(PermissionError):
                    MODEL_MANAGER.get_cached_config_path(repo_id)
            download.assert_not_called()

    def test_download_route_rejects_untrusted_repository(self):
        with mock.patch.object(MODEL_MANAGER, "get_cached_config_path") as config:
            for payload, status in (({"repo_id": "attacker/models", "model_name": "payload"}, 403),
                                    ({"repo_id": ["MIUProject/VNCCS"]}, 403), ([], 400), (None, 400)):
                with self.subTest(payload=payload):
                    request = types.SimpleNamespace(json=mock.AsyncMock(return_value=payload))
                    _args, kwargs = asyncio.run(MODEL_MANAGER.download_model(request))
                    self.assertEqual(kwargs["status"], status)
        config.assert_not_called()

    def test_download_route_queues_only_new_files_in_known_folders(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "manifest.json"
            entry = {"name": "Test", "version": "1", "hf_path": "model.safetensors"}
            request = types.SimpleNamespace(json=mock.AsyncMock(return_value={
                "repo_id": "MIUProject/VNCCS", "model_name": "Test", "version": "1",
                "hf_repo": "attacker/models", "local_path": "models/unknown/payload.pt",
            }))
            with (mock.patch.object(MODEL_MANAGER.folder_paths, "models_dir", str(root / "models")),
                  mock.patch.object(MODEL_MANAGER, "get_cached_config_path", return_value=str(config_path)),
                  mock.patch.object(MODEL_MANAGER, "download_queue") as tasks):
                for path, status in (("models/unknown/model.pt", 400), ("models/loras/model.safetensors", 200)):
                    entry["local_path"] = path
                    config_path.write_text(json.dumps({"models": [entry]}))
                    _args, kwargs = asyncio.run(MODEL_MANAGER.download_model(request))
                    self.assertEqual(kwargs.get("status", 200), status)
                tasks.put.assert_called_once_with(("MIUProject/VNCCS", "Test", entry))
                tasks.reset_mock()
                target = root / entry["local_path"]
                target.parent.mkdir(parents=True)
                target.write_bytes(b"installed")
                _args, kwargs = asyncio.run(MODEL_MANAGER.download_model(request))
                self.assertEqual(kwargs["status"], 409)
                tasks.put.assert_not_called()
                self.assertEqual(target.read_bytes(), b"installed")

    def test_model_paths_require_known_folders_and_reject_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            models = Path(directory) / "models"
            models.mkdir()
            outside = Path(directory) / "outside"
            outside.mkdir()
            (models / "loras").symlink_to(outside, target_is_directory=True)
            with mock.patch.object(MODEL_MANAGER.folder_paths, "models_dir", str(models)):
                for path in ("models/unknown/file.pt", "models/file.pt", "models/vae",
                             "models/loras/file.pt", "models/vae/../file.pt", "models/vae/.. /file.pt",
                             "models/vae/C:payload.pt", "C:/models/vae/file.pt",
                             "//host/models/vae/file.pt", "models/vae/file.pt:stream"):
                    with self.subTest(path=path), self.assertRaises(ValueError):
                        MODEL_MANAGER.resolve_model_local_path(path)
                self.assertEqual(MODEL_MANAGER.resolve_model_local_path(r"models\vae\sub\file.pt"),
                                 str(models.resolve() / "vae" / "sub" / "file.pt"))

    def _run_download(self, directory, *, existing=False, race=False, broken_symlink=False):
        root = Path(directory)
        target = root / "models" / "loras" / "model.safetensors"
        target.parent.mkdir(parents=True)
        if existing:
            target.write_bytes(b"installed")
        if broken_symlink:
            target.symlink_to("missing.safetensors")
        cached = root / "cached.safetensors"
        cached.write_bytes(b"downloaded")

        def download(**_kwargs):
            if race:
                target.write_bytes(b"installed during download")
            return str(cached)

        tasks = queue.Queue()
        tasks.put(("MIUProject/VNCCS", "Test", {
            "hf_path": "model.safetensors", "local_path": "models/loras/model.safetensors", "version": "1",
        }))
        tasks.put(None)
        with (mock.patch.object(MODEL_MANAGER, "download_queue", tasks),
              mock.patch.object(MODEL_MANAGER.folder_paths, "models_dir", str(root / "models")),
              mock.patch.object(MODEL_MANAGER, "hf_hub_download", side_effect=download) as fetch,
              mock.patch.object(MODEL_MANAGER, "update_installed_version") as registry):
            MODEL_MANAGER.worker_loop()
        self.assertEqual(list(target.parent.glob("*.tmp.*")), [])
        return target.read_bytes() if target.is_file() else None, fetch, registry

    def test_download_installs_new_file_and_records_version(self):
        with tempfile.TemporaryDirectory() as directory:
            contents, fetch, registry = self._run_download(directory)
        self.assertEqual(contents, b"downloaded")
        fetch.assert_called_once()
        registry.assert_called_once_with("Test", "1", "MIUProject/VNCCS")

    def test_download_never_replaces_an_existing_file_even_during_a_race(self):
        for race in (False, True):
            with self.subTest(race=race), tempfile.TemporaryDirectory() as directory:
                contents, fetch, registry = self._run_download(directory, existing=not race, race=race)
                self.assertEqual(contents, b"installed during download" if race else b"installed")
                if not race:
                    fetch.assert_not_called()
                registry.assert_not_called()
                self.assertEqual(MODEL_MANAGER.download_status["Test"]["status"], "error")

    def test_download_preserves_an_existing_dangling_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            _contents, fetch, registry = self._run_download(directory, broken_symlink=True)
            target = Path(directory) / "models/loras/model.safetensors"
            self.assertTrue(target.is_symlink())
            self.assertFalse(target.exists())
        fetch.assert_not_called()
        registry.assert_not_called()

    def test_download_url_credentials_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Credentials"):
            MODEL_MANAGER.validate_download_url("https://user" + ":password@models.example/file")

    def test_non_global_address_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Private or local"):
            MODEL_MANAGER.validate_download_url("https://100.64.0.1/file")

    def test_direct_url_host_match_is_exact(self):
        self.assertTrue(MODEL_MANAGER._download_url_is_host("https://civitai.com/api/download", "civitai.com"))
        self.assertTrue(MODEL_MANAGER._download_url_is_host("https://www.civitai.com/models/1", "civitai.com"))
        self.assertFalse(MODEL_MANAGER._download_url_is_host("https://attacker.example/civitai.com", "civitai.com"))
        self.assertFalse(MODEL_MANAGER._download_url_is_host("https://evilcivitai.com/models/1", "civitai.com"))

    def test_download_status_is_isolated_by_repository(self):
        MODEL_MANAGER._set_download_status("org/one", "shared", {"status": "downloading", "progress": 25})
        MODEL_MANAGER._set_download_status("org/two", "shared", {"status": "success"})

        self.assertEqual(MODEL_MANAGER._download_status_snapshot("org/one")["shared"]["progress"], 25)
        self.assertEqual(MODEL_MANAGER._download_status_snapshot("org/two")["shared"]["status"], "success")
        self.assertEqual(MODEL_MANAGER._download_status_snapshot()["shared"]["status"], "success")

    def test_installed_registry_is_repository_aware_and_atomically_written(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            registry_path = Path(temp_dir) / "vnccs_installed_models.json"
            with mock.patch.object(MODEL_MANAGER, "resolve_path", return_value=str(registry_path)):
                MODEL_MANAGER.update_installed_version("shared", "1.0", "org/one")
                MODEL_MANAGER.update_installed_version("shared", "2.0", "org/two")
                registry = json.loads(registry_path.read_text())
                temp_files = list(registry_path.parent.glob("*.tmp.*"))

        self.assertEqual(MODEL_MANAGER.get_registered_version(registry, "org/one", "shared"), "1.0")
        self.assertEqual(MODEL_MANAGER.get_registered_version(registry, "org/two", "shared"), "2.0")
        self.assertEqual(temp_files, [])


if __name__ == "__main__":
    unittest.main()
