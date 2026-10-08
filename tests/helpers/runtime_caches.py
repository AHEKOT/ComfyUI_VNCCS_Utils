"""Import production cache helpers and routes without the ComfyUI entry point."""
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def load_runtime_caches(root):
    routes = {}

    class Router:
        def get(self, path):
            return self.post(path)

        def post(self, path):
            def register(function):
                routes[path] = function
                return function
            return register

    modules = {
        "folder_paths": SimpleNamespace(get_temp_directory=lambda: str(root / "temp"),
                                        get_user_directory=lambda: str(root / "user")),
        "server": SimpleNamespace(PromptServer=SimpleNamespace(instance=SimpleNamespace(routes=Router()))),
        "aiohttp": SimpleNamespace(web=SimpleNamespace(json_response=lambda data, status=200, **_kwargs:
                                                     SimpleNamespace(data=data, status=status))),
    }
    spec = importlib.util.spec_from_file_location("vnccs_cache_test", ROOT / "api/runtime_caches.py")
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
        module._vnccs_register_pose_animation_cache()
        module._vnccs_register_unicanvas_state_cache()
    module.routes = routes
    return vars(module)
