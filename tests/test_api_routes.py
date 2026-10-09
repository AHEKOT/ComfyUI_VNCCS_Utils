"""Keep the complete pre-reorganization HTTP contract and thread boundaries."""
import asyncio
import json
import inspect
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from helpers.backend_package import service_package, stub_imports

ROOT = Path(__file__).resolve().parents[1]


class Router:
    def __init__(self):
        self.handlers = {}

    def __getattr__(self, method):
        verb = method.removeprefix("add_").upper()
        def register(path, handler=None):
            def attach(function):
                assert (verb, path) not in self.handlers
                self.handlers[verb, path] = function
                return function
            return attach(handler) if handler else attach
        return register


def load_routes(tmp_path):
    router = Router()
    load = service_package("vnccs_api_contract_test_" + tmp_path.name.replace("-", "_"))
    web = SimpleNamespace(
        json_response=lambda data, status=200, **_kw: SimpleNamespace(data=data, status=status),
        FileResponse=lambda path, **_kw: SimpleNamespace(path=path, status=200),
    )
    with stub_imports({
        "aiohttp": SimpleNamespace(web=web),
        "server": SimpleNamespace(PromptServer=SimpleNamespace(instance=SimpleNamespace(routes=router))),
        "folder_paths": SimpleNamespace(get_user_directory=lambda: str(tmp_path / "user"),
                                        get_temp_directory=lambda: str(tmp_path / "temp")),
    }):
        load("api.factory3d_scene_editor").register_routes(router)
        app = SimpleNamespace(router=router)
        load("api.pose_library").register_routes(app)
        load("api.pose_capture_sync").register_routes(app)
        caches = load("api.pose_unicanvas_caches")
        caches._vnccs_register_capture_cache()
        caches._vnccs_register_pose_animation_cache()
        caches._vnccs_register_unicanvas_state_cache()
    return router.handlers, load


def test_all_original_urls_methods_and_handler_registration_survive(tmp_path):
    handlers, _load = load_routes(tmp_path)
    expected = json.loads((ROOT / "tests/fixtures/api/routes.json").read_text())
    assert sorted(handlers) == [tuple(entry) for entry in expected]
    assert all(inspect.iscoroutinefunction(handler) for handler in handlers.values())


def test_scene_reads_and_package_lookup_run_outside_http_thread(tmp_path):
    handlers, load = load_routes(tmp_path)
    storage = load("nodes.factory3d.storage")
    library = load("nodes.factory3d.library")
    root_thread = threading.get_ident()
    calls = []
    def scene_reader(_scene_id):
        calls.append(threading.get_ident())
        return {"scene_id": "a" * 32}
    def package_reader(*_args):
        calls.append(threading.get_ident())
        return {"name": "Example"}, {"preview": Path(__file__), "package": Path(__file__)}
    request = SimpleNamespace(match_info={"scene_id": "a" * 32, "asset_id": "b" * 24}, query={})
    with mock.patch.object(storage, "load_scene", side_effect=scene_reader), mock.patch.object(storage, "_public_scene", side_effect=lambda scene: scene), mock.patch.object(library, "_find_record", side_effect=package_reader):
        asyncio.run(handlers["GET", "/vnccs/3d-factory/scenes/{scene_id}"](request))
        for kind in ("preview", "download"):
            asyncio.run(handlers["GET", "/vnccs/3d-factory/library/items/{asset_id}/" + kind](request))
    assert len(calls) == 3
    assert all(thread != root_thread for thread in calls)


def test_service_storage_roots_still_resolve_to_extension_root(tmp_path):
    _handlers, load = load_routes(tmp_path)
    pose = load("nodes.posestudio.library")
    library = load("nodes.factory3d.library")
    assert Path(pose.get_default_repositories_path()) == ROOT / "config/default_pose_repositories.json"
    assert library._repository_config_path() == ROOT / "ModelLibrary/repositories.user.json"
    assert Path(load("nodes.shared.user_config").get_vnccs_user_config_path()) == ROOT / "vnccs_user_config.json"
