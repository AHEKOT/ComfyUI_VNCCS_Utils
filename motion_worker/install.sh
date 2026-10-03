#!/usr/bin/env sh
# Create the isolated venv for one motion model family (nothing goes into ComfyUI's Python):
#   ./install.sh ardy            (or kimodo, hymotion, unimate)
#   TORCH_INDEX=https://download.pytorch.org/whl/cu124 ./install.sh hymotion
# Uses uv when it is installed (it also downloads Python 3.11 if needed, like ComfyUI Desktop),
# otherwise the system python3 with the standard venv module.
set -e
cd "$(dirname "$0")"
FAMILY="$1"
if [ ! -f "requirements/$FAMILY.txt" ]; then
  echo "usage: $0 ardy|kimodo|hymotion|unimate"; exit 1
fi
INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu126}"
ENV="envs/$FAMILY"
ENV_PY="$ENV/bin/python"
if command -v uv >/dev/null 2>&1; then
  uv venv --python "${PYTHON_VERSION:-3.11}" --seed "$ENV"
  uv pip install --python "$ENV_PY" "setuptools<81" wheel
  uv pip install --python "$ENV_PY" torch --index-url "$INDEX"
  uv pip install --python "$ENV_PY" --no-build-isolation -r "requirements/$FAMILY.txt"
else
  PY="${PYTHON:-python3}"
  if ! command -v "$PY" >/dev/null 2>&1; then
    echo "No Python found. Install uv (it brings its own Python), then run this again:"
    echo "  curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
  fi
  "$PY" -m venv "$ENV"
  "$ENV_PY" -m pip install --upgrade pip "setuptools<81" wheel
  "$ENV_PY" -m pip install torch --index-url "$INDEX"
  "$ENV_PY" -m pip install --no-build-isolation -r "requirements/$FAMILY.txt"
fi
echo
echo "Done. Start the worker with: $(pwd)/run.sh $FAMILY"
case "$FAMILY" in ardy|kimodo) echo "Gated text encoder: run '$(pwd)/$ENV/bin/hf auth login' once.";; esac
