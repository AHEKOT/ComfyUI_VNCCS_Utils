import asyncio
import json
from types import SimpleNamespace

import pytest

from helpers.backend_package import service_package
from nodes.prompt_designer import MAX_PROMPT_CHARS, MAX_PROMPT_OUTPUTS, VNCCS_PromptDesigner, prompt_template, resolve_prompt


def multi(*variants):
    return {"multiPrompt": {"variants": list(variants)}}


@pytest.mark.parametrize("mode", [None, "random", "cycle"])
def test_block_copies_share_their_draw_inside_and_outside_every_output(mode):
    block = {"id": "color", "name": "Colors", "text": "{~red|blue|green}"}
    if mode is not None:
        block["mode"] = mode
    parts = [{"blockId": "color"}, {"text": "/"},
             multi([{"blockId": "color"}, {"text": "/"}, {"blockId": "color"}],
                   [{"blockId": "color"}, {"text": "/"}, {"blockId": "color"}]),
             {"text": "/"}, {"blockId": "color"}]
    draws = set()
    for seed in range(20):
        raw = json.loads(state(parts, [block], seed))
        raw["cycleIndex"] = seed
        result = resolve_prompt(json.dumps(raw))
        assert result["prompts"][0] == result["prompts"][1]
        copies = result["prompts"][0].split("/")
        assert len(copies) == 4 and len(set(copies)) == 1
        assert result == resolve_prompt(json.dumps(raw))
        assert list(VNCCS_PromptDesigner().execute(json.dumps(raw))["result"][:2]) == result["prompts"]
        draws.add(copies[0])
    assert draws == {"red", "blue", "green"}


def test_only_the_marked_instance_randomizes_and_forward_checks_reuse_its_draw():
    block = {"id": "color", "name": "Colors", "text": "{@red|blue|green}", "mode": "cycle"}
    check = {"condition": {"blockId": "color", "operator": "equals", "value": "red", "then": {"text": "red:"}, "else": {"text": "other:"}}}
    parts = [check, multi([{"blockId": "color", "random": True}, {"text": "/"}, {"blockId": "color"}],
                         [{"blockId": "color"}, {"text": "/"}, {"blockId": "color"}])]
    draws = set()
    for seed in range(20):
        raw = state(parts, [block], seed)
        result = resolve_prompt(raw)
        prefix, values = result["prompts"][0].split(":")
        random, shared = values.split("/")
        assert prefix == ("red" if random == "red" else "other")
        assert shared == "red"
        assert result["prompts"][1] == "red:red/red"
        assert resolve_prompt(raw) == result
        draws.add(random)
    assert draws == {"red", "blue", "green"}


@pytest.mark.parametrize("invalid", [None, 0, 1, "true", [], {}])
@pytest.mark.parametrize("location", ["main", "multi", "condition"])
def test_instance_random_flag_requires_a_boolean_at_every_state_boundary(invalid, location):
    reference = {"blockId": "a", "random": invalid}
    parts = [reference] if location == "main" else [multi([reference], [])] if location == "multi" else [
        {"condition": {"blockId": "a", "operator": "equals", "value": "red", "then": {"parts": [reference]}}}]
    with pytest.raises(ValueError):
        prompt_template(state(parts, [{"id": "a", "name": "Colors", "text": "red"}]))


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


@pytest.mark.parametrize("branch", ["text", "block", "condition"])
def test_output_variable_assignments_do_not_leak_into_other_outputs_or_the_shared_suffix(branch):
    blocks = [{"id": "who", "name": "Who", "text": "${who}"}]
    reference = {"text": "${who}"} if branch == "text" else {"blockId": "who"}
    if branch == "condition":
        reference = {"condition": {"blockId": "who", "operator": "contains", "value": "girl",
            "then": {"text": "${who}"}, "else": {"text": "${who}"}}}
    raw = state([{"text": "${who=!other}${common=!prefix} ${common}: "},
                 multi([{"text": "${who=!girl}${who}"}], [{"text": "${who=!boy}${who}"}], []),
                 {"text": " / "}, reference], blocks)
    # A third output retains the original common scope, rather than inheriting the second row's assignment.
    result = resolve_prompt(raw)
    assert result["prompts"] == [" prefix: girl / girl", " prefix: boy / boy", " prefix:  / other"]
    assert resolve_prompt(raw) == result
    assert list(VNCCS_PromptDesigner().execute(raw)["result"][:3]) == result["prompts"]


def test_forward_conditions_reserve_each_output_in_its_future_variable_scope():
    blocks = [{"id": "color", "name": "Color", "text": "${color:undefined}"}]
    parts = [{"condition": {"blockId": "color", "operator": "equals", "value": "red",
                            "then": {"text": "red:"}, "else": {"text": "blue:"}}},
             multi([{"text": "${color=!red}"}, {"blockId": "color"}],
                   [{"text": "${color=!blue}"}, {"blockId": "color"}]),
             {"text": " ${color}"}]
    result = resolve_prompt(state(parts, blocks))
    assert result["prompts"] == ["red:red red", "blue:blue blue"]


@pytest.mark.parametrize("suffix", ["{~red|blue}", "${who} {~red|blue}", "${color=!{~red|blue}}${who} ${color}"])
def test_common_random_draws_remain_shared_when_output_variables_differ(suffix):
    for seed in range(20):
        raw = state([multi([{"text": "${who=!girl}first "}], [{"text": "${who=!boy}second "}]),
                     {"text": suffix}, {"text": " {~studio|outdoors}"}], seed=seed)
        result = resolve_prompt(raw)
        first, second = result["prompts"]
        assert first.startswith("first " + ("girl " if "${who}" in suffix else ""))
        assert second.startswith("second " + ("boy " if "${who}" in suffix else ""))
        assert first.split()[-2:] == second.split()[-2:]
        assert resolve_prompt(raw) == result


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
@pytest.mark.parametrize("random", [False, True])
def test_resolved_lengths_stop_sampling_before_oversized_composite_strings(location, repeat_count, random, monkeypatch):
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
    repeats = [{"blockId": "repeat", "random": random}] * repeat_count
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
        assert calls == (4 if random else 1)
    else:
        with pytest.raises(ValueError, match="64 KiB"):
            resolve_prompt(raw)
        assert calls == (5 if random else 1)


def test_preview_endpoint_returns_every_output_and_matches_execution():
    route = service_package("vnccs_multi_preview_test")("api.prompt_designer_preview")
    raw = state([{"text": "common\n"}, multi([{ "text": "first"}], [{"text": "second"}])]).encode()
    async def read(): return raw
    response = asyncio.run(route.preview_prompt(SimpleNamespace(headers={"Content-Length": str(len(raw))}, read=read, query={})))
    assert response.status == 200
    result = json.loads(response.body)
    assert result["prompts"] == ["common\nfirst", "common\nsecond"]
    assert result["prompts"] == VNCCS_PromptDesigner().execute(raw.decode())["ui"]["prompts"]
