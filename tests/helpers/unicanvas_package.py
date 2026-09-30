"""Load the nodes/unicanvas package under a private name for isolated tests."""

import importlib.util
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
UNICANVAS_DIR = ROOT / "nodes" / "unicanvas"


def load_unicanvas_package(parent, torch_module=None):
    """Import nodes/unicanvas as ``<parent>.unicanvas``, with ``<parent>`` mapped onto nodes/.

    The private parent keeps these copies apart from the real ``nodes.unicanvas``
    modules (so a stub torch never leaks into them), while the package's relative
    imports that reach nodes/ (for example ``...vncss_config``) still resolve.
    ``torch_module`` replaces ``torch`` only while the package is imported, so the
    suites also run on hosts without torch. Submodules are attributes of the
    returned package (``package.render``, ``package.models.registry`` ...).
    """
    if parent not in sys.modules:
        shell = types.ModuleType(parent)
        shell.__path__ = [str(ROOT / "nodes")]
        sys.modules[parent] = shell
    name = f"{parent}.unicanvas"
    if name in sys.modules:
        return sys.modules[name]
    previous_torch = sys.modules.get("torch")
    if torch_module is not None:
        sys.modules["torch"] = torch_module
    try:
        spec = importlib.util.spec_from_file_location(
            name, UNICANVAS_DIR / "__init__.py", submodule_search_locations=[str(UNICANVAS_DIR)]
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        if torch_module is not None:
            if previous_torch is None:
                sys.modules.pop("torch", None)
            else:
                sys.modules["torch"] = previous_torch
