import asyncio
import json
from types import SimpleNamespace

import pytest

from helpers.backend_package import service_package
from nodes.prompt_designer import MAX_BLOCK_VARIANTS, MAX_PROMPT_CHARS, MAX_STATE_CHARS, MAX_PROMPT_OUTPUTS, VNCCS_PromptDesigner, preview_block, prompt_template, resolve_prompt


def state(text="A {~red|blue|green} coat", **extra):
    return json.dumps({"version": 1, "blocks": [], "parts": [{"text": text}], "seed": "17", **extra})


def test_block_references_preserve_manual_order_and_repeat():
    raw = state(parts=[{"text": "wear: "}, {"blockId": "a"}, {"text": ", "}, {"blockId": "a"}],
                blocks=[{"id": "a", "name": "Clothing", "text": "{~coat|shirt}"}])
    assert prompt_template(raw) == ("wear: {~coat|shirt}, {~coat|shirt}", 17)
    changed = json.loads(raw)
    changed["blocks"][0]["text"] = "jacket"
    assert prompt_template(json.dumps(changed))[0] == "wear: jacket, jacket"


def test_only_the_active_prompt_is_generated_and_inactive_tabs_are_validated_as_drafts():
    active = json.loads(state("active prompt"))
    active["promptTabs"] = [
        {"id": "a" * 32, "parts": active["parts"], "seed": "17", "afterGenerate": "fixed", "details": {}, "dirty": True},
        {"id": "b" * 32, "parts": [{"text": "inactive {unfinished"}], "seed": "", "afterGenerate": "randomize", "details": {}, "dirty": True},
    ]
    active["activePrompt"] = "a" * 32
    assert resolve_prompt(json.dumps(active))["prompt"] == "active prompt"
    active["promptTabs"][1]["parts"] = [{"blockId": "missing"}]
    with pytest.raises(ValueError, match="missing block"):
        resolve_prompt(json.dumps(active))


def test_seed_is_reproducible_and_preview_matches_execution():
    raw = state(seed="18446744073709551615")
    first = resolve_prompt(raw)
    assert first == resolve_prompt(raw)
    assert first["prompt"] in {"A red coat", "A blue coat", "A green coat"}
    result = VNCCS_PromptDesigner().execute(raw)
    assert result["result"] == (first["prompt"],) + ("",) * (MAX_PROMPT_OUTPUTS - 1)
    assert result["ui"]["prompt"] == [first["prompt"]]
    outputs = {resolve_prompt(state(seed=str(seed)))["prompt"] for seed in range(20)}
    assert len(outputs) == 3


@pytest.mark.parametrize("mode", [None, "random"])
def test_repeated_cards_sample_independently_and_unused_cards_do_not_change_the_sequence(mode):
    block = {"id": "a", "name": "Color", "text": "{~red|blue|green}"}
    if mode:
        block["mode"] = mode
    parts = [{"blockId": "a"}, {"text": ","}, {"blockId": "a"}, {"text": ","}, {"blockId": "a"}]
    sequences = set()
    for seed in range(20):
        raw = state(blocks=[block], parts=parts, seed=str(seed))
        result = resolve_prompt(raw)
        assert result == resolve_prompt(raw)
        assert VNCCS_PromptDesigner().execute(raw)["result"][0] == result["prompt"]
        for unused_mode in ("random", "cycle"):
            unused = {"id": "unused", "name": "Unused", "text": "{unfinished", "mode": unused_mode}
            assert resolve_prompt(state(blocks=[block, unused], parts=parts, seed=str(seed))) == result
        sequence = tuple(result["prompt"].split(","))
        assert len(sequence) == 3 and set(sequence) <= {"red", "blue", "green"}
        sequences.add(sequence)
    assert any(len(set(sequence)) > 1 for sequence in sequences)
    assert any(len(set(sequence)) < 3 for sequence in sequences), "random choices may legitimately repeat"


