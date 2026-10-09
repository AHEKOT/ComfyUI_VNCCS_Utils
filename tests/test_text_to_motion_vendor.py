"""Vendored ARDY support: config loading without Hydra, downloads, encoder pieces.

The pure-Python parts run everywhere; building vendored classes needs torch and the
packages ComfyUI ships (einops, transformers, ...) and is skipped without them.
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
FOLDER = ROOT / "nodes" / "posestudio" / "ttm"


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


class ConfigResolveTests(unittest.TestCase):
    def test_references_are_resolved(self):
        cfg = {"checkpoint_dir": "/m/ardy", "a": {"b": 3}, "ckpt": "${checkpoint_dir}/denoiser.safetensors",
               "same": "${a.b}", "list": ["${a.b}", "x${a.b}"]}
        out = CONFIG.resolve(cfg)
        self.assertEqual(out["ckpt"], "/m/ardy/denoiser.safetensors")
        self.assertEqual(out["same"], 3)  # a whole-string reference keeps the value's type
        self.assertEqual(out["list"], [3, "x3"])

    def test_checkpoint_select_references_are_resolved(self):
        cfg = {"checkpoint_dir": "/m/ardy", "steps": [10],
               "autoencoder": {"ckpt_path": "${oc.select:checkpoint_dir}/tokenizer.safetensors"},
               "denoiser": {"ckpt_path": "${oc.select:checkpoint_dir}/denoiser.safetensors",
                            "stats_path": "${oc.select:checkpoint_dir}/stats/motion/"},
               "same": "${oc.select:steps.0}", "alias": "${oc.select:same}",
               "absent": "${oc.select:missing.key}"}
        out = CONFIG.resolve(cfg)
        self.assertEqual(out["autoencoder"]["ckpt_path"], "/m/ardy/tokenizer.safetensors")
        self.assertEqual(out["denoiser"]["ckpt_path"], "/m/ardy/denoiser.safetensors")
        self.assertEqual(out["denoiser"]["stats_path"], "/m/ardy/stats/motion/")
        self.assertEqual(out["same"], 10)
        self.assertEqual(out["alias"], 10)
        self.assertIsNone(out["absent"])
        self.assertEqual(cfg["same"], "${oc.select:steps.0}")

    def test_bad_references_are_refused(self):
        with self.assertRaises(CONFIG.ConfigError):
            CONFIG.resolve({"a": "${missing.key}"})
        with self.assertRaises(CONFIG.ConfigError):
            CONFIG.resolve({"a": "${oc.env:HOME}"})
        with self.assertRaises(CONFIG.ConfigError):
            CONFIG.resolve({"a": "${b}", "b": "${a}"})
        with self.assertRaises(CONFIG.ConfigError):
            CONFIG.resolve({"a": "${oc.select:a}"})
        with self.assertRaises(CONFIG.ConfigError):
            CONFIG.resolve({"a": "${oc.select:missing,fallback}"})
        with self.assertRaises(CONFIG.ConfigError):
            CONFIG.resolve({"a": "${oc.select:b}", "b": "${oc.env:HOME}"})


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
        for target in ("os.system", "builtins.eval", "subprocess.Popen", "ardy.model.parts.missing", "other.model.Part", "Part"):
            with self.assertRaises(CONFIG.ConfigError, msg=target):
                CONFIG.instantiate({"_target_": target}, self.registry)




@unittest.skipUnless(_has("torch", "einops", "transformers", "safetensors", "pydantic"), "needs ComfyUI's packages")
class VendoredModelTests(unittest.TestCase):
    def test_skeletons_build_from_config_with_bundled_assets(self):
        loaders = _load("loaders")
        loaders._import_family("ardy")
        ardy = CONFIG.instantiate({"_target_": "ardy.skeleton.CoreSkeleton27"},
                                  CONFIG.TargetRegistry(f"{PACKAGE}.vendor", ("ardy",)))
        self.assertEqual(len(ardy.bone_order_names), 27)
        self.assertEqual(tuple(ardy.neutral_joints.shape), (27, 3))
    def test_text_encoder_is_bidirectional(self):
        import torch
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



def _save_encoder_fixture(state, path):
    """Write a tiny native INT4 fixture for loader regression tests."""
    from comfy_kitchen.tensor import TensorCoreConvRotW4A4Layout as Layout
    from safetensors.torch import save_file

    tensors, mapping = {}, {}
    for name, value in state.items():
        if value.ndim == 2 and name.endswith("weight") and value.shape[1] % 64 == 0:
            data, params = Layout.quantize(value.float(), convrot_groupsize=64, stochastic_rounding=0)
            tensors[name] = data
            tensors[name + "_scale"] = params.scale
            mapping[name] = {"shape": list(value.shape), "group_size": 64,
                             "dtype": str(value.dtype).removeprefix("torch.")}
        else:
            tensors[name] = value
    save_file(tensors, str(path), metadata={"format": _load("convrot").FORMAT,
                                           "quantization_map": json.dumps(mapping)})


@unittest.skipUnless(_has("torch", "safetensors", "comfy_kitchen"), "ConvRot tensor dependencies unavailable")
class ConvRotTests(unittest.TestCase):

    @unittest.skipUnless(_has("transformers"), "transformers unavailable")
    def test_compact_llama_materializes_rotary_buffers_and_runs(self):
        import torch
        from transformers import LlamaConfig, LlamaModel

        convrot = _load("convrot")
        config = LlamaConfig(hidden_size=64, intermediate_size=128, num_hidden_layers=1,
                             num_attention_heads=4, num_key_value_heads=2, vocab_size=128)
        original = LlamaModel(config).to(dtype=torch.bfloat16)
        with tempfile.TemporaryDirectory() as folder:
            config.save_pretrained(folder)
            _save_encoder_fixture(original.state_dict(), Path(folder) / "model.safetensors")
            with mock.patch("transformers.AutoTokenizer.from_pretrained", return_value=mock.Mock(eos_token="eos")):
                encoder = _load("llm2vec_encoder").LLM2VecEncoder(folder, llm_dim=64, device="cpu")
            encoder.model.to("cpu")
            self.assertTrue(all(buffer.device.type == "cpu" for buffer in encoder.model.buffers()))
            with torch.no_grad():
                hidden = encoder.model(input_ids=torch.tensor([[3, 7, 3]])).last_hidden_state
            self.assertEqual(tuple(hidden.shape), (1, 3, 64))
            self.assertTrue(torch.isfinite(hidden).all())

    def test_packed_checkpoint_restores_linear_and_requested_embedding_rows(self):
        import torch
        from comfy_kitchen.tensor import TensorCoreConvRotW4A4Layout as Layout

        convrot = _load("convrot")
        torch.manual_seed(9)
        weight = torch.randn(16, 64)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "model.safetensors"
            _save_encoder_fixture({"weight": weight, "bias": torch.zeros(16)}, path)
            state = convrot.load_state(path)
        self.assertEqual(state["weight"]._qdata.numel(), weight.numel() // 2)
        model = torch.nn.Linear(64, 16)
        convrot.assign_state(model, state)
        model.to("cpu")
        x = torch.randn(2, 64)
        self.assertTrue(torch.isfinite(model(x)).all())
        self.assertEqual(tuple(model(x).shape), (2, 16))
        decoded = Layout.dequantize(model.weight._qdata, model.weight._params)
        self.assertLess(float((decoded - weight).square().mean()), .06)

        holder = torch.nn.Module()
        holder.embed_tokens = torch.nn.Embedding(16, 64)
        convrot.compact_embedding(holder)
        convrot.assign_state(holder, {"embed_tokens.weight": state["weight"]})
        ids = torch.tensor([[3, 7, 3]])
        torch.testing.assert_close(holder.embed_tokens(ids), decoded[ids])
        holder.to(dtype=torch.bfloat16)
        self.assertEqual(holder.embed_tokens.weight._qdata.dtype, torch.int8)
        self.assertTrue(torch.isfinite(holder.embed_tokens(ids)).all())


    def test_plain_checkpoint_is_not_quantized_implicitly(self):
        import torch
        from safetensors.torch import save_file

        convrot = _load("convrot")
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "model.safetensors"
            original = {"weight": torch.randn(4, 8)}
            save_file(original, str(path))
            restored = convrot.load_state(path)
        torch.testing.assert_close(restored["weight"], original["weight"])
        self.assertIsInstance(restored["weight"], torch.Tensor)

class BF16MotionTests(unittest.TestCase):
    def test_bf16_motion_overrides_both_checkpoint_paths_without_download(self):
        loaders = _load("loaders")
        config = {"denoiser": {"ckpt_path": "old-denoiser"}, "autoencoder": {"ckpt_path": "old-decoder"}}
        built = mock.Mock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "config.yaml").write_text("{}")
            with mock.patch.object(loaders, "_import_family"), mock.patch.object(loaders.config_loader, "load_yaml", return_value=config), \
                 mock.patch.object(loaders.config_loader, "instantiate", return_value=built) as instantiate:
                loaders.motion_model("ardy", "nvidia/ARDY", root, "cuda", "encoder", compact_dir=root, motion_precision="bf16")
            resolved = instantiate.call_args.args[0]
            self.assertEqual(resolved["denoiser"]["ckpt_path"], str(root / "motion.bf16.safetensors"))
            self.assertEqual(resolved["autoencoder"]["ckpt_path"], str(root / "motion.bf16.safetensors"))
            self.assertEqual(built.text_encoder, "encoder")

    @unittest.skipUnless(_has("torch"), "needs torch")
    def test_bf16_assignment_keeps_checkpoint_dtype_and_values(self):
        import torch

        convrot = _load("convrot")
        layer = torch.nn.Linear(4, 3)
        state = {"weight": torch.arange(12, dtype=torch.bfloat16).reshape(3, 4), "bias": torch.zeros(3, dtype=torch.bfloat16)}
        convrot.assign_state(layer, state)
        self.assertEqual(layer.weight.dtype, torch.bfloat16)
        self.assertEqual(layer.bias.dtype, torch.bfloat16)
        torch.testing.assert_close(layer.weight, state["weight"], rtol=0, atol=0)


if __name__ == "__main__":
    unittest.main()
