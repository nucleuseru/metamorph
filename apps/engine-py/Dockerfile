# syntax=docker/dockerfile:1.7
# Multi-target Dockerfile for metamorph-engine:
#   - mock  : Lightweight CPU mock image for local apps/api & apps/web dev
#   - voice : Slim CUDA 12.8 runtime image for voice-only instances (Seed-VC)
#   - full  : Full CUDA 12.8 devel image for RV2V + voice instances (JoyAI-Video-Edit + joyomni_ops + Seed-VC)
#
# Always build with the repository root as build context:
#   docker build -f apps/engine-py/Dockerfile --target full -t metamorph-engine:full .

FROM ghcr.io/astral-sh/uv:0.7 AS uv-bin

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
COPY packages/shared-py ./packages/shared-py
COPY apps/engine-py/pyproject.toml ./apps/engine-py/pyproject.toml
COPY apps/engine-py/src ./apps/engine-py/src
COPY apps/engine-py/docker/entrypoint.sh ./docker/entrypoint.sh
COPY apps/engine-py/scripts/download_models.sh ./scripts/download_models.sh

RUN chmod +x /app/docker/entrypoint.sh /app/scripts/download_models.sh \
    && uv sync --frozen --no-dev --package metamorph-engine

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
# Stage 2: Voice-only CUDA 12.8 runtime image (Seed-VC)
# ==============================================================================
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04 AS voice

COPY --from=uv-bin /uv /uvx /usr/local/bin/

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    libsndfile1 \
    libsox3 \
    sox \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN uv python install 3.12

COPY pyproject.toml uv.lock .python-version ./
COPY packages/shared-py ./packages/shared-py
COPY apps/engine-py/pyproject.toml ./apps/engine-py/pyproject.toml
COPY apps/engine-py/src ./apps/engine-py/src

RUN uv sync --frozen --no-dev --package metamorph-engine \
    && uv pip install --python /app/.venv/bin/python --no-cache \
        --extra-index-url https://download.pytorch.org/whl/cu128 \
        torch==2.9.1+cu128 \
        torchaudio==2.9.1+cu128 \
        av==13.1.0 \
        einops==0.8.2 \
        "huggingface-hub>=0.28.1,<1.0" \
        "librosa>=0.11.0" \
        munch==4.0.0 \
        pyyaml>=6.0.2 \
        scipy>=1.13.0 \
        soundfile>=0.12.1 \
        "silero-vad>=5.1.2" \
        transformers==4.46.3

COPY vendor/seed-vc ./vendor/seed-vc
COPY apps/engine-py/docker/entrypoint.sh ./docker/entrypoint.sh
COPY apps/engine-py/scripts/download_models.sh ./scripts/download_models.sh

RUN chmod +x /app/docker/entrypoint.sh /app/scripts/download_models.sh \
    && mkdir -p /models

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

ARG CUDA_ARCHS="89;90a;100a;120a"
ARG BUILD_FP8=1
ARG INSTALL_SAGE_ATTN=1
ARG SAGE_CUDA_ARCH_LIST="12.0"
ARG SAGE_EXT_PARALLEL=1
ARG INSTALL_FA4=0
ARG GPTQMODEL_WHEEL_URL=""
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
    ffmpeg \
    git \
    libglib2.0-0 \
    libsndfile1 \
    ninja-build \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN uv python install 3.12

COPY pyproject.toml uv.lock .python-version ./
COPY packages/shared-py ./packages/shared-py
COPY apps/engine-py/pyproject.toml ./apps/engine-py/pyproject.toml
COPY apps/engine-py/src ./apps/engine-py/src

RUN uv sync --frozen --no-dev --package metamorph-engine \
    && uv pip install --python /app/.venv/bin/python --no-cache \
        --extra-index-url https://download.pytorch.org/whl/cu128 \
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
        imageio-ffmpeg==0.6.0 \
        loguru==0.7.3 \
        huggingface-hub>=0.28.1 \
        munch==4.0.0 \
        pyyaml>=6.0.2 \
        scipy>=1.13.0 \
        soundfile>=0.12.1 \
        "silero-vad>=5.1.2" \
        "librosa>=0.11.0" \
        kernels==0.17.2 \
        defuser==0.0.18 \
        torchao==0.16.0 \
        ninja==1.13.0 \
        packaging \
        setuptools \
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

# Optional local Qwen3.6-27B GPTQ prompt enhancement wheel
RUN if [ -n "${GPTQMODEL_WHEEL_URL}" ]; then \
        uv pip install --python /app/.venv/bin/python --no-cache \
            device-smi==0.5.2 \
            logbar==0.4.1 \
            tokenicer==0.0.12 \
            pypcre==0.2.14 \
            threadpoolctl==3.6.0 \
            datasets==3.6.0 \
            pyarrow==21.0.0 \
            dill==0.3.8 \
            multiprocess==0.70.16 \
            "${GPTQMODEL_WHEEL_URL}"; \
    fi

# ==============================================================================
# Stage 4: Final full GPU image (JoyAI-Video-Edit + Seed-VC)
# ==============================================================================
FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu22.04 AS full

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    CUDA_HOME=/usr/local/cuda \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    g++ \
    gcc \
    libglib2.0-0 \
    libsndfile1 \
    libsox3 \
    sox \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=uv-bin /uv /uvx /usr/local/bin/
COPY --from=full-builder /opt/uv-python /opt/uv-python
COPY --from=full-builder /app/.venv /app/.venv

COPY pyproject.toml uv.lock .python-version ./
COPY packages/shared-py ./packages/shared-py
COPY apps/engine-py/pyproject.toml ./apps/engine-py/pyproject.toml
COPY apps/engine-py/src ./apps/engine-py/src
COPY vendor/seed-vc ./vendor/seed-vc
COPY vendor/JoyAI-Video-Edit/deploy ./vendor/JoyAI-Video-Edit/deploy
COPY apps/engine-py/docker/entrypoint.sh ./docker/entrypoint.sh
COPY apps/engine-py/scripts/download_models.sh ./scripts/download_models.sh

RUN chmod +x /app/docker/entrypoint.sh /app/scripts/download_models.sh \
    && mkdir -p /models

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
