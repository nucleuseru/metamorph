# syntax=docker/dockerfile:1.7
# Multi-target Dockerfile for metamorph-engine:
#   - mock  : Lightweight CPU mock image for local apps/api & apps/web dev
#   - voice : Slim CUDA 12.8 runtime image for voice-only instances (Seed-VC)
#   - full  : Full CUDA 12.8 devel image for RV2V + voice instances (JoyAI-Video-Edit + joyomni_ops + Seed-VC)
#
# Always build with the repository root as build context:
#   docker build -f apps/engine-py/Dockerfile --target full -t metamorph-engine:full .

FROM ghcr.io/astral-sh/uv:0.12 AS uv-bin

# ==============================================================================
# Stage 1: Lightweight CPU mock backend
# ==============================================================================
FROM python:3.12-slim AS mock

COPY --from=uv-bin /uv /uvx /usr/local/bin/

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml uv.lock .python-version ./
COPY packages/shared-py/pyproject.toml ./packages/shared-py/pyproject.toml
COPY apps/engine-py/pyproject.toml ./apps/engine-py/pyproject.toml

RUN uv sync --frozen --no-dev --no-install-workspace --package metamorph-engine

COPY packages/shared-py/src ./packages/shared-py/src
COPY apps/engine-py/src ./apps/engine-py/src
COPY apps/engine-py/docker/entrypoint.sh ./docker/entrypoint.sh
COPY apps/engine-py/scripts ./scripts

RUN chmod +x /app/docker/entrypoint.sh /app/scripts/download_models.sh /app/scripts/prewarm_cache.sh /app/scripts/prune_xlsr.py /app/scripts/optimize_voice_checkpoints.py \
    && uv sync --frozen --no-dev --inexact --package metamorph-engine

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    ENGINE_BACKEND=mock \
    ENGINE_HOST=0.0.0.0 \
    ENGINE_PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${ENGINE_PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]

# ==============================================================================
# Stage 2a: Voice-only builder (Python 3.12 slim + cu128 PyTorch + pruned weights)
# ==============================================================================
FROM python:3.12-slim AS voice-builder

COPY --from=uv-bin /uv /uvx /usr/local/bin/

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml uv.lock .python-version ./
COPY packages/shared-py/pyproject.toml ./packages/shared-py/pyproject.toml
COPY apps/engine-py/pyproject.toml ./apps/engine-py/pyproject.toml

RUN uv sync --frozen --no-dev --no-install-workspace --package metamorph-engine \
    && uv pip install --python /app/.venv/bin/python --no-cache \
        --extra-index-url https://download.pytorch.org/whl/cu128 \
        --index-strategy unsafe-best-match \
        torch==2.9.1+cu128 \
        torchaudio==2.9.1+cu128 \
        av==13.1.0 \
        einops==0.8.2 \
        "huggingface-hub>=0.28.1,<1.0" \
        munch==4.0.0 \
        pyyaml>=6.0.2 \
        scipy>=1.13.0 \
        transformers==4.46.3

ARG BUNDLE_VOICE_WEIGHTS=1

COPY apps/engine-py/scripts ./scripts

# Bake pruned & fp16-optimized Seed-VC checkpoints onto local NVMe so voice pods skip FUSE & HF API calls
RUN chmod +x /app/scripts/download_models.sh /app/scripts/prewarm_cache.sh /app/scripts/prune_xlsr.py /app/scripts/optimize_voice_checkpoints.py \
    && mkdir -p /app/bundled_models \
    && if [ "${BUNDLE_VOICE_WEIGHTS}" = "1" ]; then \
        ENGINE_VOICE_CACHE_DIR=/app/bundled_models/seed-vc \
        /app/scripts/download_models.sh --voice --prune-xlsr --remove-unpruned-xlsr --optimize-voice-ckpts \
        && rm -f /app/bundled_models/seed-vc/campplus_cn_common.bin \
        && rm -rf /root/.cache/huggingface; \
    fi

COPY packages/shared-py/src ./packages/shared-py/src
COPY apps/engine-py/src ./apps/engine-py/src

# Prune unused triton/headers/static libs/bytecode from .venv while keeping DT_NEEDED CUDA .so libs intact
RUN uv sync --frozen --no-dev --inexact --package metamorph-engine \
    && uv pip uninstall --python /app/.venv/bin/python triton || true \
    && rm -rf \
        /app/.venv/lib/python3.12/site-packages/torch/include \
        /app/.venv/lib/python3.12/site-packages/torch/test \
        /app/.venv/lib/python3.12/site-packages/torch/share \
        /app/.venv/lib/python3.12/site-packages/nvidia/*/include \
        /app/.venv/lib/python3.12/site-packages/nvidia/*/bin \
    && find /app/.venv/lib/python3.12/site-packages -type f -name '*.a' -delete \
    && find /app/.venv/lib/python3.12/site-packages -type d -name '__pycache__' -prune -exec rm -rf {} + \
    && find /app/.venv/lib/python3.12/site-packages -type f -name '*.pyc' -delete