@pytest.mark.parametrize("source,expected", [
    ("{~red|blue|green}", ["red", "blue", "green"]),
    ("{~{~red|blue}|green}", ["red", "green", "blue", "green"]),
    ("{2$$ and $$red|blue|green}", ["red and blue", "red and green", "blue and red", "blue and green", "green and red", "green and blue"]),
    ("{~red|red|blue}", ["red", "red", "blue"]),
])
def test_cycle_advances_wraps_and_keeps_native_nested_and_multiple_choice_order(source, expected):
    block = {"id": "a", "name": "Color", "text": source, "mode": "cycle"}
    for position in [*range(len(expected) * 2), 2**53 - 1]:
        raw = state(blocks=[block], parts=[{"blockId": "a"}, {"text": ","}, {"blockId": "a"}], cycleIndex=position)
        result = resolve_prompt(raw)
        assert result["prompt"] == expected[position % len(expected)] + "," + expected[(position + 1) % len(expected)]
        assert result == resolve_prompt(raw)
        assert VNCCS_PromptDesigner().execute(raw)["result"][0] == result["prompt"]


@pytest.mark.parametrize("text", ["{@red|blue|green}", "${color={@red|blue|green}}${color}", "${color=!{@red|blue|green}}${color}"])
def test_explicit_cycle_syntax_in_main_text_and_variables_advances_without_block_preferences(text):
    assert [resolve_prompt(state(text, cycleIndex=index))["prompt"] for index in range(4)] == ["red", "blue", "green", "red"]


@pytest.mark.parametrize("index", [True, 0.5, "1", None, -2, 2**53])
def test_cycle_position_is_validated_at_the_backend_boundary(index):
    with pytest.raises(ValueError, match="cycle position"):
        resolve_prompt(state(cycleIndex=index))


def test_cycle_replay_work_is_bounded():
    with pytest.raises(ValueError, match="too complex"):
        resolve_prompt(state("{@6$$|a|b|c|d|e|f|g|h|i|j|k|l}", cycleIndex=100_000))


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_line_breaks_survive_linked_blocks_preview_and_execution(newline):
    raw = state(parts=[{"text": f"first,{newline}{newline}"}, {"blockId": "a"},
                       {"text": f",{newline}last{newline}"}],
                blocks=[{"id": "a", "name": "Clothing", "text": "{~coat|shirt}"}])
    prompt = resolve_prompt(raw)["prompt"]
    assert prompt in {f"first,{newline}{newline}{choice},{newline}last{newline}" for choice in ["coat", "shirt"]}
    result = VNCCS_PromptDesigner().execute(raw)
    assert result["result"] == (prompt,) + ("",) * (MAX_PROMPT_OUTPUTS - 1)
    assert result["ui"]["prompt"] == [prompt]


@pytest.mark.parametrize("text", ["first\nsecond", "\n  first\n\nsecond\n", "first  second"])
def test_literal_line_breaks_and_spaces_are_preserved(text):
    assert resolve_prompt(state(text))["prompt"] == text


@pytest.mark.parametrize("template,expected", [
    ("", ""),
    ("ordinary text, (coat:1.2)", "ordinary text, (coat:1.2)"),
    ("{1::red|0::blue}", "red"),
    ("{2$$ and $$red|blue}", None),
    ("{~{~red|blue}|green}", None),
    ("${color=!{red|blue}} ${color} ${color}", None),
])
def test_real_dynamic_prompts_syntax(template, expected):
    prompt = resolve_prompt(state(template))["prompt"]
    if expected is not None:
        assert prompt == expected
    elif "2$$" in template:
        assert prompt in {"red and blue", "blue and red"}
    elif "${color" in template:
        assert prompt in {" red red", " blue blue"}
    else:
        assert prompt in {"red", "blue", "green"}


def test_multiline_block_keeps_selected_option_line_breaks():
    assert resolve_prompt(state("wear: {~\n coat\n| shirt\n}"))["prompt"] in {"wear: coat\n", "wear: shirt\n"}


def test_inspector_mode_overrides_parsed_choices_without_rewriting_source():
    block = {"id": "a", "name": "Card", "text": "{~{~red|blue}|green}", "mode": "cycle", "color": "#e88fab"}
    parts = [{"blockId": "a"}]
    assert resolve_prompt(state(blocks=[block], parts=parts))["prompt"] == "red"
    block.update(text="{@red|blue|green}", mode="random")
    assert {resolve_prompt(state(blocks=[block], parts=parts, seed=str(seed)))["prompt"] for seed in range(20)} == {"red", "blue", "green"}
    block.update(text="prefix\n{2$$ and $$red|blue}\n", mode="cycle")
    raw = state(blocks=[block], parts=parts)
    assert resolve_prompt(raw)["prompt"] == "prefix\nred and blue\n"
    assert prompt_template(raw)[0] == block["text"]
    assert preview_block(raw, "a")["variants"] == ["prefix\nred and blue\n", "prefix\nblue and red\n"]


