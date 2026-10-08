"""Exercise the SAM3D loader without constructing or downloading the model."""

import importlib.util
import pickle
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

import pytest


ROOT = Path(__file__).resolve().parents[1]


def loader(monkeypatch, torch_module):
    package = ModuleType("vnccs_checkpoint_test")
    package.__path__ = []
    config = SimpleNamespace(defrost=lambda: None, freeze=lambda: None,
                             MODEL=SimpleNamespace(MHR_HEAD=SimpleNamespace()))
    model = mock.Mock()
    model.to.return_value = model
    load_state = mock.Mock()
    for name, module in {
        package.__name__: package,
        f"{package.__name__}.models.meta_arch": SimpleNamespace(SAM3DBody=lambda _config: model),
        f"{package.__name__}.utils.config": SimpleNamespace(get_config=lambda _path: config),
        f"{package.__name__}.utils.checkpoint": SimpleNamespace(load_state_dict=load_state),
        "torch": torch_module,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)
    spec = importlib.util.spec_from_file_location(f"{package.__name__}.build_models",
        ROOT / "vnccs_sam3d/sam_3d_body/build_models.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, load_state


def test_sam3d_requests_restricted_checkpoint_loading(monkeypatch):
    weights = {"weight": object()}
    torch_module = SimpleNamespace(load=mock.Mock(return_value={"state_dict": weights}))
    module, load_state = loader(monkeypatch, torch_module)
    module.load_sam_3d_body("model.ckpt", device="cpu")
    torch_module.load.assert_called_once_with("model.ckpt", map_location="cpu", weights_only=True)
    assert load_state.call_args.args[1] is weights


class CheckpointProbe:
    def __reduce__(self):
        return print, ("UNSAFE_CHECKPOINT_EXECUTED",)


def test_sam3d_loads_tensor_weights_and_rejects_executable_pickle(tmp_path, monkeypatch, capsys):
    torch = pytest.importorskip("torch")
    module, load_state = loader(monkeypatch, torch)
    path = tmp_path / "model.ckpt"
    for checkpoint in ({"weight": torch.ones(2)}, {"state_dict": {"weight": torch.ones(2)}}):
        torch.save(checkpoint, path)
        module.load_sam_3d_body(str(path), device="cpu")
        assert torch.equal(load_state.call_args.args[1]["weight"], torch.ones(2))
    torch.save({"state_dict": {}, "probe": CheckpointProbe()}, path)
    with pytest.raises(pickle.UnpicklingError):
        module.load_sam_3d_body(str(path), device="cpu")
    assert "UNSAFE_CHECKPOINT_EXECUTED" not in capsys.readouterr().out
