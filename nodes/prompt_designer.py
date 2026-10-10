"""Workflow-owned prompt blocks and seeded Dynamic Prompts rendering."""

import json
import re
from dataclasses import fields, is_dataclass, replace

MAX_STATE_CHARS = 256 * 1024
MAX_PROMPT_CHARS = 64 * 1024
MAX_SEED = (1 << 64) - 1
MAX_BLOCK_VARIANTS = 256
MAX_PROMPT_OUTPUTS = 16
MAX_EXPANSION_STEPS = 16 * 1024


def prompt_template(node_state):
    if not isinstance(node_state, str) or len(node_state) > MAX_STATE_CHARS:
        raise ValueError("Prompt Designer state is too large or is not JSON text.")
    try:
        state = json.loads(node_state)
    except (ValueError, TypeError) as exc:
        raise ValueError("Invalid Prompt Designer JSON.") from exc
    if not isinstance(state, dict) or type(state.get("version", 1)) is not int or state.get("version", 1) != 1:
        raise ValueError("Unsupported Prompt Designer state.")
    if "promptTabs" in state:
        tabs = state["promptTabs"]
        if not isinstance(tabs, list) or not 1 <= len(tabs) <= 128:
            raise ValueError("Invalid prompt tabs.")
        prompt_ids = set()
        for tab in tabs:
            if (not isinstance(tab, dict) or not isinstance(tab.get("id"), str)
                    or not re.fullmatch(r"[0-9a-f]{32}", tab["id"]) or tab["id"] in prompt_ids
                    or type(tab.get("dirty")) is not bool or not isinstance(tab.get("seed"), str) or len(tab["seed"]) > 128
                    or tab.get("afterGenerate") not in ("fixed", "randomize") or not isinstance(tab.get("parts"), list)):
                raise ValueError("Invalid prompt tab.")
            details = tab.get("details", {})
            if (not isinstance(details, dict) or not set(details) <= {"id", "revision", "name", "category", "color"}
                    or any(key in details and (not isinstance(details[key], str) or len(details[key]) > 128) for key in ("name", "category"))
                    or ("color" in details and (not isinstance(details["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", details["color"])))
                    or ("id" in details and (not isinstance(details["id"], str) or not re.fullmatch(r"[0-9a-f]{32}", details["id"])
                        or type(details.get("revision")) is not int or not 0 <= details["revision"] <= 2**53 - 1))
                    or ("revision" in details and "id" not in details)):
                raise ValueError("Invalid prompt template details.")
            if "templateId" in tab and (tab["templateId"] != details.get("id") or not details.get("revision", 0) > 0):
                raise ValueError("Invalid opened prompt template.")
            prompt_ids.add(tab["id"])
            # Inactive tabs are drafts; validate their content without executing an unfinished seed.
            prompt_template(json.dumps({"version": 1, "categories": state.get("categories", []), "blocks": state.get("blocks", []),
                "parts": tab["parts"], "seed": "0", "cycleIndex": tab.get("cycleIndex", -1)}, ensure_ascii=False))
        if not isinstance(state.get("activePrompt"), str) or state["activePrompt"] not in prompt_ids:
            raise ValueError("The active prompt tab is missing.")
    categories = state.get("categories", [])
    if not isinstance(categories, list) or len(categories) > 128:
        raise ValueError("The library supports up to 128 categories.")
    category_names = set()
    for category in categories:
        if (not isinstance(category, dict) or not isinstance(category.get("name"), str)
                or not category["name"].strip() or len(category["name"]) > 128
                or category["name"].lower() in category_names
                or ("color" in category and (not isinstance(category["color"], str)
                    or not re.fullmatch(r"#[0-9a-fA-F]{6}", category["color"])))):
            raise ValueError("Invalid or duplicate category.")
        category_names.add(category["name"].lower())
    blocks, parts = state.get("blocks", []), state.get("parts", [])
    if not isinstance(blocks, list) or len(blocks) > 256:
        raise ValueError("The block library supports up to 256 blocks.")
    if not isinstance(parts, list) or len(parts) > 4096:
        raise ValueError("The prompt contains too many fragments.")
    library = {}
    for block in blocks:
        if (not isinstance(block, dict) or not isinstance(block.get("id"), str)
                or not block["id"] or block["id"] in library
                or not isinstance(block.get("name"), str)
                or not isinstance(block.get("text"), str)
                or len(block["id"]) > 128 or len(block["name"]) > 128
                or len(block["text"]) > MAX_PROMPT_CHARS):
            raise ValueError("Invalid or duplicate prompt block.")
        library[block["id"]] = block["text"]
        if "category" in block and (not isinstance(block["category"], str) or len(block["category"]) > 128):
            raise ValueError("Invalid block category.")
        if ("mode" in block and block["mode"] not in ("random", "cycle")) or (
                "color" in block and (not isinstance(block["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", block["color"]))):
            raise ValueError("Invalid block sampling mode or color.")
    fragments = []
    lengths = [0] * MAX_PROMPT_OUTPUTS
    for part in parts:
        variant_lengths = None
        if not isinstance(part, dict):
            raise ValueError("Invalid prompt fragment.")
        if set(part) == {"text"} and isinstance(part["text"], str):
            text = part["text"]
        elif set(part) == {"blockId"} and isinstance(part["blockId"], str) and part["blockId"] in library:
            text = library[part["blockId"]]
        elif set(part) == {"multiPrompt"}:
            multi = part["multiPrompt"]
            if (not isinstance(multi, dict) or set(multi) != {"variants"} or not isinstance(multi["variants"], list)
                    or not 2 <= len(multi["variants"]) <= MAX_PROMPT_OUTPUTS):
                raise ValueError(f"Multi-prompt requires 2–{MAX_PROMPT_OUTPUTS} variants.")
            choices = []
            for variant in multi["variants"]:
                if not isinstance(variant, list) or len(variant) > 4096:
                    raise ValueError("Invalid multi-prompt variant.")
                values = []
                for item in variant:
                    if isinstance(item, dict) and set(item) == {"text"} and isinstance(item["text"], str):
                        values.append(item["text"])
                    elif (isinstance(item, dict) and set(item) == {"blockId"} and isinstance(item["blockId"], str)
                          and item["blockId"] in library):
                        values.append(library[item["blockId"]])
                    else:
                        raise ValueError("Multi-prompt variants accept text and existing blocks only.")
                choices.append("".join(values))
            text = choices[0]
            variant_lengths = [len(choices[index]) if index < len(choices) else 0 for index in range(MAX_PROMPT_OUTPUTS)]
        elif set(part) == {"condition"}:
            condition = part["condition"]
            if (not isinstance(condition, dict) or not {"blockId", "operator", "value", "then"} <= set(condition)
                    or not set(condition) <= {"blockId", "operator", "value", "then", "else", "clauses"}
                    or not isinstance(condition["blockId"], str) or (condition["blockId"] and condition["blockId"] not in library)
                    or condition["operator"] not in ("", "contains", "equals", "not_equals", "not_contains")
                    or not isinstance(condition["value"], str) or len(condition["value"]) > MAX_PROMPT_CHARS
                    or not isinstance(condition["then"], dict)):
                raise ValueError("Invalid prompt condition.")
            if "clauses" in condition:
                clauses = condition["clauses"]
                if not isinstance(clauses, list) or len(clauses) > 64:
                    raise ValueError("A condition supports up to 64 additional checks.")
                for clause in clauses:
                    if (not isinstance(clause, dict) or set(clause) != {"join", "blockId", "operator", "value"}
                            or clause["join"] not in ("and", "or") or not isinstance(clause["blockId"], str)
                            or (clause["blockId"] and clause["blockId"] not in library)
                            or clause["operator"] not in ("", "contains", "equals", "not_equals", "not_contains")
                            or not isinstance(clause["value"], str) or len(clause["value"]) > MAX_PROMPT_CHARS):
                        raise ValueError("Invalid additional condition check.")
            outputs = []
            for branch in ("then", "else"):
                if branch not in condition:
                    continue
                output = condition[branch]
                if not isinstance(output, dict):
                    raise ValueError("Invalid condition output.")
                if set(output) == {"text"} and isinstance(output["text"], str):
                    outputs.append(output["text"])
                elif set(output) == {"blockId"} and isinstance(output["blockId"], str) and output["blockId"] in library:
                    outputs.append(library[output["blockId"]])
                elif set(output) == {"parts"} and isinstance(output["parts"], list) and len(output["parts"]) <= 4096:
                    values = []
                    for item in output["parts"]:
                        if isinstance(item, dict) and set(item) == {"text"} and isinstance(item["text"], str):
                            values.append(item["text"])
                        elif (isinstance(item, dict) and set(item) == {"blockId"} and isinstance(item["blockId"], str)
                              and item["blockId"] in library):
                            values.append(library[item["blockId"]])
                        else:
                            raise ValueError("Condition output accepts text and existing blocks only.")
                    outputs.append("".join(values))
                else:
                    raise ValueError("The condition references a missing block or an invalid output.")
            text = outputs[0]
            variant_lengths = [max(map(len, outputs))] * MAX_PROMPT_OUTPUTS
        else:
            raise ValueError("The prompt references a missing block or an invalid fragment.")
        lengths = [length + (variant_lengths[index] if variant_lengths is not None else len(text)) for index, length in enumerate(lengths)]
        if max(lengths) > MAX_PROMPT_CHARS:
            raise ValueError("The expanded prompt exceeds 64 KiB.")
        fragments.append(text)
    raw_seed = state.get("seed", "0")
    if isinstance(raw_seed, bool) or not isinstance(raw_seed, (str, int)):
        raise ValueError("Seed must be an unsigned 64-bit integer.")
    if not str(raw_seed).isascii() or not str(raw_seed).isdigit() or len(str(raw_seed)) > 20:
        raise ValueError("Seed must be an unsigned 64-bit integer.")
    seed = int(raw_seed)
    if seed > MAX_SEED:
        raise ValueError("Seed must be an unsigned 64-bit integer.")
    cycle_index = state.get("cycleIndex", -1)
    if type(cycle_index) is not int or not -1 <= cycle_index <= 2**53 - 1:
        raise ValueError("Invalid cycle position.")
    return "".join(fragments), seed


def bounded_sampling_context(seed=0, method=None):
    from random import Random
    from dynamicprompts.enums import SamplingMethod
    from dynamicprompts.sampling_context import SamplingContext
    from dynamicprompts.wildcards import WildcardManager

    budget = [0, 0]
    cycle_position = [0]

    class BoundedContext(SamplingContext):
        def reset_budget(self, position=0):
            budget[:] = [0, 0]
            cycle_position[0] = position

        def process_variable_assignment(self, command):
            if command.immediate and cycle_position[0] and (command.overwrite or command.name not in self.variables):
                position = cycle_position[0] % cycle_period(command.value, self, cycle_position[0])
                if position:
                    from dynamicprompts.commands import LiteralCommand
                    results = self.generator_from_command(command.value)
                    for _ in range(position):
                        next(results)
                    return LiteralCommand(str(next(results)))
            return super().process_variable_assignment(command)

        def generator_from_command(self, command):
            # Bound intermediate work before the library builds a large final string.
            budget[0] += 1
            if budget[0] > MAX_EXPANSION_STEPS:
                raise ValueError("Dynamic Prompts expansion is too complex.")
            for result in super().generator_from_command(command):
                budget[0] += 1
                if budget[0] > MAX_EXPANSION_STEPS:
                    raise ValueError("Dynamic Prompts expansion is too complex.")
                budget[1] += len(result.text)
                if len(result.text) > MAX_PROMPT_CHARS:
                    raise ValueError("The resolved prompt exceeds 64 KiB.")
                if budget[1] > MAX_STATE_CHARS * 4:
                    raise ValueError("Dynamic Prompts expansion is too complex.")
                yield result

    return BoundedContext(default_sampling_method=method or SamplingMethod.RANDOM,
                          wildcard_manager=WildcardManager(), rand=Random(seed))


def block_command(command):
    from dynamicprompts.commands import LiteralCommand, SequenceCommand, VariantCommand
    if isinstance(command, SequenceCommand):
        tokens = [token for token in command.tokens
                  if not (isinstance(token, LiteralCommand) and not token.literal.strip())]
        # Whitespace surrounding a choice block is source formatting, not prompt text.
        if len(tokens) == 1 and isinstance(tokens[0], VariantCommand):
            return tokens[0]
    return command


def resolve_prompt(node_state):
    template, seed = prompt_template(node_state)
    state = json.loads(node_state)
    multi_prompt = any("multiPrompt" in part for part in state.get("parts", []))
    has_conditions = any("condition" in part for part in state.get("parts", []))
    if not template and not multi_prompt and not has_conditions:
        return {"template": "", "prompt": ""}
    try:
        from dynamicprompts.commands import SequenceCommand
        from dynamicprompts.parser.parse import parse
        from pyparsing import ParseBaseException
        context = bounded_sampling_context(seed)
    except ImportError as exc:
        raise RuntimeError("Prompt Designer requires dynamicprompts. Install the VNCCS Utils requirements.") from exc
    # Each insertion samples separately; checks reuse the selected insertion.
    try:
        def join_bounded(fragments):
            values, length = [], 0
            for text in fragments:
                length += len(text)
                if length > MAX_PROMPT_CHARS:
                    raise ValueError("The resolved prompt exceeds 64 KiB.")
                values.append(text)
            return "".join(values)

        def sample(text, method=None, offset=0):
            nonlocal context
            if not text:
                return ""
            position = max(0, state.get("cycleIndex", -1)) + offset
            context.reset_budget(position)
            command = parse(text) if isinstance(text, str) else text
            if method is not None:
                command = choice_mode(command, method)
            tokens, context = context.process_variable_assignments(command.tokens if isinstance(command, SequenceCommand) else [command])
            if not tokens:
                return ""
            command = replace(command, tokens=tokens) if isinstance(command, SequenceCommand) else SequenceCommand(tokens)
            if position:
                position %= cycle_period(command, context, position)
            results = iter(context.sample_prompts(command))
            for _ in range(position):
                next(results)
            return str(next(results))

        from dynamicprompts.enums import SamplingMethod
        parts = state.get("parts", [])
        count = max((len(part["multiPrompt"]["variants"]) for part in parts if "multiPrompt" in part), default=1)
        library = {block["id"]: block["text"] for block in state.get("blocks", [])}
        modes = {block["id"]: block["mode"] for block in state.get("blocks", []) if "mode" in block}
        selected = [{} for _ in range(count)]
        values, occurrences = {}, {}

        def block_value(block_id, key, output=None):
            if key not in values:
                mode = modes.get(block_id)
                method = None if mode is None else SamplingMethod.CYCLICAL if mode == "cycle" else SamplingMethod.RANDOM
                offset = occurrences.get(block_id, 0)
                values[key] = sample(block_command(parse(library[block_id])), method, offset)
                occurrences[block_id] = offset + 1
            for index in range(count) if output is None else [output]:
                selected[index][block_id] = values[key]
            return values[key]

        def checked_value(block_id, key, output):
            if block_id in selected[output]:
                return selected[output][block_id]
            # A forward check reserves the next insertion, without choosing it again later.
            for position in range(key[0] + 1, len(parts)):
                part = parts[position]
                if part.get("blockId") == block_id:
                    return block_value(block_id, (position,), output)
                if "multiPrompt" in part:
                    variants = part["multiPrompt"]["variants"]
                    for index, item in enumerate(variants[output] if output < len(variants) else []):
                        if item.get("blockId") == block_id:
                            return block_value(block_id, (position, output, index), output)
            return block_value(block_id, (*key, "check", block_id), output)

        def fragment(part, key, output=None):
            if "text" in part:
                if key not in values:
                    values[key] = sample(part["text"])
                return values[key]
            if "blockId" in part:
                return block_value(part["blockId"], key, output)
            condition = part["condition"]
            checks = [condition, *condition.get("clauses", [])]
            if any(not check["blockId"] or not check["operator"] or not check["value"].strip() for check in checks):
                return ""
            matches, group = False, True
            for index, check in enumerate(checks):
                actual = checked_value(check["blockId"], key, output).strip().casefold()
                expected = check["value"].strip().casefold()
                operator = check["operator"]
                result = actual == expected if operator in ("equals", "not_equals") else expected in actual
                if operator in ("not_equals", "not_contains"):
                    result = not result
                # AND binds more tightly than OR.
                if index and check["join"] == "or":
                    matches = matches or group
                    group = result
                else:
                    group = group and result
            branch = "then" if matches or group else "else"
            branch_parts = condition.get(branch)
            if branch_parts is None:
                return ""
            return join_bounded(fragment(item, (*key, branch, index), output)
                                for index, item in enumerate(branch_parts.get("parts", [branch_parts])))

        segments = []
        lengths = [0] * count
        for position, part in enumerate(parts):
            if "multiPrompt" in part:
                segment = [join_bounded(fragment(item, (position, output, index), output)
                                        for index, item in enumerate(variant))
                           for output, variant in enumerate(part["multiPrompt"]["variants"])]
            elif "condition" in part:
                segment = [fragment(part, (position,), output) for output in range(count)]
            else:
                segment = fragment(part, (position,))
            for index in range(count):
                lengths[index] += len(segment if isinstance(segment, str) else segment[index] if index < len(segment) else "")
                if lengths[index] > MAX_PROMPT_CHARS:
                    raise ValueError("The resolved prompt exceeds 64 KiB.")
            segments.append(segment)
        prompts = ["".join(segment if isinstance(segment, str) else segment[index] if index < len(segment) else ""
                           for segment in segments) for index in range(count)]
        if multi_prompt:
            return {"template": template, "prompt": prompts[0], "prompts": prompts}
        prompt = prompts[0]
    except (ParseBaseException, RecursionError, KeyError) as exc:
        raise ValueError(f"Invalid Dynamic Prompts syntax: {exc}") from exc
    return {"template": template, "prompt": prompt}


def cycle_period(command, context, position):
    """Bound the native cycle period so old workflows never require replaying every past queue."""
    from collections import Counter
    from math import factorial, lcm
    from dynamicprompts.commands import SequenceCommand, VariantCommand
    from dynamicprompts.commands.variable_commands import VariableAccessCommand, VariableAssignmentCommand
    from dynamicprompts.enums import SamplingMethod

    steps = 0

    def period(value, variables, method, visiting=()):
        nonlocal steps
        steps += 1
        if steps > MAX_EXPANSION_STEPS:
            raise ValueError("Dynamic Prompts expansion is too complex.")
        method = getattr(value, "sampling_method", None) or method
        if isinstance(value, VariableAccessCommand):
            if value.name in visiting:
                raise RecursionError("Recursive Dynamic Prompts variable.")
            return period(variables.get(value.name, value.default), variables, method, (*visiting, value.name))
        if isinstance(value, SequenceCommand):
            variables = dict(variables)
            lengths = []
            for token in value.tokens:
                if isinstance(token, VariableAssignmentCommand):
                    variables[token.name] = None if token.immediate else token.value
                else:
                    lengths.append(period(token, variables, method, visiting))
            return min(position + 1, lcm(*lengths))
        if isinstance(value, VariantCommand):
            command = value.adjust_range()
            length = lcm(*(period(item, variables, method, visiting) for item in command.values))
            if method == SamplingMethod.CYCLICAL:
                coefficients = [1] + [0] * command.max_bound
                for multiplicity in Counter(map(repr, command.values)).values():
                    steps += command.max_bound
                    if steps > MAX_EXPANSION_STEPS:
                        raise ValueError("Dynamic Prompts expansion is too complex.")
                    for size in range(command.max_bound, 0, -1):
                        coefficients[size] = min(position + 1, coefficients[size] + coefficients[size - 1] * multiplicity)
                length *= sum(factorial(size) * coefficients[size] for size in range(command.min_bound, command.max_bound + 1))
            return max(1, min(position + 1, length))
        return 1

    return period(command, context.variables, context.default_sampling_method)


def choice_mode(value, method):
    """Change parsed choice modes while retaining bounds, weights and separators."""
    if isinstance(value, list):
        return [choice_mode(item, method) for item in value]
    if not is_dataclass(value):
        return value
    return replace(value, **{field.name: method if field.name == "sampling_method"
                            else choice_mode(getattr(value, field.name), method) for field in fields(value)})


def preview_block(node_state, block_id):
    prompt_template(node_state)
    block = next((item for item in json.loads(node_state).get("blocks", []) if item["id"] == block_id), None)
    if block is None:
        raise ValueError("The prompt block does not exist.")
    if not block["text"]:
        return {"variants": [], "truncated": False}
    try:
        from dynamicprompts.enums import SamplingMethod
        from dynamicprompts.parser.parse import parse
        from pyparsing import ParseBaseException
    except ImportError as exc:
        raise RuntimeError("Prompt Designer requires dynamicprompts. Install the VNCCS Utils requirements.") from exc

    def enumerate_choices(value):
        # Enumerate source choices without changing saved sampling modes or weights.
        if isinstance(value, list):
            return [enumerate_choices(item) for item in value]
        if not is_dataclass(value):
            return value
        changes = {}
        for field in fields(value):
            item = getattr(value, field.name)
            if field.name == "sampling_method":
                changes[field.name] = SamplingMethod.COMBINATORIAL
            elif field.name == "variants":
                changes[field.name] = [enumerate_choices(option) for option in item if option.weight > 0]
            else:
                changes[field.name] = enumerate_choices(item)
        return replace(value, **changes)

    variants = []
    length = 0
    try:
        command = enumerate_choices(block_command(parse(block["text"])))
        # shortcut: Immediate variables preview their first choice; expand assignment contexts if exhaustive variable previews are needed.
        context = bounded_sampling_context(method=SamplingMethod.COMBINATORIAL)
        # Bound both row count and total preview text; do not enumerate a whole Cartesian product.
        for result in context.sample_prompts(command, MAX_BLOCK_VARIANTS + 1):
            text = str(result)
            if len(text) > MAX_PROMPT_CHARS:
                raise ValueError("The resolved variant exceeds 64 KiB.")
            length += len(text)
            if len(variants) == MAX_BLOCK_VARIANTS or length > MAX_STATE_CHARS:
                return {"variants": variants, "truncated": True}
            variants.append(text)
    except (ParseBaseException, RecursionError, KeyError) as exc:
        raise ValueError(f"Invalid Dynamic Prompts syntax: {exc}") from exc
    return {"variants": variants, "truncated": False}


class VNCCS_PromptDesigner:
    @classmethod
    def INPUT_TYPES(cls):
        from .prompt_designer_defaults import default_node_state
        return {"required": {"node_state": ("STRING", {"default": default_node_state(), "multiline": False, "dynamicPrompts": False})}}

    # Reserve typed slots for ComfyUI validation; the widget exposes only active outputs.
    RETURN_TYPES = ("STRING",) * MAX_PROMPT_OUTPUTS
    RETURN_NAMES = ("prompt",) + tuple(f"prompt{index}" for index in range(2, MAX_PROMPT_OUTPUTS + 1))
    FUNCTION = "execute"
    CATEGORY = "VNCCS/prompt"
    DESCRIPTION = "Compose text and reusable random blocks in an automatically saved tabbed editor."

    def execute(self, node_state="{}"):
        result = resolve_prompt(node_state)
        prompts = result.get("prompts", [result["prompt"]])
        return {"ui": {"prompt": [prompts[0]], "prompts": prompts},
                "result": tuple(prompts) + ("",) * (MAX_PROMPT_OUTPUTS - len(prompts))}