def test_conditions_match_the_sampled_variant_in_each_multi_output():
    block = {"id": "a", "name": "Card", "text": "{~red|blue}", "mode": "cycle"}
    condition = {"condition": {"blockId": "a", "operator": "equals", "value": "red", "then": {"text": "match\n"}}}
    parts = [condition, {"multiPrompt": {"variants": [[{"blockId": "a"}], [{"text": "second "}, {"blockId": "a"}]]}}]
    result = resolve_prompt(state(blocks=[block], parts=parts))
    assert result["prompts"] == ["match\nred", "second blue"]
    assert resolve_prompt(state(blocks=[block], parts=parts)) == result
    assert VNCCS_PromptDesigner().execute(state(blocks=[block], parts=parts))["ui"]["prompts"] == result["prompts"]


def test_if_checks_the_nearest_insertion_on_the_left_without_resampling():
    block = {"id": "a", "name": "Color", "text": "{@red|blue|green}"}
    def check(color):
        return {"condition": {"blockId": "a", "operator": "equals", "value": color,
                              "then": {"text": " matched "}, "else": {"text": " wrong "}}}
    parts = [check("red"), {"blockId": "a"}, check("red"), {"blockId": "a"}, check("blue"), {"blockId": "a"}, check("green")]
    assert resolve_prompt(state(blocks=[block], parts=parts))["prompt"] == " matched red matched blue matched green matched "
    multi = {"multiPrompt": {"variants": [[{"blockId": "a"}], [{"blockId": "a"}]]}}
    assert resolve_prompt(state(blocks=[block], parts=[multi, check("red")]))["prompts"] == ["red matched ", "blue wrong "]


@pytest.mark.parametrize("extra", [{"mode": "invalid"}, {"mode": None}, {"color": "red"}, {"color": "#abc"}, {"color": "#٥٥٥٥٥٥"}, {"color": []}])
def test_invalid_inspector_preferences_are_rejected(extra):
    with pytest.raises(ValueError, match="mode or color"):
        prompt_template(state(blocks=[{"id": "a", "name": "Card", "text": "text", **extra}]))


@pytest.mark.parametrize("operator,value,expected", [
    ("equals", " RED COAT ", True), ("equals", "red", False),
    ("contains", "RED", True), ("contains", "blue", False),
    ("not_equals", "red", True), ("not_equals", "red coat", False),
    ("not_contains", "blue", True), ("not_contains", "red", False),
])
def test_condition_operators_compare_only_the_resolved_variant(operator, value, expected):
    condition = {"blockId": "color", "operator": operator, "value": value, "then": {"text": "matched"}}
    raw = state(blocks=[{"id": "color", "name": "Color", "text": "{1::red coat\n|0::blue}"}], parts=[{"condition": condition}])
    assert resolve_prompt(raw)["prompt"] == ("matched" if expected else "")


def test_conditions_reuse_the_checked_insertion_while_repeated_insertions_sample_independently():
    blocks = [{"id": "gender", "name": "Gender", "text": "{~girl|boy}"},
              {"id": "clothes", "name": "Clothes", "text": "{~coat|dress}"}]
    parts = [{"condition": {"blockId": "gender", "operator": "contains", "value": "girl", "then": {"text": "beautiful-girl"}}},
             {"condition": {"blockId": "gender", "operator": "equals", "value": "boy", "then": {"text": "handsome-boy"}}},
             {"text": "\n"}, {"blockId": "gender"}, {"text": ","}, {"blockId": "gender"}, {"text": "\n"},
             {"condition": {"blockId": "gender", "operator": "not_contains", "value": "other", "then": {"blockId": "clothes"}}},
             {"text": ","}, {"blockId": "clothes"}]
    seen, repeated_values, clothing_values = set(), set(), set()
    for seed in range(20):
        raw = state(blocks=blocks, parts=parts, seed=str(seed))
        result = resolve_prompt(raw)
        adjective, genders, clothing = result["prompt"].split("\n")
        gender, repeated = genders.split(",")
        assert gender in {"girl", "boy"} and repeated in {"girl", "boy"}
        assert adjective == ("beautiful-girl" if gender == "girl" else "handsome-boy")
        clothes = tuple(clothing.split(","))
        assert len(clothes) == 2 and set(clothes) <= {"coat", "dress"}
        repeated_values.add((gender, repeated)); clothing_values.add(clothes)
        assert result == resolve_prompt(raw)
        assert VNCCS_PromptDesigner().execute(raw)["result"] == (result["prompt"],) + ("",) * (MAX_PROMPT_OUTPUTS - 1)
        seen.add(gender)
    assert seen == {"girl", "boy"}
    assert any(first != second for first, second in repeated_values)
    assert any(first != second for first, second in clothing_values)


