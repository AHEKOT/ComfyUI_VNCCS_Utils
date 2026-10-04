#!/usr/bin/env sh
# Start the motion worker for one family; keep it running next to ComfyUI.
#   ./run.sh hymotion
set -e
cd "$(dirname "$0")"
# Weights go to ComfyUI's models folder, not the user-wide Hugging Face cache (the hf login stays where it is).
export HF_HUB_CACHE="${HF_HUB_CACHE:-$(pwd)/../../../models/text_to_motion/hf_cache}"
FAMILY="$1"; shift || true
exec "envs/$FAMILY/bin/python" worker.py --family "$FAMILY" "$@"
