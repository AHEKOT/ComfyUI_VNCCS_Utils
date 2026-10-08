"""Stop belongs to the draw holding the model lock, including graph draws."""

import threading
import types
from unittest import mock

import pytest

from helpers.unicanvas_package import load_unicanvas_package


torch_stub = types.ModuleType("torch")
torch_stub.Tensor = object
draw = load_unicanvas_package("vnccs_draw_ownership_test", torch_module=torch_stub).draw


@pytest.mark.parametrize("stop_queued", [False, True])
def test_queued_draw_cannot_clear_or_receive_another_draw_stop(monkeypatch, stop_queued):
    first_started = threading.Event()
    queued_at_lock = threading.Event()
    finish_first = threading.Event()
    lock = threading.RLock()
    interrupted = {"value": False}
    calls, results, errors, states = [], {}, [], {}

    class ObservedLock:
        def __enter__(self):
            if threading.current_thread().name == "queued-draw":
                queued_at_lock.set()
            lock.acquire()

        def __exit__(self, *_args):
            lock.release()

    def set_interrupt(value):
        calls.append(value)
        interrupted["value"] = value

    def pipeline(request):
        def run():
            if request.draw_id == "graph":
                first_started.set()
                assert finish_first.wait(5)
            result = {"interrupted": interrupted["value"]}
            states[request.draw_id] = {"stage": "complete"}
            return result
        return types.SimpleNamespace(run=run)

    def run(draw_id):
        try:
            results[draw_id] = draw._run_unicanvas_draw({"debug_id": draw_id})
        except Exception as exc:
            errors.append(exc)

    monkeypatch.setattr(draw, "_COMFY_MODEL_OP_LOCK", ObservedLock())
    monkeypatch.setattr(draw, "set_interrupt", set_interrupt)
    monkeypatch.setattr(draw, "interrupt_types", lambda: ())
    monkeypatch.setattr(draw, "_get_draw_progress", lambda draw_id: states.get(draw_id, {"stage": "unknown"}))
    monkeypatch.setattr(draw, "_set_draw_progress", lambda draw_id, stage, *_args, **kwargs: states.__setitem__(draw_id, {"stage": stage, **kwargs}))
    monkeypatch.setattr(draw, "consume_draw_cancellation", lambda draw_id: states.get(draw_id, {}).pop("cancel_before_start", False))
    monkeypatch.setattr(draw.DrawRequest, "from_payload", lambda payload: types.SimpleNamespace(
        draw_id=payload["debug_id"], module=types.SimpleNamespace(validate_request=mock.Mock()),
    ))
    monkeypatch.setattr(draw, "_create_draw_pipeline", pipeline)
    first = threading.Thread(target=run, args=("graph",))
    second = threading.Thread(target=run, args=("http",), name="queued-draw")
    try:
        first.start()
        assert first_started.wait(5)
        second.start()
        assert queued_at_lock.wait(5)
        if stop_queued:
            assert draw.interrupt_draw("http")
            assert calls == [False]
            assert not interrupted["value"]
        assert not draw.interrupt_draw("")
        assert draw.interrupt_draw("graph")
        assert calls == [False, True]
        assert interrupted["value"]
    finally:
        finish_first.set()
        first.join(5)
        if second.ident is not None:
            second.join(5)
    assert not first.is_alive() and not second.is_alive()
    if stop_queued:
        assert len(errors) == 1 and isinstance(errors[0], draw.DrawCancelled)
        assert results == {"graph": {"interrupted": True}}
    else:
        assert not errors
        assert results == {"graph": {"interrupted": True}, "http": {"interrupted": False}}
    assert not draw.interrupt_draw("http")
    assert calls == ([False, True] if stop_queued else [False, True, False])


def test_failed_request_releases_draw_ownership(monkeypatch):
    monkeypatch.setattr(draw, "set_interrupt", mock.Mock())
    monkeypatch.setattr(draw.DrawRequest, "from_payload", mock.Mock(side_effect=ValueError("invalid payload")))
    with pytest.raises(ValueError, match="invalid payload"):
        draw._run_unicanvas_draw({"debug_id": "failed"})
    assert draw._ACTIVE_DRAW_ID is None


def test_queued_cancellation_is_consumed_so_reusing_draw_id_can_run(monkeypatch):
    progress = load_unicanvas_package("vnccs_draw_ownership_test", torch_module=torch_stub).progress
    monkeypatch.setattr(progress, "_DRAW_PROGRESS", {})
    monkeypatch.setattr(draw, "interrupt_types", lambda: ())
    monkeypatch.setattr(draw, "set_interrupt", mock.Mock())
    assert draw.interrupt_draw("reused-id")
    with pytest.raises(draw.DrawCancelled):
        draw._run_unicanvas_draw({"debug_id": "reused-id"})
    monkeypatch.setattr(draw.DrawRequest, "from_payload", lambda payload: types.SimpleNamespace(
        draw_id=payload["debug_id"], module=types.SimpleNamespace(validate_request=mock.Mock()),
    ))
    monkeypatch.setattr(draw, "_create_draw_pipeline", lambda request: types.SimpleNamespace(run=lambda: {"ran": True}))
    assert draw._run_unicanvas_draw({"debug_id": "reused-id"}) == {"ran": True}
