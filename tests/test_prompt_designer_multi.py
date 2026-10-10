import asyncio
import json
from types import SimpleNamespace

import pytest

from helpers.backend_package import service_package
from nodes.prompt_designer import MAX_PROMPT_CHARS, MAX_PROMPT_OUTPUTS, VNCCS_PromptDesigner, prompt_template, resolve_prompt


def multi(*variants):
    return {"multiPrompt": {"variants": list(variants)}}


def state(parts, blocks=None, seed=17):
    return json.dumps({"version": 1, "parts": parts, "blocks": blocks or [], "seed": str(seed)})


def test_two_outputs_keep_the_users_common_prefix_and_suffix():
    prefix = "anime style, masterpiece,\nsolo adult character, full body,\nsimple white background, calm expression,\n"
    suffix = "\nstanding, soft studio lighting"
    raw = state([{"text": prefix}, {"blockId": "artists"}, {"text": "\n"},
                 multi([{"text": "1girl, wear "}, {"blockId": "dresses"}],
                       [{"text": "1man, wear "}, {"blockId": "suits"}]), {"text": suffix}],
                [{"id": "artists", "name": "Artists", "text": "ink illustration"},
                 {"id": "dresses", "name": "Dresses", "text": "red dress"},
                 {"id": "suits", "name": "Suits", "text": "black suit"}])
    expected = [prefix + "ink illustration\n1girl, wear red dress" + suffix,
                prefix + "ink illustration\n1man, wear black suit" + suffix]
    result = resolve_prompt(raw)
    assert result["prompts"] == expected
    assert result["prompt"] == expected[0]
    executed = VNCCS_PromptDesigner().execute(raw)
    assert executed["result"] == tuple(expected) + ("",) * (MAX_PROMPT_OUTPUTS - 2)
    assert executed["ui"] == {"prompt": [expected[0]], "prompts": expected}
    assert len(VNCCS_PromptDesigner.RETURN_TYPES) == len(executed["result"])
    assert VNCCS_PromptDesigner.RETURN_NAMES[:3] == ("prompt", "prompt2", "prompt3")


def test_common_random_text_blocks_and_conditions_are_identical_across_outputs():
    parts = [{"text": "{~anime|painting}\n"}, {"blockId": "color"}, {"text": "\n"},
             multi([{"text": "girl {~dress|skirt}"}], [{"text": "man {~suit|coat}"}]),
             {"text": "\n"}, {"condition": {"blockId": "color", "operator": "equals", "value": "red", "then": {"text": "warm "}}},
             {"text": "{~studio|outdoors}"}]
    blocks = [{"id": "color", "name": "Color", "text": "{~red|blue}"}]
    outputs = set()
    for seed in range(20):
        raw = state(parts, blocks, seed)
        result = resolve_prompt(raw)
        assert result == resolve_prompt(raw)
        first, second = [prompt.split("\n") for prompt in result["prompts"]]
        assert first[:2] == second[:2]
        assert first[-1] == second[-1]
        assert first[2].startswith("girl ") and second[2].startswith("man ")
        assert first[-1].startswith("warm ") == (first[1] == "red")
        outputs.add(tuple(result["prompts"]))
    assert len(outputs) > 5


def test_multiple_fragments_align_output_numbers_without_cartesian_products():
    raw = state([{"text": "start "}, multi([{"text": "A1"}], [{"text": "A2"}]), {"text": " / "},
                 multi([{"text": "B1"}], [{"text": "B2"}], [{"text": "B3"}]), {"text": " end"}])
    assert resolve_prompt(raw)["prompts"] == ["start A1 / B1 end", "start A2 / B2 end", "start  / B3 end"]


def test_empty_first_variant_does_not_hide_later_outputs_and_empty_outputs_are_valid():
    assert resolve_prompt(state([multi([], [{"text": "second"}])]))["prompts"] == ["", "second"]
    assert resolve_prompt(state([multi([], [])]))["prompts"] == ["", ""]


