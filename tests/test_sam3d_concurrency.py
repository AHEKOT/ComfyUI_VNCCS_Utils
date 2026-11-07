"""SAM model/cache synchronization without loading PyTorch or model weights."""

import ast
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from pathlib import Path
import sys
import threading
from types import ModuleType, SimpleNamespace
import weakref

import pytest

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


@pytest.fixture
def pose_model_cache(monkeypatch):
    root = ModuleType("sam_lock_test")
    root.__path__ = []
    package = ModuleType("sam_lock_test.vnccs_sam3d")
    package.__path__ = [str(ROOT / "vnccs_sam3d")]
    package.progress = progress
    root.vnccs_sam3d = package
    process = SimpleNamespace(_MODEL_CACHE={}, _FACE_BS_CACHE={"rest_key": None})
    refs = []
    allocator_calls = []
    cuda = SimpleNamespace(is_available=lambda: True, empty_cache=lambda: allocator_calls.append(
        [ref() is None for ref in refs]))
    for name, module in {
        root.__name__: root,
        package.__name__: package,
        f"{package.__name__}.processing.process": process,
        "torch": SimpleNamespace(cuda=cuda),
        "cv2": ModuleType("cv2"),
        "folder_paths": SimpleNamespace(models_dir="."),
    }.items():
        monkeypatch.setitem(sys.modules, name, module)
    from sam_lock_test.vnccs_sam3d import pose_import
    from sam_lock_test.vnccs_sam3d.processing import birefnet_mask
    return pose_import, birefnet_mask, process, refs, allocator_calls


@pytest.mark.parametrize("entry,work", [
    ("process_image_to_pose_json", "_extract_pose_json"),
    ("process_pose_json_to_overlay_mesh", "_build_overlay_mesh"),
])
@pytest.mark.parametrize("keep_models_loaded, fails", [(False, False), (False, True), (True, False)])
def test_pose_model_lifetime(monkeypatch, pose_model_cache, entry, work, keep_models_loaded, fails):
    pose_import, birefnet_mask, process, refs, allocator_calls = pose_model_cache

    class Allocation:
        pass

    def run(*_args):
        sam = process._MODEL_CACHE["pose"] = Allocation()
        process._FACE_BS_CACHE["rest_key"] = id(sam)
        mask = Allocation()
        monkeypatch.setattr(birefnet_mask, "_MODEL", mask)
        monkeypatch.setattr(birefnet_mask, "_DEVICE", "cuda")
        intermediate = Allocation()
        intermediate.cycle = intermediate
        refs.extend(weakref.ref(value) for value in (sam, mask, intermediate))
        if fails:
            raise RuntimeError("inference failed")
        return "pose result"

    monkeypatch.setattr(pose_import, work, run)
    operation = getattr(pose_import, entry)
    if fails:
        with pytest.raises(RuntimeError, match="inference failed"):
            operation(None)
    elif keep_models_loaded:
        assert operation(None, keep_models_loaded=True) == "pose result"
    else:
        assert operation(None) == "pose result"

    if keep_models_loaded:
        assert process._MODEL_CACHE["pose"] is refs[0]()
        assert birefnet_mask._MODEL is refs[1]()
        assert allocator_calls == []
    else:
        assert process._MODEL_CACHE == {}
        assert process._FACE_BS_CACHE["rest_key"] is None
        assert birefnet_mask._MODEL is birefnet_mask._DEVICE is None
        assert allocator_calls == [[True, True, True]]


def test_pose_model_session_reuses_models_across_frames_and_rejects_late_requests(monkeypatch, pose_model_cache):
    pose_import, _, process, _, allocator_calls = pose_model_cache
    loads = []

    def run(*_args):
        if not process._MODEL_CACHE:
            process._MODEL_CACHE["pose"] = object()
            loads.append("model")
        return "pose result"

    monkeypatch.setattr(pose_import, "_extract_pose_json", run)
    monkeypatch.setattr(pose_import, "_build_overlay_mesh", run)
    first = pose_import.open_pose_model_session()
    second = pose_import.open_pose_model_session()
    try:
        for _ in range(3):
            assert pose_import.process_image_to_pose_json(None, model_session_id=first) == "pose result"
            assert pose_import.process_pose_json_to_overlay_mesh({}, model_session_id=first) == "pose result"
        pose_import.close_pose_model_session(first)
        with pytest.raises(pose_import.PoseModelSessionError, match="closed"):
            pose_import.process_image_to_pose_json(None, model_session_id=first)
        assert pose_import.process_image_to_pose_json(None, model_session_id=second) == "pose result"
        assert loads == ["model"]
        assert allocator_calls == []
    finally:
        pose_import.close_pose_model_session(first)
        pose_import.close_pose_model_session(second)
    assert process._MODEL_CACHE == {}
    assert allocator_calls == [[]]


@pytest.mark.parametrize("keep_models_loaded", [False, True])
def test_pose_model_session_expires_after_idle_time(monkeypatch, pose_model_cache, keep_models_loaded):
    pose_import, _, process, _, allocator_calls = pose_model_cache
    clock = SimpleNamespace(now=0)
    monkeypatch.setattr(pose_import, "time", SimpleNamespace(monotonic=lambda: clock.now))
    delays = []

    def schedule(_id, session, delay):
        session.timer = SimpleNamespace(cancel=lambda: None)
        delays.append(delay)

    monkeypatch.setattr(pose_import, "_schedule_session_expiry", schedule)
    monkeypatch.setattr(pose_import, "_extract_pose_json", lambda _: process._MODEL_CACHE.update(pose=object()))
    session_id = pose_import.open_pose_model_session(keep_models_loaded)
    try:
        clock.now = delays[0] - 1
        pose_import.process_image_to_pose_json(None, model_session_id=session_id)
        clock.now = delays[0]
        pose_import._expire_pose_model_session(session_id)
        assert process._MODEL_CACHE
        clock.now += delays[1]
        pose_import._expire_pose_model_session(session_id)
        assert bool(process._MODEL_CACHE) == keep_models_loaded
        assert allocator_calls == ([] if keep_models_loaded else [[]])
        with pytest.raises(pose_import.PoseModelSessionError, match="expired"):
            pose_import.process_pose_json_to_overlay_mesh({}, model_session_id=session_id)
    finally:
        pose_import.close_pose_model_session(session_id)


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
