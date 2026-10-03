"""Isolated text-to-motion worker for VNCCS Pose Studio.

Runs the motion models in their own Python environment (a venv made by install.sh /
install.bat, or the Docker image) so their pinned torch / transformers / numpy
versions never touch ComfyUI's Python. ComfyUI and the worker talk through job files
in <ComfyUI>/models/text_to_motion (see api/text_to_motion/worker_protocol.py).

    python worker.py --family ardy                 # serve every ARDY model
    python worker.py --models kimodo-soma-rp-v1.1  # serve listed model ids
"""

import argparse
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE_DIR = HERE.parent / "api" / "text_to_motion"
PACKAGE = "vnccs_text_to_motion"


def load_package():
    spec = importlib.util.spec_from_file_location(
        PACKAGE, PACKAGE_DIR / "__init__.py", submodule_search_locations=[str(PACKAGE_DIR)],
    )
    package = importlib.util.module_from_spec(spec)
    sys.modules[PACKAGE] = package
    spec.loader.exec_module(package)
    modules = {}
    for name in ("registry", "worker_runtime"):
        sub = importlib.util.spec_from_file_location(f"{PACKAGE}.{name}", PACKAGE_DIR / f"{name}.py")
        module = importlib.util.module_from_spec(sub)
        sys.modules[sub.name] = module
        sub.loader.exec_module(module)
        modules[name] = module
    return modules


def main():
    parser = argparse.ArgumentParser(description="VNCCS Pose Studio motion worker")
    parser.add_argument("--family", help="backend family to serve: ardy, kimodo, hymotion or unimate")
    parser.add_argument("--models", default="", help="comma-separated model ids (default: all of --family)")
    parser.add_argument("--root", default=str(HERE.parent.parent.parent / "models" / "text_to_motion"),
                        help="ComfyUI's models/text_to_motion folder (shared with ComfyUI)")
    parser.add_argument("--name", default="", help="worker name (default: the family)")
    parser.add_argument("--idle-unload", type=float, default=600.0,
                        help="free the model after this many seconds without jobs (0 = keep it loaded)")
    args = parser.parse_args()

    modules = load_package()
    specs = modules["registry"].load_specs()
    wanted = [m.strip() for m in args.models.split(",") if m.strip()]
    if args.family:
        wanted += [key for key, spec in specs.items() if spec.backend == args.family]
    if not wanted:
        parser.error("pass --family or --models")
    unknown = [m for m in wanted if m not in specs]
    if unknown:
        parser.error(f"unknown model ids: {', '.join(unknown)}")
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    name = args.name or args.family or "worker"
    print(f"[motion-worker] {name}: sharing {root} with ComfyUI")
    worker = modules["worker_runtime"].MotionWorker(root, name, wanted, idle_unload=args.idle_unload, specs=specs)
    try:
        worker.run()
    except KeyboardInterrupt:
        worker.stop()


if __name__ == "__main__":
    main()
