"""Read-only bundled cards, independent of the user's durable library."""

import json
from pathlib import Path

from .prompt_designer import MAX_STATE_CHARS, prompt_template
from .shared.paths import _EXTENSION_ROOT


def defaults_path():
    return Path(_EXTENSION_ROOT) / "PromptLibrary" / "defaults"


def default_node_state():
    cards = []
    for filename in ("backgrounds.json", "colors.json"):
        cards.extend(json.loads((defaults_path() / filename).read_text(encoding="utf-8"))["blocks"])
    state = {"version": 1, "blocks": cards, "parts": [
        {"text": "illustration of a quiet scene,\n"},
        {"blockId": "bundled-backgrounds"},
        {"text": ",\naccent color: "},
        {"blockId": "bundled-colors"},
        {"text": ",\n"},
        {"condition": {"blockId": "bundled-backgrounds", "operator": "contains", "value": "night",
                       "then": {"text": "gentle lights and soft reflections"},
                       "else": {"text": "natural light and subtle shadows"}}},
        {"text": ",\nclean composition, fine details"},
    ], "seed": "0", "afterGenerate": "randomize", "openTabs": [], "activeTab": "prompt"}
    raw = json.dumps(state)
    prompt_template(raw)
    return raw


def list_default_cards(query="", offset=0):
    if not isinstance(query, str) or len(query) > 128 or type(offset) is not int or offset < 0:
        raise ValueError("Invalid library search.")
    cards = []
    paths = sorted(defaults_path().glob("*.json"))
    if not paths:
        raise ValueError("Bundled prompt cards are missing.")
    for path in paths:
        raw = path.read_text(encoding="utf-8")
        if len(raw) > MAX_STATE_CHARS:
            raise ValueError("Bundled prompt cards are too large.")
        data = json.loads(raw)
        prompt_template(raw)
        cards.extend(data["blocks"])
    # Validate duplicate IDs and the combined size before exposing packaged data.
    prompt_template(json.dumps({"version": 1, "blocks": cards, "parts": []}))
    cards = sorted((card for card in cards if query.casefold() in card["name"].casefold()), key=lambda card: card["name"].casefold())
    return {"cards": cards[offset:offset + 50], "total": len(cards), "offset": offset}
