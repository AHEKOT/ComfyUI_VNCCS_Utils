#!/usr/bin/env bash
# Used for creating TensorFlow SavedModel tar files that can be loaded directly using
# tensorflow_hub.load() from a URL.

# Usage: bash package_model.sh "$path_to_savedmodel_directory"
# This will create a file named "$path_to_savedmodel_directory".tar.gz

set -euo pipefail
tar -C "$1" --xform s:\\./\\?:: -czf "$1.tar.gz" .
