"""Bundled Pose Studio workflows keep their standard loader wiring intact."""

import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("filename", ["VNCCS_Utils Pose Studio QWEN.json", "VNCCS_Utils Pose Studio Klein9b.json"])
def test_bundled_workflows_use_standard_lora_loaders_with_valid_links(filename):
    workflow = json.loads((ROOT / "workflows" / filename).read_text())
    graphs = [workflow, *workflow.get("definitions", {}).get("subgraphs", [])]
    loaders = []
    for graph in graphs:
        nodes = {node["id"]: node for node in graph["nodes"]}
        assert all(node["type"] not in {"VNCCS_ModelManager", "VNCCS_ModelSelector"} for node in nodes.values())
        for node in nodes.values():
            if node["type"] == "LoraLoaderModelOnly":
                loaders.append(node)
                assert node["widgets_values"][0].endswith(".safetensors")
        for link in graph["links"]:
            if isinstance(link, list):
                link_id, source, source_slot, target, target_slot, _kind = link
            else:
                link_id, source, source_slot, target, target_slot = (link[k] for k in ("id", "origin_id", "origin_slot", "target_id", "target_slot"))
            if source == graph.get("inputNode", {}).get("id"):
                assert link_id in graph["inputs"][source_slot]["linkIds"]
            else:
                assert link_id in nodes[source]["outputs"][source_slot]["links"]
            if target == graph.get("outputNode", {}).get("id"):
                assert link_id in graph["outputs"][target_slot]["linkIds"]
            else:
                assert nodes[target]["inputs"][target_slot]["link"] == link_id
    assert loaders
