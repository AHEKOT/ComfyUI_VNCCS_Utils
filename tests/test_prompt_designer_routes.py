import asyncio
import json
from types import SimpleNamespace

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request

from helpers.backend_package import service_package


@pytest.mark.parametrize("prefix", ["/vnccs", "/api/vnccs"])
def test_prompt_designer_routes_dispatch_through_the_application(prefix, tmp_path, monkeypatch):
    load = service_package("vnccs_prompt_routes_test")
    storage = load("nodes.prompt_designer_storage")
    monkeypatch.setattr(storage, "storage_path", lambda: tmp_path / "PromptLibrary")
    library = load("api.prompt_designer_library")
    preview = load("api.prompt_designer_preview")
    state = {"version": 1, "seed": "4", "blocks": [], "parts": [{"text": "first\nlast"}]}

    async def run():
        app = web.Application()
        library.register_routes(app)
        preview.register_routes(app)
        app.freeze()

        async def request(method, endpoint, body=None):
            match = await app.router.resolve(make_mocked_request(method, prefix + "/prompt_designer/" + endpoint))
            assert match.http_exception is None
            async def read():
                return json.dumps(body).encode()
            response = await match.handler(SimpleNamespace(
                method=method, match_info=match, query={}, headers={}, content_length=None, read=read))
            assert response.status == 200, response.text
            return json.loads(response.text)

        endpoint = "documents/" + "a" * 32
        assert await request("GET", endpoint) == {"state": None, "revision": 0}
        assert await request("PUT", endpoint, {"state": state, "revision": 0}) == {"revision": 1}
        assert await request("GET", endpoint) == {"state": state, "revision": 1}
        assert (await request("GET", "library"))["cards"] == []
        assert (await request("GET", "defaults"))["total"] > 0
        assert (await request("GET", "prompts"))["prompts"] == []
        saved = {**state, "savedPrompt": {"name": "Quiet scene", "category": "Scenes", "color": "#44bb99"}}
        saved_endpoint = "documents/" + "b" * 32
        assert await request("PUT", saved_endpoint, {"state": saved, "revision": 0}) == {"revision": 1}
        assert (await request("GET", "prompts"))["prompts"][0]["name"] == "Quiet scene"
        assert (await request("GET", saved_endpoint))["state"] == saved
        assert await request("PUT", saved_endpoint, {"state": state, "revision": 1}) == {"revision": 2}
        assert (await request("GET", "prompts"))["prompts"] == []
        assert (await request("GET", saved_endpoint))["state"] == state
        assert (await request("POST", "preview", state))["prompt"] == "first\nlast"

    asyncio.run(run())
