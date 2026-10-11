"""SAM model/cache synchronization without loading PyTorch or model weights."""

import ast
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from pathlib import Path
import sys
import threading
from types import ModuleType, SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sam_lock_test.vnccs_sam3d.progress", ROOT / "vnccs_sam3d/progress.py")
progress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress)


def test_concurrent_model_loads_share_one_cached_instance(monkeypatch):
    package = ModuleType("sam_lock_test.vnccs_sam3d")
    package.__path__ = []
    package.progress = progress
    processing = ModuleType(f"{package.__name__}.processing")
    processing.__path__ = []
    for name, module in {
        package.__name__: package, processing.__name__: processing,
        "torch": ModuleType("torch"), "cv2": ModuleType("cv2"),
        f"{processing.__name__}.birefnet_mask": SimpleNamespace(auto_mask_bgr=None),
    }.items():
        monkeypatch.setitem(sys.modules, name, module)
    model_spec = importlib.util.spec_from_file_location(f"{processing.__name__}.process", ROOT / "vnccs_sam3d/processing/process.py")
    model_module = importlib.util.module_from_spec(model_spec)
    model_spec.loader.exec_module(model_module)
    backend = ModuleType("sam_lock_test.vnccs_sam3d.sam_3d_body")
    entered, release, second_started, duplicate = (threading.Event() for _ in range(4))
    calls = []

    def load(**kwargs):
        calls.append(kwargs)
        if len(calls) > 1:
            duplicate.set()
        entered.set()
        assert release.wait(3)
        return object(), {}, None

    backend.load_sam_3d_body = load
    monkeypatch.setitem(sys.modules, backend.__name__, backend)
    config = {"ckpt_path": "same.ckpt", "device": "cpu"}
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(model_module._load_sam3d_model, config)
        try:
            assert entered.wait(3)

            def second_load():
                second_started.set()
                return model_module._load_sam3d_model(config)

            second = pool.submit(second_load)
            assert second_started.wait(3)
            assert not duplicate.wait(0.05)
        finally:
            release.set()
        assert first.result(timeout=3) is second.result(timeout=3)
    assert len(calls) == 1


def test_sam_model_work_uses_the_shared_reentrant_unicanvas_lock(monkeypatch):
    shared = threading.RLock()
    monkeypatch.setitem(sys.modules, "sam_lock_test.nodes.unicanvas", SimpleNamespace(_COMFY_MODEL_OP_LOCK=shared))
    entered, started = threading.Event(), threading.Event()

    @progress.model_operation
    def inner():
        entered.set()
        return "done"

    @progress.model_operation
    def outer():
        return inner()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with shared:
            def run():
                started.set()
                return outer()
            task = pool.submit(run)
            assert started.wait(3)
            assert not entered.wait(0.05)
        assert task.result(timeout=3) == "done"
    assert entered.is_set()


def test_every_sam_entry_point_serializes_model_work():
    endpoints = {
        "vnccs_sam3d/pose_import.py": {"process_image_to_pose_json", "process_pose_json_to_overlay_mesh"},
        "vnccs_sam3d/processing/process.py": {"_load_sam3d_model", "process_to_json", "render"},
    }
    for path, names in endpoints.items():
        tree = ast.parse((ROOT / path).read_text())
        functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name in names}
        assert functions.keys() == names
        for function in functions.values():
            assert any(isinstance(decorator, ast.Attribute) and decorator.attr == "model_operation"
                       and isinstance(decorator.value, ast.Name) and decorator.value.id == "progress"
                       for decorator in function.decorator_list)


def test_download_adapter_preserves_iteration_context_and_progress():
    task_id = progress.start_task("download")
    with progress.task_context(task_id), progress.download_phase("Downloading", 10, 40):
        with progress.SnapshotDownloadTqdm([1, 2], total=10, initial=2) as bar:
            assert list(bar) == [1, 2]
            assert bar.update(3) is None
            assert progress.get_task(task_id)["progress"] == 30
            assert progress.get_task(task_id)["message"] == "Downloading"
            bar.update(100)
            assert progress.get_task(task_id)["progress"] == 50
        with progress.SnapshotDownloadTqdm(total=4, vnccs_phase_base=20, vnccs_phase_weight=60) as bar:
            assert list(bar) == []
            bar.update(2)
            assert progress.get_task(task_id)["progress"] == 50
    assert progress.SnapshotDownloadTqdm.get_lock() is progress._LOCK
    assert progress.SnapshotDownloadTqdm.set_lock(threading.Lock()) is None
