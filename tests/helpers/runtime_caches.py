"""Import production cache helpers and routes without the ComfyUI entry point."""
from types import SimpleNamespace
from .backend_package import service_package, stub_imports


def load_runtime_caches(root):
    routes = {}

    class Router:
        def get(self, path):
            return self.post(path)

        def patch(self, path):
            return self.post(path)

        def delete(self, path):
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
    load = service_package("vnccs_cache_test_" + root.name.replace("-", "_"))
    with stub_imports(modules):
        pose = load("nodes.posestudio.caches")
        canvas = load("nodes.unicanvas.cache")
        build = load("nodes.unicanvas.build_info")
        api = load("api.pose_unicanvas_caches")
        api._vnccs_register_capture_cache()
        api._vnccs_register_pose_animation_cache()
        api._vnccs_register_unicanvas_state_cache()
        documents_adapter = load("api.unicanvas_documents")
    return {**vars(pose), **vars(canvas), **vars(build), **vars(api),
            "routes": routes, "pose_service": pose, "canvas_service": canvas, "build_service": build,
            "documents_adapter": documents_adapter}
