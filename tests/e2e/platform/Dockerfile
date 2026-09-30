# syntax=docker/dockerfile:1
# ComfyUI test platform for VNCCS + VNCCS_Utils UI verification.
# Lane A (CPU):   docker build -t vnccs-comfyui-test .
# Lane B (CUDA):  docker build --build-arg BASE_IMAGE=runpod/comfyui:cuda12.8 \
#                     --build-arg TORCH_INDEX=preinstalled -t <registry>/comfyui-vnccs-test .
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ARG COMFYUI_REPO=https://github.com/comfyanonymous/ComfyUI
ARG COMFYUI_REF=master
ARG VNCSS_REPO=https://github.com/AHEKOT/ComfyUI_VNCCS
ARG VNCSS_REF=main
ARG VNCSS_UTILS_REPO=https://github.com/M4cd1r/ComfyUI_VNCCS_Utils
ARG VNCSS_UTILS_REF=unicanvas-next
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${COMFYUI_REF} ${COMFYUI_REPO} /opt/ComfyUI

# torch is preinstalled on the CUDA base image; skip the wheel download there.
RUN if [ "${TORCH_INDEX}" != "preinstalled" ]; then \
      pip install --no-cache-dir torch torchvision --index-url ${TORCH_INDEX}; \
    fi \
 && pip install --no-cache-dir -r /opt/ComfyUI/requirements.txt

RUN git clone --depth 1 --branch ${VNCSS_REF} ${VNCSS_REPO} /opt/ComfyUI/custom_nodes/ComfyUI_VNCCS \
 && git clone --depth 1 --branch ${VNCSS_UTILS_REF} ${VNCSS_UTILS_REPO} /opt/ComfyUI/custom_nodes/ComfyUI_VNCCS_Utils

# Install every custom-node requirement except llama-cpp-python: it is imported
# lazily inside node functions (so the UI lane never needs it), while the
# published sdist has no prebuilt wheel and compiling it needs a full CMake
# toolchain. Dropping it keeps the image buildable on plain python:3.12-slim.
RUN find /opt/ComfyUI/custom_nodes -maxdepth 2 -name 'requirements.txt' -print | while read -r req; do \
      filtered="/tmp/$(basename "$(dirname "$req")")-requirements.txt"; \
      grep -v -i '^llama-cpp-python' "$req" > "$filtered"; \
      pip install --no-cache-dir -r "$filtered"; \
    done

# The GUI opencv-python wheel needs X11/XCB shared libraries that the slim base
# does not ship (and this image is headless anyway). transparent-background
# depends on albumentations -> opencv-python, so pin the headless build last to
# make sure the headless cv2 is the one that survives.
RUN pip uninstall -y opencv-python opencv-python-headless \
 && pip install --no-cache-dir opencv-python-headless

# Build-time sanity boot: fails the build if a custom node cannot import (e.g. CUDA-only import).
RUN python /opt/ComfyUI/main.py --cpu --quick-test-for-ci

EXPOSE 8188
WORKDIR /opt/ComfyUI
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188", "--cpu"]
