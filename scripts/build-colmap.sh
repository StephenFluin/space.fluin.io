#!/usr/bin/env bash
# Builds COLMAP's official Docker image with native kernels for your GPU generation.
# The published colmap/colmap image has no sm_120 (RTX 50-series) kernels, so those cards fall
# back to slower JIT-compiled code. Takes 30–60 minutes and ~6 GB of disk.
#
#   scripts/build-colmap.sh            # RTX 50-series (Blackwell, sm_120)
#   CUDA_ARCH=89 scripts/build-colmap.sh   # e.g. RTX 40-series
#
# Then run the app with: COLMAP_DOCKER_IMAGE=colmap-sm${CUDA_ARCH}:${COLMAP_VERSION} npm start
set -euo pipefail

COLMAP_VERSION="${COLMAP_VERSION:-4.2.1}"
CUDA_ARCH="${CUDA_ARCH:-120}"
TAG="colmap-sm${CUDA_ARCH}:${COLMAP_VERSION}"
SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT

git clone --depth 1 --branch "$COLMAP_VERSION" https://github.com/colmap/colmap.git "$SRC"
docker build -f "$SRC/docker/Dockerfile" --target runtime \
  --build-arg CUDA_ARCHITECTURES="$CUDA_ARCH" -t "$TAG" "$SRC"

echo "Built $TAG. Start the app with COLMAP_DOCKER_IMAGE=$TAG"
