#!/usr/bin/env sh
# Create the isolated environment for one motion model family:
#   ./install.sh ardy            (or kimodo, hymotion, unimate)
#   TORCH_INDEX=https://download.pytorch.org/whl/cu124 ./install.sh hymotion
# Nothing is installed into ComfyUI's Python.
set -e
cd "$(dirname "$0")"
FAMILY="$1"
if [ ! -f "requirements/$FAMILY.txt" ]; then
  echo "usage: $0 ardy|kimodo|hymotion|unimate"; exit 1
fi
PY="${PYTHON:-python3}"
INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu126}"
"$PY" -m venv "envs/$FAMILY"
ENV_PY="envs/$FAMILY/bin/python"
"$ENV_PY" -m pip install --upgrade pip "setuptools<81" wheel
"$ENV_PY" -m pip install torch --index-url "$INDEX"
"$ENV_PY" -m pip install --no-build-isolation -r "requirements/$FAMILY.txt"
echo
echo "Done. Start the worker with: $(pwd)/run.sh $FAMILY"
case "$FAMILY" in ardy|kimodo) echo "Gated text encoder: run '$(pwd)/envs/$FAMILY/bin/hf auth login' once.";; esac