def test_false_condition_does_not_search_the_library_or_resolve_its_output():
    condition = {"blockId": "color", "operator": "contains", "value": "red", "then": {"text": "{unfinished"}}
    raw = state(blocks=[{"id": "color", "name": "Color", "text": "{1::blue|0::red}"}],
                parts=[{"blockId": "color"}, {"condition": condition}])
    assert resolve_prompt(raw)["prompt"] == "blue"


def test_conditional_prompt_keeps_dynamic_prompts_variables_across_fragments():
    condition = {"blockId": "color", "operator": "equals", "value": "red", "then": {"text": "${word}"}}
    raw = state(blocks=[{"id": "color", "name": "Color", "text": "red"}],
                parts=[{"text": "${word=!{beautiful|pretty}}\n"}, {"blockId": "color"}, {"text": "\n"}, {"condition": condition}])
    assert resolve_prompt(raw)["prompt"] in {"\nred\nbeautiful", "\nred\npretty"}


@pytest.mark.parametrize("mode", [None, "random", "cycle"])
@pytest.mark.parametrize("multi", [False, True])
def test_main_variables_remain_available_in_blocks_conditions_and_outputs(mode, multi):
    block = {"id": "color", "name": "Color", "text": "${word}"}
    if mode:
        block["mode"] = mode
    parts = [{"text": "${word=!{red|blue}}"}, {"blockId": "color"},
             {"condition": {"blockId": "color", "operator": "equals", "value": "red", "then": {"text": " ${word}"}}}]
    if multi:
        parts.append({"multiPrompt": {"variants": [[{"text": " ${word} first"}], [{"blockId": "color"}, {"text": " second"}]]}})
    result = resolve_prompt(state(blocks=[block], parts=parts))
    assert result["prompt"].startswith(("red", "blue"))
    if multi:
        assert result["prompts"][0].endswith(("red first", "blue first"))
        assert result["prompts"][1].endswith(("red second", "blue second"))
    assert result == resolve_prompt(state(blocks=[block], parts=parts))


@pytest.mark.parametrize("preview", [False, True])
def test_repeated_variable_doubling_stops_before_unbounded_sampling(monkeypatch, preview):
    from dynamicprompts.sampling_context import SamplingContext
    from nodes.prompt_designer import MAX_EXPANSION_STEPS
    original = SamplingContext.generator_from_command
    calls = 0
    def counted(context, command):
        nonlocal calls
        calls += 1
        assert calls <= MAX_EXPANSION_STEPS
        return original(context, command)
    monkeypatch.setattr(SamplingContext, "generator_from_command", counted)
    text = "${v0=x}" + "".join(f"${{v{i}=${{v{i-1}}}${{v{i-1}}}}}" for i in range(1, 20)) + "${v19}"
    raw = state(blocks=[{"id": "a", "name": "Doubling", "text": text}], parts=[{"blockId": "a"}])
    with pytest.raises(ValueError, match="too complex|64 KiB"):
        preview_block(raw, "a") if preview else resolve_prompt(raw)


def test_condition_can_check_an_empty_block_and_keep_empty_outputs():
    condition = {"blockId": "color", "operator": "not_equals", "value": "red", "then": {"text": "empty"}}
    raw = state(blocks=[{"id": "color", "name": "Color", "text": ""}],
                parts=[{"blockId": "color"}, {"condition": condition}])
    assert resolve_prompt(raw)["prompt"] == "empty"
    condition["then"] = {"text": ""}
    assert resolve_prompt(state(blocks=[{"id": "color", "name": "Color", "text": ""}], parts=[{"condition": condition}]))["prompt"] == ""


