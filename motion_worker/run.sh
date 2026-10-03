#!/usr/bin/env sh
# Start the motion worker for one family; keep it running next to ComfyUI.
#   ./run.sh ardy
set -e
cd "$(dirname "$0")"
FAMILY="$1"; shift || true
exec "envs/$FAMILY/bin/python" worker.py --family "$FAMILY" "$@"
