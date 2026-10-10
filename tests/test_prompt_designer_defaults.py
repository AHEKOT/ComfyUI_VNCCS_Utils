import asyncio
import json
from types import SimpleNamespace

import pytest

from helpers.backend_package import service_package
from nodes.prompt_designer import preview_block, resolve_prompt


@pytest.fixture
def bundled():
    return service_package("vnccs_prompt_defaults_test")("nodes.prompt_designer_defaults")


def test_packaged_cards_parse_as_complete_variants_and_include_all_categories(bundled):
    assert {path.name for path in bundled.defaults_path().glob("*.json")} == {
        "clothing.json", "anima_styles.json", "colors.json", "hairstyles.json", "backgrounds.json"}
    result = bundled.list_default_cards()
    counts = {"Headwear": 101, "Tops": 62, "Outerwear": 40, "Bottoms": 101, "Footwear": 101,
              "Accessories": 101, "Anima styles": 174, "Colors": 72, "Hairstyles": 121, "Backgrounds": 99}
    assert result["total"] == len(counts)
    assert {card["name"] for card in result["cards"]} == set(counts)
    for card in result["cards"]:
        options = card["text"][2:-1].split("|")
        assert len(options) == counts[card["name"]]
        assert len(set(options)) == len(options)
        raw = json.dumps({"version": 1, "blocks": [card], "parts": [{"blockId": card["id"]}], "seed": "17"})
        preview = preview_block(raw, card["id"])
        assert not preview["truncated"]
        assert preview["variants"] == options
        assert resolve_prompt(raw)["prompt"] in options
        assert json.loads(raw)["blocks"] == [card]
    hair = next(card for card in result["cards"] if card["name"] == "Hairstyles")["text"]
    assert {"ponytail", "twintails", "side ponytail", "twin braids", "braid", "drill hair", "ahoge", "sidelocks",
            "blunt bangs", "side swept bangs", "hair bun", "bangs", "parted bangs", "two side up", "messy hair",
            "floating hair", "hair over one eye", "streaked hair", "gradient hair", "two-tone hair", "drills"}.issubset(hair[2:-1].split("|"))


def test_new_node_example_uses_bundled_cards_and_checks_the_sampled_background(bundled):
    node = service_package("vnccs_prompt_defaults_test")("nodes.prompt_designer").VNCCS_PromptDesigner
    raw = node.INPUT_TYPES()["required"]["node_state"][1]["default"]
    state = json.loads(raw)
    packaged = {card["id"]: card for card in bundled.list_default_cards()["cards"]}
    assert state["blocks"] == [packaged["bundled-backgrounds"], packaged["bundled-colors"]]
    assert resolve_prompt(raw)["prompt"].startswith("illustration of a quiet scene,\n")
    assert state["parts"][1] == {"blockId": "bundled-backgrounds"}
    assert state["parts"][3] == {"blockId": "bundled-colors"}
    for background, expected, absent in [
        ("a quiet garden at night", "gentle lights and soft reflections", "natural light and subtle shadows"),
        ("a sunlit garden", "natural light and subtle shadows", "gentle lights and soft reflections"),
    ]:
        state["blocks"][0]["text"] = background
        prompt = node().execute(json.dumps(state))["result"][0]
        assert background in prompt and expected in prompt and absent not in prompt
    assert node().execute("{}")["result"][0] == "", "restored empty prompts must remain empty"


def test_packaged_updates_never_open_or_change_user_storage(bundled, tmp_path, monkeypatch):
    storage = service_package("vnccs_prompt_defaults_test")("nodes.prompt_designer_storage")
    monkeypatch.setattr(storage, "storage_path", lambda: tmp_path / "PromptLibrary")
    user = {"version": 1, "blocks": [{"id": "bundled-colors", "name": "Colors", "text": "my own colors", "color": "#ff8fa3"}],
            "parts": [{"blockId": "bundled-colors"}], "seed": ""}
    identifier = "a" * 32
    storage.save_document(identifier, user, 0)
    before = {path.relative_to(storage.storage_path()): path.read_bytes() for path in storage.storage_path().rglob("*.json")}
    package = tmp_path / "bundled"
    package.mkdir()
    monkeypatch.setattr(bundled, "defaults_path", lambda: package)
    source = package / "colors.json"
    def update(text):
        source.write_text(json.dumps({"version": 1, "blocks": [{"id": "bundled-colors", "name": "Colors", "text": text}]}))
    update("{~red|blue}")
    assert bundled.list_default_cards()["cards"][0]["text"] == "{~red|blue}"
    update("{~green|yellow}")
    assert bundled.list_default_cards()["cards"][0]["text"] == "{~green|yellow}"
    assert {path.relative_to(storage.storage_path()): path.read_bytes() for path in storage.storage_path().rglob("*.json")} == before
    assert storage.load_document(identifier) == {"revision": 1, "state": user}
    assert storage.list_cards()["cards"] == user["blocks"]
    source.write_text("broken JSON")
    with pytest.raises(ValueError):
        bundled.list_default_cards()
    assert storage.load_document(identifier)["state"] == user


def test_defaults_route_reads_without_disk_storage_and_validates_queries(bundled, monkeypatch):
    route = service_package("vnccs_prompt_defaults_test")("api.prompt_designer_library")
    def fail(*args):
        raise AssertionError("Bundled cards must not use document storage")
    monkeypatch.setattr(route, "list_cards", fail)
    monkeypatch.setattr(route, "save_document", fail)
    async def call(query):
        return await route.defaults(SimpleNamespace(query=query))
    response = asyncio.run(call({"q": "ANIMA"}))
    assert response.status == 200
    assert [card["name"] for card in json.loads(response.body)["cards"]] == ["Anima styles"]
    assert json.loads(asyncio.run(call({"q": "missing"})).body)["total"] == 0
    assert json.loads(asyncio.run(call({"offset": "50"})).body)["cards"] == []
    for query in [{"q": "x" * 129}, {"offset": "-1"}, {"offset": "bad"}]:
        assert asyncio.run(call(query)).status == 400


def test_invalid_or_duplicate_bundled_data_is_not_exposed(bundled, tmp_path, monkeypatch):
    monkeypatch.setattr(bundled, "defaults_path", lambda: tmp_path)
    with pytest.raises(ValueError, match="missing"):
        bundled.list_default_cards()
    data = {"version": 1, "blocks": [{"id": "a", "name": "A", "text": "value"}]}
    (tmp_path / "first.json").write_text(json.dumps(data))
    (tmp_path / "second.json").write_text(json.dumps(data))
    with pytest.raises(ValueError, match="duplicate"):
        bundled.list_default_cards()
