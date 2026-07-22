import hashlib
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "api" / "img2threejs_studio.py"
HAS_AIOHTTP = importlib.util.find_spec("aiohttp") is not None

if HAS_AIOHTTP:
    from aiohttp import web


def load_module():
    if not HAS_AIOHTTP:
        aiohttp_stub = types.ModuleType("aiohttp")
        aiohttp_stub.ClientSession = object
        aiohttp_stub.ClientTimeout = object
        aiohttp_stub.web = types.SimpleNamespace(
            Request=object,
            Response=object,
            StreamResponse=object,
            Application=object,
            HTTPException=Exception,
            json_response=lambda *args, **kwargs: None,
            FileResponse=lambda *args, **kwargs: None,
        )
        sys.modules["aiohttp"] = aiohttp_stub
    spec = importlib.util.spec_from_file_location("vnccs_img2threejs_backend_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves postponed annotations through sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Img2ThreeJSBackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def test_skill_prompt_is_loaded_verbatim(self):
        expected = (ROOT / "img2threejs" / "SKILL.md").read_bytes()
        actual = self.module.load_skill_text().encode("utf-8")
        self.assertEqual(actual, expected)
        self.assertEqual(
            hashlib.sha256(actual).hexdigest(),
            "cc76b86304c1dd57a4eb6b552ccd0e62168ebc18960c1a8a07f9d1422487d372",
        )

    def test_prompt_transport_uses_controls_without_leaking_secrets(self):
        prompt = self.module._build_prompt(
            {
                "prompt": "Build a prop",
                "negative_prompt": "no floating parts",
                "review_cycles": 3,
                "texture_projection": True,
                "api_key": "secret-do-not-copy",
            },
            refining=False,
        )
        self.assertTrue(prompt.startswith(self.module.load_skill_text()))
        self.assertIn('"self_review_cycles":3', prompt)
        self.assertIn('"projection_assisted_texture":true', prompt)
        self.assertNotIn("secret-do-not-copy", prompt)

    def test_scene_normalization_matches_upstream_layers_and_exact_ids(self):
        scene = self.module.normalize_scene_spec(
            {
                "materials": [
                    {"id": "hidden", "opacity": {"base": 0}},
                    {"id": "card", "doubleSided": True},
                    {"id": "a b", "color": "#112233"},
                    {"id": "a-b", "color": "#445566"},
                ],
                "components": [
                    {"id": "a b", "material": "a b"},
                    {"id": "a-b", "material": "a-b"},
                    {"id": "child", "parent": "a b", "material": "hidden"},
                ],
                "camera": {"up": [0, 0, 1]},
            }
        )
        self.assertEqual(scene["materials"][0]["opacity"], 0)
        self.assertEqual(scene["materials"][1]["side"], "double")
        self.assertEqual(scene["components"][0]["materialId"], "a-b")
        self.assertEqual(scene["components"][1]["materialId"], "a-b-2")
        self.assertEqual(scene["components"][2]["parentId"], "a-b")
        self.assertEqual(scene["camera"]["up"], [0, 1, 0])

    def test_paths_endpoints_and_metadata_are_confined_and_redacted(self):
        with self.assertRaises(ValueError):
            self.module.resolve_project_dir("../../outside")
        with self.assertRaises(ValueError):
            self.module._endpoint("file:///tmp/model", "", "/responses", "openai")
        with self.assertRaises(ValueError):
            self.module._endpoint("http://api.openai.com/v1", "", "/responses", "openai")
        with self.assertRaises(ValueError):
            self.module._endpoint("https://user:password@example.com", "", "/responses", "openai")
        with self.assertRaises(ValueError):
            self.module._endpoint("https://unapproved.example", "", "/responses", "openai")
        redacted = self.module._without_secrets(
            {"provider": {"api_key": "secret", "model": "model-a"}, "token": "secret"}
        )
        self.assertEqual(redacted, {"provider": {"model": "model-a"}})

    def test_windows_codex_discovers_native_executable_from_path(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "codex.exe"
            executable.write_bytes(b"MZ")
            launch = self.module._cli_launch(
                "codex_cli",
                platform="nt",
                environ={},
                path_lookup=lambda name: str(executable) if name == "codex.exe" else None,
            )
        self.assertIsNotNone(launch)
        self.assertEqual(launch.argv, (str(executable.resolve()),))
        self.assertEqual(launch.discovery, "PATH")

    def test_windows_codex_discovers_npm_install_without_comfyui_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            npm_root = root / "AppData" / "Roaming" / "npm"
            script = npm_root / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
            node = root / "Program Files" / "nodejs" / "node.exe"
            script.parent.mkdir(parents=True)
            node.parent.mkdir(parents=True)
            script.write_text("// codex", encoding="utf-8")
            node.write_bytes(b"MZ")
            launch = self.module._cli_launch(
                "codex_cli",
                platform="nt",
                environ={"USERPROFILE": str(root), "APPDATA": str(root / "AppData" / "Roaming"),
                         "ProgramFiles": str(root / "Program Files")},
                path_lookup=lambda _name: None,
            )
        self.assertIsNotNone(launch)
        self.assertEqual(launch.argv, (str(node.resolve()), str(script.resolve())))
        self.assertEqual(launch.discovery, "Windows npm")

    def test_windows_codex_discovers_ide_extension_without_comfyui_path(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory)
            executable = profile / ".vscode" / "extensions" / "openai.chatgpt-26.1.0" / "bin" / "windows-x86_64" / "codex.exe"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"MZ")
            launch = self.module._cli_launch(
                "codex_cli",
                platform="nt",
                environ={"USERPROFILE": str(profile)},
                path_lookup=lambda _name: None,
            )
        self.assertIsNotNone(launch)
        self.assertEqual(launch.argv, (str(executable.resolve()),))
        self.assertEqual(launch.discovery, "IDE extension")

    def test_cli_missing_error_explains_server_process_and_override(self):
        message = self.module._cli_missing_message("codex_cli")
        self.assertIn("ComfyUI server process", message)
        self.assertIn("VNCCS_CODEX_CLI", message)

    def test_codex_capability_distinguishes_binary_from_authenticated_session(self):
        launch = self.module.CliLaunch(("codex",), "codex", "PATH")
        self.module._CODEX_AUTH_CACHE.clear()
        result = types.SimpleNamespace(returncode=1, stdout=b"Not logged in")
        with patch.object(self.module.subprocess, "run", return_value=result):
            authenticated, diagnostic = self.module._codex_auth_status(launch)
        self.assertFalse(authenticated)
        self.assertIn("Not logged in", diagnostic)

    def test_cli_failure_keeps_a_redacted_log_tail_for_the_job_and_ui(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            stdout = project / "stdout.log"
            stderr = project / "stderr.log"
            stdout.write_text("unused stdout", encoding="utf-8")
            stderr.write_text("first line\nAPI_KEY=sk-example123456789\nactual failure", encoding="utf-8")
            message = self.module._cli_failure_message("codex_cli", 1, stdout, stderr, project)
        self.assertIn("Codex CLI exited with status 1", message)
        self.assertIn("actual failure", message)
        self.assertIn("\n", message)
        self.assertNotIn("sk-example", message)

    def test_cli_run_persists_human_readable_provider_log(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            stdout = project / "stdout.log"
            stderr = project / "stderr.log"
            stdout.write_text("final provider output", encoding="utf-8")
            stderr.write_text("provider warning", encoding="utf-8")
            self.module._write_cli_log(project, "codex_cli", ["codex", "exec", "-"], 1, stdout, stderr)
            log = (project / "provider.log").read_text(encoding="utf-8")
        self.assertIn("provider: codex_cli", log)
        self.assertIn("exit_code: 1", log)
        self.assertIn("provider warning", log)
        self.assertIn("final provider output", log)

    def test_windows_codex_child_environment_keeps_auth_paths_but_drops_unrelated_values(self):
        child = self.module._cli_child_environment(
            "codex_cli",
            {
                "Path": r"C:\\Tools",
                "USERPROFILE": r"C:\\Users\\RDP",
                "APPDATA": r"C:\\Users\\RDP\\AppData\\Roaming",
                "LOCALAPPDATA": r"C:\\Users\\RDP\\AppData\\Local",
                "SystemRoot": r"C:\\Windows",
                "CODEX_HOME": r"C:\\Users\\RDP\\.codex",
                "UNRELATED_SECRET": "do-not-forward",
            },
        )
        self.assertEqual(child["USERPROFILE"], r"C:\\Users\\RDP")
        self.assertEqual(child["APPDATA"], r"C:\\Users\\RDP\\AppData\\Roaming")
        self.assertEqual(child["SystemRoot"], r"C:\\Windows")
        self.assertEqual(child["CODEX_HOME"], r"C:\\Users\\RDP\\.codex")
        self.assertNotIn("UNRELATED_SECRET", child)

    def test_native_llama_server_supports_path_and_explicit_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "llama-server.exe"
            executable.write_bytes(b"MZ")
            from_path = self.module._llama_server_launch(
                platform="nt",
                environ={},
                path_lookup=lambda name: str(executable) if name == "llama-server.exe" else None,
                package_root=Path(directory),
            )
            explicit = self.module._llama_server_launch(
                platform="nt",
                environ={"VNCCS_LLAMA_SERVER": str(executable)},
                path_lookup=lambda _name: None,
                package_root=Path(directory),
            )
        self.assertEqual(from_path.discovery, "PATH")
        self.assertEqual(explicit.discovery, "VNCCS_LLAMA_SERVER")

    def test_native_local_inference_uses_libmtmd_without_architecture_whitelist(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        inference = source.split("def _native_llama_inference", 1)[1].split("async def _run_provider", 1)[0]
        self.assertIn('"--mmproj"', inference)
        self.assertIn("/v1/chat/completions", inference)
        self.assertNotIn("qwen25_vl", inference)
        self.assertNotIn("llava15", inference)

    def test_local_model_catalog_includes_comfyui_llm_tree_and_managed_imports(self):
        original_root = self.module.MODEL_ROOT
        previous_folder_paths = sys.modules.get("folder_paths")
        try:
            with tempfile.TemporaryDirectory() as directory:
                models_dir = Path(directory) / "models"
                managed = models_dir / "LLM" / "img2threejs"
                qwen_dir = models_dir / "LLM" / "Qwen2.5-VL"
                diffusion_dir = models_dir / "diffusion_models"
                managed.mkdir(parents=True)
                qwen_dir.mkdir(parents=True)
                diffusion_dir.mkdir(parents=True)
                managed_model = managed / "imported.gguf"
                comfy_model = qwen_dir / "Qwen2.5-VL-Q4.gguf"
                comfy_mmproj = qwen_dir / "mmproj-F16.gguf"
                unrelated_diffusion = diffusion_dir / "diffusion-Q4.gguf"
                for path in (managed_model, comfy_model, comfy_mmproj, unrelated_diffusion):
                    path.write_bytes(b"GGUF")
                sys.modules["folder_paths"] = types.SimpleNamespace(
                    models_dir=str(models_dir),
                    get_folder_paths=lambda _category: [],
                )
                self.module.MODEL_ROOT = managed
                catalog = self.module._model_catalog()
                by_path = {entry.path: entry for entry in catalog}
                self.assertIn(managed_model.resolve(), by_path)
                self.assertIn(comfy_model.resolve(), by_path)
                self.assertIn(comfy_mmproj.resolve(), by_path)
                self.assertNotIn(unrelated_diffusion.resolve(), by_path)
                self.assertEqual(by_path[managed_model.resolve()].identifier, "imported.gguf")
                self.assertTrue(by_path[comfy_model.resolve()].identifier.startswith("comfy-"))
                self.assertEqual(by_path[comfy_model.resolve()].kind, "model")
                self.assertEqual(by_path[comfy_mmproj.resolve()].kind, "mmproj")
                self.assertEqual(
                    self.module._resolve_model(by_path[comfy_model.resolve()].identifier),
                    comfy_model.resolve(),
                )
        finally:
            self.module.MODEL_ROOT = original_root
            if previous_folder_paths is None:
                sys.modules.pop("folder_paths", None)
            else:
                sys.modules["folder_paths"] = previous_folder_paths

    def test_local_model_catalog_supports_registered_comfyui_llm_folder(self):
        original_root = self.module.MODEL_ROOT
        previous_folder_paths = sys.modules.get("folder_paths")
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                managed = root / "managed"
                extra = root / "extra-llm"
                managed.mkdir()
                extra.mkdir()
                external = extra / "vision-projector.gguf"
                external.write_bytes(b"GGUF")
                sys.modules["folder_paths"] = types.SimpleNamespace(
                    models_dir=str(root / "models"),
                    get_folder_paths=lambda category: [str(extra)] if category == "LLM" else [],
                )
                self.module.MODEL_ROOT = managed
                matches = [entry for entry in self.module._model_catalog() if entry.path == external.resolve()]
                self.assertEqual(len(matches), 1)
                self.assertEqual(matches[0].kind, "mmproj")
        finally:
            self.module.MODEL_ROOT = original_root
            if previous_folder_paths is None:
                sys.modules.pop("folder_paths", None)
            else:
                sys.modules["folder_paths"] = previous_folder_paths

    def test_vendored_forge_generates_source_without_executing_provider_code(self):
        scene = self.module.normalize_scene_spec(
            {
                "name": "Safety Lamp",
                "materials": [{"id": "metal", "color": "#778899"}],
                "components": [
                    {"id": "base", "primitive": "cylinder", "material": "metal"},
                    {"id": "shade", "primitive": "cone", "parent": "base", "material": "metal"},
                ],
            }
        )
        sculpt, source = self.module._sculpt_from_result({"scene_spec": scene}, scene, None)
        self.assertEqual(sculpt["targetName"], "Safety Lamp")
        self.assertIn("import * as THREE from 'three';", source)
        self.assertIn("createSafetyLampModel", source)
        self.assertNotIn("eval(", source)

    def test_empty_upstream_lists_fall_back_and_all_scene_components_are_exported(self):
        scene = self.module.normalize_scene_spec(
            {
                "name": "Detailed Prop",
                "materials": [{"id": "paint", "color": "#336699"}],
                "components": [
                    {"id": "body", "primitive": "box", "material": "paint", "level": "macro"},
                    {"id": "micro-detail", "primitive": "sphere", "parent": "body", "material": "paint", "level": "micro"},
                ],
            }
        )
        sculpt, source = self.module._sculpt_from_result(
            {"object_sculpt_spec": {"materials": [], "componentTree": []}},
            scene,
            None,
        )
        self.assertEqual(len(sculpt["materials"]), 1)
        self.assertEqual(len(sculpt["componentTree"]), 2)
        self.assertIn("micro-detail", source)

    def test_vendored_loader_does_not_leak_generic_module_names(self):
        self.module._load_vendored_modules()
        for name in ("orchestrate_passes", "feature_acceptance_policy"):
            loaded = sys.modules.get(name)
            path = Path(getattr(loaded, "__file__", "")) if loaded else None
            self.assertFalse(path and ROOT / "img2threejs" in path.parents)

    def test_route_registration_is_complete_and_idempotent(self):
        class RouteTableSpy:
            def __init__(self):
                self.definitions = []

            def _register(self, method, path):
                def decorator(handler):
                    self.definitions.append((method, path, handler))
                    return handler
                return decorator

            def get(self, path):
                return self._register("GET", path)

            def post(self, path):
                return self._register("POST", path)

        routes = RouteTableSpy()
        self.module.register_routes(routes)
        first = {(method, path) for method, path, _ in routes.definitions}
        self.module.register_routes(routes)
        second = {(method, path) for method, path, _ in routes.definitions}
        self.assertEqual(first, second)
        self.assertTrue(any(path.endswith("/capabilities") for _, path in first))
        self.assertTrue(any(path.endswith("/generate") for _, path in first))
        self.assertTrue(any(path.endswith("/cancel") for _, path in first))
        self.assertTrue(any(path.endswith("/download") for _, path in first))

    def test_comfyui_route_table_produces_modern_api_aliases(self):
        class RouteTableSpy:
            def __init__(self):
                self.definitions = []

            def _register(self, method, path):
                def decorator(handler):
                    self.definitions.append((method, path))
                    return handler
                return decorator

            def get(self, path):
                return self._register("GET", path)

            def post(self, path):
                return self._register("POST", path)

        routes = RouteTableSpy()
        self.module.register_routes(routes)
        mounted = {(method, "/api" + path) for method, path in routes.definitions}
        self.assertIn(("GET", "/api/vnccs/img2threejs/capabilities"), mounted)
        self.assertIn(("GET", "/api/vnccs/img2threejs/models"), mounted)
        self.assertIn(("POST", "/api/vnccs/img2threejs/generate"), mounted)

    def test_package_registers_on_prompt_server_route_table(self):
        package_source = (ROOT / "__init__.py").read_text(encoding="utf-8")
        marker = "# === img2threejs Studio API ==="
        section = package_source.split(marker, 1)[1]
        self.assertIn("register_routes(PromptServer.instance.routes)", section)
        self.assertNotIn("register_routes(PromptServer.instance.app)", section)


if __name__ == "__main__":
    unittest.main()