def test_else_resolves_when_then_and_the_template_are_empty():
    condition = {"blockId": "gender", "operator": "equals", "value": "girl", "then": {"text": ""},
                 "else": {"parts": [{"text": "other\n"}, {"blockId": "clothes"}]}}
    raw = state(blocks=[{"id": "gender", "name": "Gender", "text": "boy"},
                        {"id": "clothes", "name": "Clothes", "text": "coat"}], parts=[{"condition": condition}])
    assert resolve_prompt(raw)["prompt"] == "other\ncoat"


@pytest.mark.parametrize("first,second,third,expected", [
    (True, False, False, "then"), (False, True, True, "then"),
    (False, True, False, "else"), (False, False, True, "else"),
])
def test_and_binds_before_or_and_all_checks_use_the_sampled_block(first, second, third, expected):
    blocks = [{"id": name, "name": name, "text": "{1::yes|0::no}" if value else "{1::no|0::yes}"}
              for name, value in [("a", first), ("b", second), ("c", third)]]
    condition = {"blockId": "a", "operator": "equals", "value": "yes", "then": {"text": "then"}, "else": {"text": "else"},
                 "clauses": [{"join": join, "blockId": name, "operator": "equals", "value": "yes"}
                             for join, name in [("or", "b"), ("and", "c")]]}
    assert resolve_prompt(state(blocks=blocks, parts=[{"condition": condition}]))["prompt"] == expected


def test_incomplete_condition_drafts_do_not_emit_then_or_else_or_reset_other_parts():
    condition = {"blockId": "", "operator": "", "value": "", "then": {"text": "then"}, "else": {"text": "else"}}
    assert resolve_prompt(state(parts=[{"text": "before\n"}, {"condition": condition}, {"text": "after"}]))["prompt"] == "before\nafter"


@pytest.mark.parametrize("change", [
    {"blockId": "missing"}, {"operator": "eval"}, {"operator": ["equals"]}, {"value": 1},
    {"then": {"blockId": "missing"}}, {"then": {"text": "x", "blockId": "color"}},
    {"then": {"condition": {}}}, {"extra": True},
])
def test_invalid_conditions_are_rejected_at_the_backend_boundary(change):
    condition = {"blockId": "color", "operator": "equals", "value": "red", "then": {"text": "dress"}, **change}
    with pytest.raises(ValueError):
        resolve_prompt(state(blocks=[{"id": "color", "name": "Color", "text": "red"}], parts=[{"condition": condition}]))


def test_invalid_syntax_is_not_silently_passed_downstream():
    with pytest.raises(ValueError, match="Invalid Dynamic Prompts syntax"):
        resolve_prompt(state("{~red|blue"))


@pytest.mark.parametrize("changes", [
    {"version": 2}, {"version": True}, {"version": 1.0}, {"blocks": "invalid"}, {"parts": "invalid"},
    {"parts": [{"blockId": "missing"}]},
    {"parts": [{"text": "okay", "blockId": "missing"}]},
    {"blocks": [{"id": "a", "name": "x", "text": "one"}, {"id": "a", "name": "x", "text": "two"}]},
    {"seed": "-1"}, {"seed": True}, {"seed": "1.5"}, {"seed": "18446744073709551616"},
])
def test_untrusted_state_is_validated(changes):
    with pytest.raises(ValueError):
        prompt_template(state(**changes))


def test_state_and_expanded_prompt_limits():
    with pytest.raises(ValueError, match="too large"):
        prompt_template(" " * (MAX_STATE_CHARS + 1))
    with pytest.raises(ValueError, match="64 KiB"):
        prompt_template(state("x" * (MAX_PROMPT_CHARS + 1)))
    with pytest.raises(ValueError, match="Invalid Prompt Designer JSON"):
        prompt_template("not json")


