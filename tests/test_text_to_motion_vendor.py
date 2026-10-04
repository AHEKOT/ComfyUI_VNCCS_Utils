"""Vendored ARDY / Kimodo support: config loading without Hydra, downloads, encoder pieces.

The pure-Python parts run everywhere; building vendored classes needs torch and the
packages ComfyUI ships (einops, scipy, transformers, ...) and is skipped without them.
"""

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "vnccs_t2m_vendor_test"
FOLDER = ROOT / "api" / "text_to_motion"


def _load(name):
    if PACKAGE not in sys.modules:
        spec = importlib.util.spec_from_file_location(PACKAGE, FOLDER / "__init__.py", submodule_search_locations=[str(FOLDER)])
        package = importlib.util.module_from_spec(spec)
        sys.modules[PACKAGE] = package
        spec.loader.exec_module(package)
        vendor = importlib.util.spec_from_file_location(
            f"{PACKAGE}.vendor", FOLDER / "vendor" / "__init__.py", submodule_search_locations=[str(FOLDER / "vendor")],
        )
        module = importlib.util.module_from_spec(vendor)
        sys.modules[vendor.name] = module
        vendor.loader.exec_module(module)
    full = f"{PACKAGE}.vendor.{name}"
    if full in sys.modules:
        return sys.modules[full]
    spec = importlib.util.spec_from_file_location(full, FOLDER / "vendor" / f"{name.replace('.', '/')}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[full] = module
    spec.loader.exec_module(module)
    return module


def _has(*modules):
    return all(importlib.util.find_spec(name) is not None for name in modules)


CONFIG = _load("config_loader")
HUB = _load("hub")


class ConfigResolveTests(unittest.TestCase):
    def test_references_are_resolved(self):
        cfg = {"checkpoint_dir": "/m/ardy", "a": {"b": 3}, "ckpt": "${checkpoint_dir}/denoiser.safetensors",
               "same": "${a.b}", "list": ["${a.b}", "x${a.b}"]}
        out = CONFIG.resolve(cfg)
        self.assertEqual(out["ckpt"], "/m/ardy/denoiser.safetensors")
        self.assertEqual(out["same"], 3)  # a whole-string reference keeps the value's type
        self.assertEqual(out["list"], [3, "x3"])

    def test_bad_references_are_refused(self):
        with self.assertRaises(CONFIG.ConfigError):
            CONFIG.resolve({"a": "${missing.key}"})
        with self.assertRaises(CONFIG.ConfigError):
            CONFIG.resolve({"a": "${oc.env:HOME}"})
        with self.assertRaises(CONFIG.ConfigError):
            CONFIG.resolve({"a": "${b}", "b": "${a}"})


class InstantiateTests(unittest.TestCase):
    def setUp(self):
        # A fake vendored module tree: <vendor>.ardy.model.parts with two classes.
        self.vendor = f"{PACKAGE}.fakevendor"
        module = types.ModuleType(f"{self.vendor}.ardy.model.parts")

        class Part:
            def __init__(self, size, child=None, *, device=None):
                self.size, self.child, self.device = size, child, device

        Part.__module__ = module.__name__
        module.Part = Part
        sys.modules[module.__name__] = module
        self.addCleanup(sys.modules.pop, module.__name__, None)
        self.registry = CONFIG.TargetRegistry(self.vendor, ("ardy",))
        self.Part = Part

    def test_nested_targets_build_vendored_classes(self):
        cfg = {"_target_": "ardy.model.parts.Part", "size": 2, "device": "cpu",
               "child": {"_target_": "ardy.model.Part", "size": 1}}  # package-level alias resolves too
        built = CONFIG.instantiate(cfg, self.registry)
        self.assertIsInstance(built, self.Part)
        self.assertEqual((built.size, built.device, built.child.size), (2, "cpu", 1))

    def test_partial_and_plain_dicts(self):
        factory = CONFIG.instantiate({"_target_": "ardy.model.parts.Part", "_partial_": True, "size": 5}, self.registry)
        self.assertEqual(factory().size, 5)
        self.assertEqual(CONFIG.instantiate({"x": [1, {"y": 2}]}, self.registry), {"x": [1, {"y": 2}]})

    def test_targets_outside_the_vendored_code_are_refused(self):
        for target in ("os.system", "builtins.eval", "subprocess.Popen", "ardy.model.parts.missing", "kimodo.model.Part", "Part"):
            with self.assertRaises(CONFIG.ConfigError, msg=target):
                CONFIG.instantiate({"_target_": target}, self.registry)


class HubTests(unittest.TestCase):
    def install_hub(self, files, fail=None):
        calls = []

        class Api:
            def __init__(self, token=None):
                calls.append(("token", token))

            def list_repo_files(self, repo_id, revision="main"):
                return list(files)

        def download(repo_id, filename, revision, local_dir, token):
            calls.append(("download", filename, token))
            if fail and filename == fail:
                raise RuntimeError("401 gated")
            path = Path(local_dir) / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("x")
            return str(path)

        hub = types.ModuleType("huggingface_hub")
        hub.HfApi, hub.hf_hub_download = Api, download
        patcher = mock.patch.dict(sys.modules, {"huggingface_hub": hub})
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def test_downloads_listed_files_without_credentials(self):
        calls = self.install_hub(["config.yaml", "README.md", "weights/a.safetensors", "tokenizer.json"])
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "repo"
            HUB.ensure_repo("nvidia/X", target, include=("config.yaml", "weights/*"))
            self.assertTrue((target / "weights" / "a.safetensors").is_file())
            self.assertFalse((target / "tokenizer.json").exists())
            self.assertTrue((target / ".complete").is_file())
            self.assertIn(("token", False), calls)
            self.assertTrue(all(call[2] is False for call in calls if call[0] == "download"))
            count = len(calls)
            HUB.ensure_repo("nvidia/X", target)  # complete: nothing is fetched again
            self.assertEqual(len(calls), count)

    def test_gated_repos_explain_the_manual_route(self):
        self.install_hub(["model.safetensors"], fail="model.safetensors")
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(HUB.DownloadError) as caught:
                HUB.ensure_repo("meta/Gated", Path(folder) / "g")
            self.assertIn(".complete", str(caught.exception))

    def test_unsafe_names_are_refused(self):
        self.install_hub(["../escape.txt"])
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(HUB.DownloadError):
            HUB.ensure_repo("x/y", Path(folder) / "r")


@unittest.skipUnless(_has("torch", "einops", "scipy", "transformers", "safetensors", "pydantic"), "needs ComfyUI's packages")
class VendoredModelTests(unittest.TestCase):
    def test_skeletons_build_from_config_with_bundled_assets(self):
        loaders = _load("loaders")
        loaders._import_family("ardy")
        loaders._import_family("kimodo")
        ardy = CONFIG.instantiate({"_target_": "ardy.skeleton.CoreSkeleton27"},
                                  CONFIG.TargetRegistry(f"{PACKAGE}.vendor", ("ardy",)))
        self.assertEqual(len(ardy.bone_order_names), 27)
        self.assertEqual(tuple(ardy.neutral_joints.shape), (27, 3))
        soma = CONFIG.instantiate({"_target_": "kimodo.skeleton.SOMASkeleton30"},
                                  CONFIG.TargetRegistry(f"{PACKAGE}.vendor", ("kimodo",)))
        self.assertEqual(len(soma.bone_order_names), 30)

    def test_text_encoder_is_bidirectional_and_merges_lora(self):
        import torch
        from safetensors.torch import save_file
        from transformers import LlamaConfig, LlamaModel

        enc = _load("llm2vec_encoder")
        torch.manual_seed(0)
        config = LlamaConfig(vocab_size=50, hidden_size=32, intermediate_size=64, num_hidden_layers=2,
                             num_attention_heads=4, num_key_value_heads=4)
        model = LlamaModel._from_config(config, attn_implementation="sdpa").eval()
        enc.make_bidirectional(model)
        ids = torch.tensor([[1, 5, 7, 9, 11]])
        mask = enc.full_attention_mask(torch.ones_like(ids), torch.float32)
        first = model(input_ids=ids, attention_mask=mask).last_hidden_state[0, 0]
        ids[0, -1] = 3
        second = model(input_ids=ids, attention_mask=mask).last_hidden_state[0, 0]
        self.assertFalse(torch.allclose(first, second), "the first token must see later tokens")

        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            (folder / "adapter_config.json").write_text(json.dumps({"r": 4, "lora_alpha": 8}))
            a, b = torch.randn(4, 32), torch.randn(64, 4)
            prefix = "base_model.model.model.layers.0.mlp.up_proj"
            save_file({f"{prefix}.lora_A.weight": a, f"{prefix}.lora_B.weight": b}, str(folder / "adapter_model.safetensors"))
            before = model.layers[0].mlp.up_proj.weight.clone()
            enc.merge_lora(model, folder)
            self.assertTrue(torch.allclose(model.layers[0].mlp.up_proj.weight, before + b @ a * 2, atol=1e-5))


if __name__ == "__main__":
    unittest.main()