# ==============================================================================
# Stage 2b: Voice-only runtime image (Seed-VC on python:3.12-slim + cu128 wheels)
# ==============================================================================
FROM python:3.12-slim AS voice

ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=voice-builder /app/.venv /app/.venv
COPY --from=voice-builder /app/bundled_models /app/bundled_models
COPY packages/shared-py/src ./packages/shared-py/src
COPY apps/engine-py/src ./apps/engine-py/src
COPY vendor/seed-vc ./vendor/seed-vc
COPY apps/engine-py/docker/entrypoint.sh ./docker/entrypoint.sh
COPY apps/engine-py/scripts ./scripts

RUN chmod +x /app/docker/entrypoint.sh /app/scripts/download_models.sh /app/scripts/prewarm_cache.sh /app/scripts/prune_xlsr.py /app/scripts/optimize_voice_checkpoints.py \
    && mkdir -p /models \
    && python -c "import torch, torchaudio, transformers, av, scipy, metamorph_engine"

ENV ENGINE_BACKEND=gpu \
    ENGINE_ASYNC_STARTUP=true \
    ENGINE_ENABLE_VOICE=true \
    ENGINE_ENABLE_VIDEO=false \
    ENGINE_VENDOR_DIR=/app/vendor \
    ENGINE_HOST=0.0.0.0 \
    ENGINE_PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${ENGINE_PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]

# ==============================================================================
# Stage 3: Full GPU builder (CUDA 12.8 devel + joyomni_ops + optional kernels)
# ==============================================================================
FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu22.04 AS full-builder

ARG CUDA_ARCHS="89;120a"
ARG BUILD_FP8=1
ARG INSTALL_SAGE_ATTN=1
ARG SAGE_CUDA_ARCH_LIST="12.0"
ARG SAGE_EXT_PARALLEL=1
ARG INSTALL_FA4=0
ARG MAX_JOBS=8

COPY --from=uv-bin /uv /uvx /usr/local/bin/

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    CUDA_HOME=/usr/local/cuda \
    MAX_JOBS="${MAX_JOBS}" \
    PATH="/app/.venv/bin:$PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    cmake \
    curl \
    git \
    libglib2.0-0 \
    ninja-build \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN uv python install 3.12

COPY pyproject.toml uv.lock .python-version ./
COPY packages/shared-py/pyproject.toml ./packages/shared-py/pyproject.toml
COPY apps/engine-py/pyproject.toml ./apps/engine-py/pyproject.toml

RUN uv sync --frozen --no-dev --no-install-workspace --package metamorph-engine \
    && uv pip install --python /app/.venv/bin/python --no-cache \
        --extra-index-url https://download.pytorch.org/whl/cu128 \
        --index-strategy unsafe-best-match \
        torch==2.9.1+cu128 \
        torchvision==0.24.1+cu128 \
        torchaudio==2.9.1+cu128 \
        transformers==5.20.2 \
        peft==0.21.2 \
        accelerate==1.15.0 \
        diffusers==0.37.1 \
        einops==0.8.2 \
        numpy==2.2.6 \
        pillow==12.2.0 \
        opencv-python-headless==4.13.0.92 \
        av==13.1.0 \
        loguru==0.7.3 \
        huggingface-hub>=0.28.1 \
        munch==4.0.0 \
        pyyaml>=6.0.2 \
        scipy>=1.13.0 \
        ninja==1.13.0 \
        packaging \
        "setuptools<82" \
        wheel

COPY vendor/JoyAI-Video-Edit/deploy/joyomni_ops /tmp/joyomni_ops
COPY vendor/JoyAI-Video-Edit/deploy/sageattention-cudagraph-stream.patch /tmp/sageattention-cudagraph-stream.patch

# Build joyomni_ops (FP8 GEMM via pinned CUTLASS commit dcf215af when BUILD_FP8=1)
RUN if [ "${BUILD_FP8}" = "1" ]; then \
        git clone --filter=blob:none https://github.com/NVIDIA/cutlass.git /tmp/cutlass \
        && git -C /tmp/cutlass checkout dcf215af \
        && JOYOMNI_OPS_CUTLASS_DIR=/tmp/cutlass \
           JOYOMNI_OPS_CUDA_ARCHS="${CUDA_ARCHS}" \
           uv pip install --python /app/.venv/bin/python --no-build-isolation --no-deps /tmp/joyomni_ops \
        && rm -rf /tmp/cutlass; \
    else \
        JOYOMNI_OPS_NO_FP8=1 \
        JOYOMNI_OPS_CUDA_ARCHS="${CUDA_ARCHS}" \
        uv pip install --python /app/.venv/bin/python --no-build-isolation --no-deps /tmp/joyomni_ops; \
    fi \
    && rm -rf /tmp/joyomni_ops