@pytest.mark.parametrize("text,expected", [
    ("{~watercolor illustration|ink illustration|cel shading}", ["watercolor illustration", "ink illustration", "cel shading"]),
    ("{~{red|blue} coat|shirt}", ["red coat", "blue coat", "shirt"]),
    ("{@standing|sitting}", ["standing", "sitting"]),
    ("{2$$ and $$red|blue}", ["red and blue", "blue and red"]),
    ("{2::red|1::blue|0::green}", ["red", "blue"]),
    ("{~\n coat\n| shirt\n}", ["coat\n", "shirt\n"]),
    ("<script>inert</script>", ["<script>inert</script>"]),
    ("", []),
])
def test_block_preview_enumerates_ready_variants_without_changing_source(text, expected):
    raw = state(blocks=[{"id": "a", "name": "Example", "text": text}], parts=[{"blockId": "a"}])
    before = resolve_prompt(raw)
    assert preview_block(raw, "a") == {"variants": expected, "truncated": False}
    assert resolve_prompt(raw) == before
    assert json.loads(raw)["blocks"][0]["text"] == text


def test_block_preview_limits_rows_and_total_text():
    text = "{~" + "|".join(f"option {index}" for index in range(MAX_BLOCK_VARIANTS + 1)) + "}"
    result = preview_block(state(blocks=[{"id": "a", "name": "Example", "text": text}]), "a")
    assert result == {"variants": [f"option {index}" for index in range(MAX_BLOCK_VARIANTS)], "truncated": True}
    text = "x" * 10_000 + "{~" + "|".join(str(index) for index in range(40)) + "}"
    result = preview_block(state(blocks=[{"id": "a", "name": "Example", "text": text}]), "a")
    assert result["truncated"]
    assert len(result["variants"]) == 26
    assert sum(map(len, result["variants"])) <= MAX_STATE_CHARS


def test_block_preview_rejects_missing_blocks_invalid_syntax_and_oversized_output():
    with pytest.raises(ValueError, match="does not exist"):
        preview_block(state(), "missing")
    for text in ["{~unfinished", "${missing}"]:
        with pytest.raises(ValueError, match="Invalid Dynamic Prompts syntax"):
            preview_block(state(blocks=[{"id": "a", "name": "Example", "text": text}]), "a")
    text = "${a=" + "x" * 33_000 + "} ${a}${a}"
    with pytest.raises(ValueError, match="64 KiB"):
        preview_block(state(blocks=[{"id": "a", "name": "Example", "text": text}]), "a")


def test_preview_route_validates_errors_and_uses_node_resolver():
    load = service_package("vnccs_prompt_designer_api_test")
    route = load("api.prompt_designer_preview")
    async def call(raw, length=None, block_id=None):
        async def read():
            return raw
        request = SimpleNamespace(headers={"Content-Length": str(len(raw) if length is None else length)}, read=read,
                                  query={} if block_id is None else {"block_id": block_id})
        return await route.preview_prompt(request)
    raw = state("first,\n\n{~coat|shirt},\nlast\n").encode()
    response = asyncio.run(call(raw))
    assert response.status == 200
    assert json.loads(response.body) == resolve_prompt(raw.decode())
    assert json.loads(response.body)["prompt"].count("\n") == 4
    assert asyncio.run(call(b"not json")).status == 400
    assert asyncio.run(call(state("{~bad").encode())).status == 400
    assert asyncio.run(call(raw, MAX_STATE_CHARS * 4 + 1)).status == 413
    raw = state(blocks=[{"id": "a", "name": "Clothing", "text": "{~coat|shirt}"}]).encode()
    response = asyncio.run(call(raw, block_id="a"))
    assert response.status == 200
    assert json.loads(response.body) == {"variants": ["coat", "shirt"], "truncated": False}
    assert asyncio.run(call(raw, block_id="missing")).status == 400
    raw = state(blocks=[{"id": "a", "name": "Clothing", "text": "{~unfinished"}]).encode()
    assert asyncio.run(call(raw, block_id="a")).status == 400
    raw = state(blocks=[{"id": "a", "name": "Color", "text": "{1::red|0::blue}"}],
                parts=[{"condition": {"blockId": "a", "operator": "equals", "value": "red", "then": {"text": "beautiful"}}}]).encode()
    response = asyncio.run(call(raw))
    assert response.status == 200
    assert json.loads(response.body) == resolve_prompt(raw.decode())
    assert json.loads(response.body)["prompt"] == "beautiful"
