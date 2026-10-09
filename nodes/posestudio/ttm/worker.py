"""Run with python -m ttm.worker --family ardy --root <models/text_to_motion>."""
import argparse
from pathlib import Path
from .registry import default_models_dir, load_specs
from .worker_runtime import MotionWorker


def main(default_root=None):
    parser = argparse.ArgumentParser(description="VNCCS ARDY motion worker")
    parser.add_argument("--family", choices=("ardy",), help="serve all ARDY models")
    parser.add_argument("--models", default="", help="comma-separated model ids")
    parser.add_argument("--root", default=str(default_root or default_models_dir()),
                        help="shared ComfyUI models/text_to_motion folder")
    parser.add_argument("--name", default="ardy", help="worker name")
    parser.add_argument("--idle-unload", type=float, default=600.0,
                        help="unload after this many idle seconds (0 keeps the model loaded)")
    args = parser.parse_args()
    specs = load_specs()
    wanted = [value.strip() for value in args.models.split(",") if value.strip()]
    if args.family:
        wanted += [key for key, spec in specs.items() if spec.backend == args.family]
    if not wanted:
        parser.error("pass --family ardy or --models")
    unknown = [value for value in wanted if value not in specs]
    if unknown:
        parser.error(f"unknown model ids: {', '.join(unknown)}")
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    print(f"[motion-worker] {args.name}: sharing {root} with ComfyUI")
    worker = MotionWorker(root, args.name, wanted, idle_unload=args.idle_unload, specs=specs)
    try:
        worker.run()
    except KeyboardInterrupt:
        worker.stop()


if __name__ == "__main__":
    main()