def test_every_reserved_socket_matches_the_corresponding_variant():
    raw = state([multi(*[[{"text": f"output {index}"}] for index in range(MAX_PROMPT_OUTPUTS)])])
    result = VNCCS_PromptDesigner().execute(raw)
    assert result["result"] == tuple(f"output {index}" for index in range(MAX_PROMPT_OUTPUTS))
    assert VNCCS_PromptDesigner.RETURN_TYPES == ("STRING",) * len(result["result"])


@pytest.mark.parametrize("part", [
    multi([]), multi(*([[]] * (MAX_PROMPT_OUTPUTS + 1))), multi("text", []),
    multi([{ "blockId": "missing"}], []), multi([multi([], [])], []),
    {"multiPrompt": {"variants": [[], []], "unknown": True}},
])
def test_invalid_multi_prompt_documents_are_rejected(part):
    with pytest.raises(ValueError):
        prompt_template(state([part]))


def test_every_output_is_bounded_including_later_variants():
    with pytest.raises(ValueError, match="64 KiB"):
        prompt_template(state([{"text": "prefix"}, multi([], [{"text": "x" * MAX_PROMPT_CHARS}])]))


@pytest.mark.parametrize("location", ["main", "then", "else", "multi"])
@pytest.mark.parametrize("repeat_count", [4, 200])
def test_resolved_lengths_stop_sampling_before_oversized_composite_strings(location, repeat_count, monkeypatch):
    from dynamicprompts.parser import parse as parser
    original = parser.parse
    calls = 0

    def counted(text, *args, **kwargs):
        nonlocal calls
        if text == "${v14}":
            calls += 1
            assert calls <= 5, "Sampling must stop at the first fragment exceeding 64 KiB."
        return original(text, *args, **kwargs)

    monkeypatch.setattr(parser, "parse", counted)
    definitions = [{"text": "${v0=!x}"}, *[{"text": f"${{v{i}=!${{v{i-1}}}${{v{i-1}}}}}"} for i in range(1, 15)]]
    repeats = [{"blockId": "repeat"}] * repeat_count
    if location == "main":
        parts = [*definitions, *repeats, multi(*([[]] * MAX_PROMPT_OUTPUTS))]
    elif location == "multi":
        parts = [*definitions, multi([{"text": "first"}], repeats)]
    else:
        parts = [*definitions, {"condition": {"blockId": "gate", "operator": "equals", "value": "yes",
            "then": {"text": ""}, "else": {"text": ""}, location: {"parts": repeats}}}]
    raw = state(parts, [{"id": "repeat", "name": "Repeat", "text": "${v14}"},
                       {"id": "gate", "name": "Gate", "text": "yes" if location != "else" else "no"}])
    assert len(prompt_template(raw)[0]) < MAX_PROMPT_CHARS
    if repeat_count == 4:
        result = resolve_prompt(raw)
        assert len(result.get("prompts", [result["prompt"]])[-1]) == MAX_PROMPT_CHARS
        assert calls == 4
    else:
        with pytest.raises(ValueError, match="64 KiB"):
            resolve_prompt(raw)
        assert calls == 5


def test_preview_endpoint_returns_every_output_and_matches_execution():
    route = service_package("vnccs_multi_preview_test")("api.prompt_designer_preview")
    raw = state([{"text": "common\n"}, multi([{ "text": "first"}], [{"text": "second"}])]).encode()
    async def read(): return raw
    response = asyncio.run(route.preview_prompt(SimpleNamespace(headers={"Content-Length": str(len(raw))}, read=read, query={})))
    assert response.status == 200
    result = json.loads(response.body)
    assert result["prompts"] == ["common\nfirst", "common\nsecond"]
    assert result["prompts"] == VNCCS_PromptDesigner().execute(raw.decode())["ui"]["prompts"]