# Optional SageAttention 2.2.0 (default on for full target; used at runtime on RTX 5090 / sm_120)
RUN if [ "${INSTALL_SAGE_ATTN}" = "1" ]; then \
        git clone https://github.com/thu-ml/SageAttention.git /tmp/SageAttention \
        && cd /tmp/SageAttention \
        && git checkout d1a57a546c3d395b1ffcbeecc66d81db76f3b4b5 \
        && git apply /tmp/sageattention-cudagraph-stream.patch \
        && TORCH_CUDA_ARCH_LIST="${SAGE_CUDA_ARCH_LIST}" \
           EXT_PARALLEL="${SAGE_EXT_PARALLEL}" \
           NVCC_APPEND_FLAGS="--threads ${MAX_JOBS}" \
           uv pip install --python /app/.venv/bin/python --no-build-isolation --no-deps . \
        && cd /app \
        && rm -rf /tmp/SageAttention; \
    fi \
    && rm -f /tmp/sageattention-cudagraph-stream.patch

# Optional flash-attn-4 (recommended for B200 / sm_100)
RUN if [ "${INSTALL_FA4}" = "1" ]; then \
        uv pip install --python /app/.venv/bin/python --no-cache \
            flash-attn-4==4.0.0b13 \
            nvidia-cutlass-dsl==4.5.1 \
            quack-kernels==0.4.1 \
            apache-tvm-ffi==0.1.12; \
    fi

COPY packages/shared-py/src ./packages/shared-py/src
COPY apps/engine-py/src ./apps/engine-py/src

# Sync workspace packages into .venv and prune non-runtime artifacts (keep triton, torch/include, torch/bin)
RUN uv sync --frozen --no-dev --inexact --package metamorph-engine \
    && rm -rf \
        /app/.venv/lib/python3.12/site-packages/torch/test \
        /app/.venv/lib/python3.12/site-packages/torch/share \
    && find /app/.venv/lib/python3.12/site-packages -type f -name '*.a' -delete \
    && find /app/.venv/lib/python3.12/site-packages -type d -name '__pycache__' -prune -exec rm -rf {} + \
    && find /app/.venv/lib/python3.12/site-packages -type f -name '*.pyc' -delete

# ==============================================================================
# Stage 4: Final full GPU image (JoyAI-Video-Edit + Seed-VC on ubuntu:22.04)
# ==============================================================================
FROM ubuntu:22.04 AS full

ARG INSTALL_SAGE_ATTN=1

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    PATH="/app/.venv/bin:$PATH" \
    LD_LIBRARY_PATH="/app/.venv/lib/python3.12/site-packages/nvidia/cuda_runtime/lib:/app/.venv/lib/python3.12/site-packages/nvidia/cublas/lib:/app/.venv/lib/python3.12/site-packages/nvidia/cudnn/lib:/app/.venv/lib/python3.12/site-packages/torch/lib" \
    PYTHONUNBUFFERED=1 \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    g++ \
    gcc \
    libglib2.0-0 \
    zstd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=full-builder /opt/uv-python /opt/uv-python
COPY --from=full-builder /app/.venv /app/.venv

COPY packages/shared-py/src ./packages/shared-py/src
COPY apps/engine-py/src ./apps/engine-py/src
COPY vendor/seed-vc ./vendor/seed-vc
COPY vendor/JoyAI-Video-Edit/deploy ./vendor/JoyAI-Video-Edit/deploy
COPY apps/engine-py/docker/entrypoint.sh ./docker/entrypoint.sh
COPY apps/engine-py/scripts ./scripts

RUN chmod +x /app/docker/entrypoint.sh /app/scripts/download_models.sh /app/scripts/prewarm_cache.sh /app/scripts/prune_xlsr.py /app/scripts/optimize_voice_checkpoints.py \
    && mkdir -p /models \
    && python -c "import torch, torchvision, torchaudio, transformers, diffusers, av, scipy, metamorph_engine, joyomni_ops; print('full runtime ok:', torch.__version__)" \
    && if [ "${INSTALL_SAGE_ATTN}" = "1" ]; then python -c "import sageattention"; fi

ENV ENGINE_BACKEND=gpu \
    ENGINE_ASYNC_STARTUP=true \
    ENGINE_ENABLE_VOICE=true \
    ENGINE_ENABLE_VIDEO=true \
    ENGINE_VENDOR_DIR=/app/vendor \
    ENGINE_HOST=0.0.0.0 \
    ENGINE_PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${ENGINE_PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
