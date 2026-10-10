"""Auto-downloads use fixed revisions, including their progress fallback path."""

import contextlib
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from unittest import mock

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("loader", ["load_model", "birefnet_mask"])
@pytest.mark.parametrize("retry", [False, True])
def test_model_snapshot_uses_pinned_revision_on_every_attempt(tmp_path, monkeypatch, loader, retry):
    package_name = "vnccs_snapshot_security_test"
    package = ModuleType(package_name)
    package.__path__ = []
    package.progress = SimpleNamespace(update=mock.Mock(), SnapshotDownloadTqdm=object,
                                       download_phase=lambda *_args: contextlib.nullcontext())
    processing = ModuleType(f"{package_name}.processing")
    processing.__path__ = []
    calls = []

    def download(**kwargs):
        calls.append(kwargs)
        if retry and len(calls) == 1:
            raise RuntimeError("progress unavailable")
        (Path(kwargs["local_dir"]) / "config.json").write_text("{}")

    stubs = {package_name: package, processing.__name__: processing,
             "folder_paths": SimpleNamespace(models_dir=str(tmp_path)),
             "huggingface_hub": SimpleNamespace(snapshot_download=download), "cv2": ModuleType("cv2")}
    for name, value in stubs.items():
        monkeypatch.setitem(sys.modules, name, value)
    spec = importlib.util.spec_from_file_location(f"{processing.__name__}.{loader}",
                                                  ROOT / "vnccs_sam3d/processing" / f"{loader}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if loader == "load_model":
        with mock.patch.object(module, "_resolve_device", return_value="cpu"):
            module.LoadSAM3DBodyModel().load_model("CPU")
        expected_repo = "jetjodh/sam-3d-body-dinov3"
    else:
        module._ensure_snapshot()
        expected_repo = "ZhengPeng7/BiRefNet_lite"
    assert len(calls) == (2 if retry else 1)
    for call in calls:
        assert call["repo_id"] == expected_repo
        assert len(call["revision"]) == 40 and all(char in "0123456789abcdef" for char in call["revision"])
        assert call["token"] is False
    assert len({call["revision"] for call in calls}) == 1
