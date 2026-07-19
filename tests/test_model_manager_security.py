import importlib.util
import socket
import sys
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
    requests_module = types.ModuleType("requests")
    requests_module.request = lambda *_args, **_kwargs: None
    requests_module.exceptions = types.SimpleNamespace(HTTPError=RuntimeError)

    stubs = {
        "server": server_module,
        "folder_paths": folder_paths_module,
        "huggingface_hub": huggingface_module,
        "aiohttp": aiohttp_module,
        "aiohttp.web": aiohttp_web_module,
        "requests": requests_module,
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


class _FakeResponse:
    def __init__(self, status_code, location=None):
        self.status_code = status_code
        self.headers = {} if location is None else {"location": location}
        self.closed = False

    def close(self):
        self.closed = True


class ModelManagerSecurityTests(unittest.TestCase):
    def setUp(self):
        self.resolve_public = mock.patch.object(
            MODEL_MANAGER.socket,
            "getaddrinfo",
            return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))],
        )
        self.resolve_public.start()

    def tearDown(self):
        self.resolve_public.stop()

    def test_redirect_to_private_address_is_rejected(self):
        redirect = _FakeResponse(302, "https://127.0.0.1/private")

        with self.assertRaisesRegex(ValueError, "Private or local"):
            MODEL_MANAGER.open_validated_download_stream(
                "https://models.example/file",
                request_fn=lambda *_args, **_kwargs: redirect,
            )

        self.assertTrue(redirect.closed)

    def test_cross_origin_redirect_drops_authorization(self):
        responses = [
            _FakeResponse(302, "https://cdn.example/file"),
            _FakeResponse(200),
        ]
        calls = []

        def request(*_args, **kwargs):
            calls.append({**kwargs, "headers": dict(kwargs.get("headers") or {})})
            return responses.pop(0)

        response = MODEL_MANAGER.open_validated_download_stream(
            "https://models.example/file",
            headers={"Authorization": "Bearer secret", "Accept": "application/octet-stream"},
            request_fn=request,
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls[0]["headers"]["Authorization"], "Bearer secret")
        self.assertNotIn("Authorization", calls[1]["headers"])
        self.assertEqual(calls[1]["headers"]["Accept"], "application/octet-stream")
        self.assertTrue(all(call["allow_redirects"] is False for call in calls))

    def test_unsupported_redirect_status_is_not_downloaded(self):
        response = _FakeResponse(304)

        with self.assertRaisesRegex(ValueError, "Unsupported download redirect"):
            MODEL_MANAGER.open_validated_download_stream(
                "https://models.example/file",
                request_fn=lambda *_args, **_kwargs: response,
            )

        self.assertTrue(response.closed)

    def test_download_url_credentials_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Credentials"):
            MODEL_MANAGER.validate_download_url("https://user:password@models.example/file")

    def test_non_global_address_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Private or local"):
            MODEL_MANAGER.validate_download_url("https://100.64.0.1/file")

    def test_civitai_token_host_match_is_exact(self):
        self.assertTrue(MODEL_MANAGER._download_url_is_host("https://civitai.com/api/download", "civitai.com"))
        self.assertTrue(MODEL_MANAGER._download_url_is_host("https://www.civitai.com/models/1", "civitai.com"))
        self.assertFalse(MODEL_MANAGER._download_url_is_host("https://attacker.example/civitai.com", "civitai.com"))
        self.assertFalse(MODEL_MANAGER._download_url_is_host("https://evilcivitai.com/models/1", "civitai.com"))


if __name__ == "__main__":
    unittest.main()
