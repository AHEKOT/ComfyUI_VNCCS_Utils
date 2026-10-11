"""Draw request validation runs before model work, without PyTorch or ComfyUI."""
import asyncio
import json
import sys
import types
from unittest import mock

import pytest
from aiohttp import web

from helpers.unicanvas_package import load_unicanvas_package

routes = load_unicanvas_package("unicanvas_routes_test").routes


@pytest.fixture
def draw_route(monkeypatch):
    table = web.RouteTableDef()
    server = types.ModuleType("server")
    server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=table))
    monkeypatch.setitem(sys.modules, "server", server)
    monkeypatch.setattr(routes, "_set_draw_progress", mock.Mock())
    routes.register_unicanvas_routes()
    return next(route.handler for route in table if route.path == "/vnccs/unicanvas/draw")


class Request:
    def __init__(self, raw):
        self.raw = raw
        self.headers = {"Content-Length": str(len(raw))}

    async def json(self):
        return json.loads(self.raw)


@pytest.mark.parametrize("raw", ["[]", "null", "false", '"text"', "{invalid"])
def test_invalid_draw_body_returns_json_400_without_launching_models(draw_route, monkeypatch, raw):
    worker = mock.Mock()
    monkeypatch.setattr(routes, "_run_draw_cancellable", worker)
    response = asyncio.run(draw_route(Request(raw)))
    assert response.status == 400
    assert json.loads(response.text)["error"]
    worker.assert_not_called()


@pytest.mark.parametrize("failure,status", [(ValueError("Invalid model selection"), 400), (RuntimeError("Model unavailable"), 500)])
def test_draw_failure_preserves_json_error_and_scoped_progress(draw_route, monkeypatch, failure, status):
    monkeypatch.setattr(routes, "_run_draw_cancellable", mock.Mock(side_effect=failure))
    response = asyncio.run(draw_route(Request('{"debug_id":"request"}')))
    assert response.status == status
    assert json.loads(response.text) == {"error": str(failure)}
    routes._set_draw_progress.assert_called_once_with("request", "error", 1.0, 0, 0, str(failure))
