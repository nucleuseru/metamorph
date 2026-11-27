#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOWNLOAD_SCRIPT="$APP_ROOT/scripts/download_models.sh"

PRINT_ENV=0
if [ "${1:-}" = "--print-env" ]; then
    PRINT_ENV=1
    shift
fi

# Resolve persistent model/cache volume directory
if [ -z "${MODEL_VOLUME_DIR:-}" ]; then
    for candidate in /models /workspace; do
        if [ -d "$candidate" ] && [ -w "$candidate" ]; then
            MODEL_VOLUME_DIR="$candidate"
            break
        fi
    done
    MODEL_VOLUME_DIR="${MODEL_VOLUME_DIR:-$APP_ROOT/models}"
fi
export MODEL_VOLUME_DIR

# Shared HuggingFace / Torch caches on persistent volume
export HF_HOME="${HF_HOME:-$MODEL_VOLUME_DIR/hf_cache}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE:-$HF_HOME/hub}"
export TORCH_HOME="${TORCH_HOME:-$MODEL_VOLUME_DIR/torch_cache}"

# Wire engine-py and vendor checkpoint locations when unset
CKPT_ROOT="${JOYOMNI_CKPT_ROOT:-$MODEL_VOLUME_DIR/checkpoints}"
export JOYOMNI_CKPT_ROOT="$CKPT_ROOT"

export ENGINE_VOICE_CACHE_DIR="${ENGINE_VOICE_CACHE_DIR:-$CKPT_ROOT/seed-vc}"
export ENGINE_VIDEO_DIT_CKPT="${ENGINE_VIDEO_DIT_CKPT:-$CKPT_ROOT/JoyAI-Video-Edit/dit/joyai_video_edit_dit_1101_face++.pth}"
export ENGINE_VIDEO_VAE_CKPT="${ENGINE_VIDEO_VAE_CKPT:-$CKPT_ROOT/JoyAI-Video-Edit/vae}"
export ENGINE_VIDEO_TEXT_ENCODER_CKPT="${ENGINE_VIDEO_TEXT_ENCODER_CKPT:-$CKPT_ROOT/MiMo-VL-7B-RL-2508}"

# Sync JoyAI vendor env vars with ENGINE_* settings
export JOYOMNI_DIT_CKPT="${JOYOMNI_DIT_CKPT:-$ENGINE_VIDEO_DIT_CKPT}"
export JOYOMNI_VAE_CKPT="${JOYOMNI_VAE_CKPT:-$ENGINE_VIDEO_VAE_CKPT}"
export JOYOMNI_TEXT_ENCODER_CKPT="${JOYOMNI_TEXT_ENCODER_CKPT:-$ENGINE_VIDEO_TEXT_ENCODER_CKPT}"
export JOYOMNI_PE_BACKEND="${JOYOMNI_PE_BACKEND:-none}"
export JOYOMNI_FP8_IMG="${JOYOMNI_FP8_IMG:-1}"
export JOYOMNI_FP8_TXT="${JOYOMNI_FP8_TXT:-1}"
export JOYOMNI_CUDA_GRAPH="${JOYOMNI_CUDA_GRAPH:-1}"

# Detect GPU and apply per-GPU compile cache isolation + tuning defaults
GPU_SLUG="cpu"
if [ "${ENGINE_BACKEND:-gpu}" = "gpu" ] && command -v nvidia-smi >/dev/null 2>&1; then
    if GPU_INFO="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -n1)" && [ -n "$GPU_INFO" ]; then
        GPU_NAME="${GPU_INFO%%,*}"
        GPU_VRAM_MB="${GPU_INFO##*,}"
        GPU_VRAM_MB="${GPU_VRAM_MB//[[:space:]]/}"
        GPU_SLUG="$(printf '%s' "$GPU_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+|_+$//g')"

        case "$GPU_SLUG" in
            *b200*)
                export JOYOMNI_FA4_ATTN="${JOYOMNI_FA4_ATTN:-1}"
                export JOYOMNI_SAGE_ATTN="${JOYOMNI_SAGE_ATTN:-0}"
                export JOYOMNI_LOW_VRAM="${JOYOMNI_LOW_VRAM:-0}"
                ;;
            *5090*)
                export JOYOMNI_FA4_ATTN="${JOYOMNI_FA4_ATTN:-0}"
                export JOYOMNI_FP8_FAST_ACCUM="${JOYOMNI_FP8_FAST_ACCUM:-1}"
                export JOYOMNI_LOW_VRAM="${JOYOMNI_LOW_VRAM:-1}"
                if [ -z "${JOYOMNI_SAGE_ATTN:-}" ]; then
                    if python -c "import sageattention" >/dev/null 2>&1; then
                        export JOYOMNI_SAGE_ATTN=1
                    else
                        export JOYOMNI_SAGE_ATTN=0
                    fi
                fi
                ;;
            *)
                export JOYOMNI_FA4_ATTN="${JOYOMNI_FA4_ATTN:-0}"
                export JOYOMNI_SAGE_ATTN="${JOYOMNI_SAGE_ATTN:-0}"
                if [ -z "${JOYOMNI_LOW_VRAM:-}" ] && [ -n "$GPU_VRAM_MB" ] && [ "$GPU_VRAM_MB" -le 49152 ] 2>/dev/null; then
                    export JOYOMNI_LOW_VRAM=1
                else
                    export JOYOMNI_LOW_VRAM="${JOYOMNI_LOW_VRAM:-0}"
                fi
                ;;
        esac
        if [ "$PRINT_ENV" != "1" ] \
            && [ "${ENGINE_ENABLE_VIDEO:-true}" = "true" ] \
            && [ "${ENGINE_ENABLE_VOICE:-true}" = "true" ] \
            && [ -n "$GPU_VRAM_MB" ] \
            && [ "$GPU_VRAM_MB" -le 36864 ] 2>/dev/null; then
            printf '[entrypoint] WARNING: Video + Voice together on %s (%s MiB VRAM) runs near the 32 GiB ceiling (~30-31 GiB peak at 480p24). Provision a >=48 GB GPU (e.g. RTX PRO 6000) for dual-modality sessions.\n' \
                "$GPU_NAME" "$GPU_VRAM_MB" >&2
        fi
    fi
fi

is_fuse_or_network_path() {
    local target="$1"
    [ -r /proc/mounts ] || return 1
    awk -v path="$target" '
        BEGIN { best_len = 0; best_fs = "" }
        {
            mp = $2; gsub(/\\040/, " ", mp);
            fs = tolower($3);
            if (mp == "/" || path == mp || index(path, mp "/") == 1) {
                if (length(mp) > best_len) {
                    best_len = length(mp);
                    best_fs = fs;
                }
            }
        }
        END {
            if (best_fs ~ /^(fuse(\.|$)|nfs|ceph|9p|s3fs|gcsfuse|lustre|glusterfs|sshfs|virtiofs|cifs|smb)/) {
                exit 0;
            }
            exit 1;
        }
    ' /proc/mounts
}

VOLUME_CACHE_ROOT="$MODEL_VOLUME_DIR/cache/$GPU_SLUG"
if [ -z "${JOYOMNI_CACHE_ROOT:-}" ]; then
    if is_fuse_or_network_path "$MODEL_VOLUME_DIR"; then
        # Avoid TorchInductor/Triton lock & rename hangs on FUSE/network global volumes
        JOYOMNI_CACHE_ROOT="/tmp/metamorph-cache/$GPU_SLUG"
    else
        JOYOMNI_CACHE_ROOT="$VOLUME_CACHE_ROOT"
    fi
fi
export JOYOMNI_CACHE_ROOT
export TORCHINDUCTOR_CACHE_DIR="${TORCHINDUCTOR_CACHE_DIR:-$JOYOMNI_CACHE_ROOT/torchinductor}"
export TRITON_CACHE_DIR="${TRITON_CACHE_DIR:-$JOYOMNI_CACHE_ROOT/triton}"
export CUDA_CACHE_PATH="${CUDA_CACHE_PATH:-$JOYOMNI_CACHE_ROOT/nv_compute}"
export TORCHINDUCTOR_FX_GRAPH_CACHE="${TORCHINDUCTOR_FX_GRAPH_CACHE:-1}"
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"

if [ "$PRINT_ENV" = "1" ]; then
    cat <<EOF
MODEL_VOLUME_DIR=$MODEL_VOLUME_DIR
HF_HOME=$HF_HOME
HUGGINGFACE_HUB_CACHE=$HUGGINGFACE_HUB_CACHE
TORCH_HOME=$TORCH_HOME
JOYOMNI_CKPT_ROOT=$JOYOMNI_CKPT_ROOT
JOYOMNI_CACHE_ROOT=$JOYOMNI_CACHE_ROOT
JOYOMNI_FP8_IMG=$JOYOMNI_FP8_IMG
JOYOMNI_FP8_TXT=$JOYOMNI_FP8_TXT
JOYOMNI_CUDA_GRAPH=$JOYOMNI_CUDA_GRAPH
TORCHINDUCTOR_CACHE_DIR=$TORCHINDUCTOR_CACHE_DIR
TRITON_CACHE_DIR=$TRITON_CACHE_DIR
CUDA_CACHE_PATH=$CUDA_CACHE_PATH
ENGINE_VOICE_CACHE_DIR=$ENGINE_VOICE_CACHE_DIR
ENGINE_VIDEO_DIT_CKPT=$ENGINE_VIDEO_DIT_CKPT
ENGINE_VIDEO_VAE_CKPT=$ENGINE_VIDEO_VAE_CKPT
ENGINE_VIDEO_TEXT_ENCODER_CKPT=$ENGINE_VIDEO_TEXT_ENCODER_CKPT
EOF
    exit 0
fi

mkdir -p \
    "$HF_HOME" \
    "$HUGGINGFACE_HUB_CACHE" \
    "$TORCH_HOME" \
    "$ENGINE_VOICE_CACHE_DIR" \
    "$TORCHINDUCTOR_CACHE_DIR" \
    "$TRITON_CACHE_DIR" \
    "$CUDA_CACHE_PATH"

# Seed local SSD compile cache from persistent volume if pre-populated
if [ "$JOYOMNI_CACHE_ROOT" != "$VOLUME_CACHE_ROOT" ] && [ -d "$VOLUME_CACHE_ROOT" ]; then
    printf '[entrypoint] Seeding local compile cache %s from %s\n' "$JOYOMNI_CACHE_ROOT" "$VOLUME_CACHE_ROOT" >&2
    cp -rn "$VOLUME_CACHE_ROOT/." "$JOYOMNI_CACHE_ROOT/" 2>/dev/null || true
fi

# Optionally bootstrap missing models on startup
if [ "${AUTO_DOWNLOAD_MODELS:-false}" = "true" ] && [ "${ENGINE_BACKEND:-gpu}" = "gpu" ]; then
    dl_args=(--dest "$CKPT_ROOT")
    if [ "${ENGINE_ENABLE_VOICE:-true}" = "true" ]; then
        dl_args+=(--voice)
    fi
    if [ "${ENGINE_ENABLE_VIDEO:-true}" = "true" ]; then
        dl_args+=(--video)
    fi
    "$DOWNLOAD_SCRIPT" "${dl_args[@]}"
fi

# Preflight verification when running GPU video inference
if [ "${ENGINE_BACKEND:-gpu}" = "gpu" ] && [ "${ENGINE_ENABLE_VIDEO:-true}" = "true" ]; then
    missing=()
    [ -f "$ENGINE_VIDEO_DIT_CKPT" ] || missing+=("DiT checkpoint: $ENGINE_VIDEO_DIT_CKPT")
    [ -d "$ENGINE_VIDEO_VAE_CKPT" ] || missing+=("VAE directory: $ENGINE_VIDEO_VAE_CKPT")
    [ -d "$ENGINE_VIDEO_TEXT_ENCODER_CKPT" ] || missing+=("MiMo-VL directory: $ENGINE_VIDEO_TEXT_ENCODER_CKPT")
    if [ "${#missing[@]}" -gt 0 ]; then
        printf '[entrypoint] Missing required video model weights on %s:\n' "$CKPT_ROOT" >&2
        printf '  - %s\n' "${missing[@]}" >&2
        printf '[entrypoint] Mount a pre-populated model volume at /models (or set MODEL_VOLUME_DIR), or set AUTO_DOWNLOAD_MODELS=true.\n' >&2
        # When orchestrated via webhook, let metamorph-engine start and report startup_failed
        # cleanly so the orchestrator fails fast and terminates the pod instead of crash-looping.
        if [ -z "${ENGINE_LIFECYCLE_WEBHOOK_URL:-}" ]; then
            exit 1
        fi
    fi
fi

exec "${ENGINE_CMD:-metamorph-engine}" "$@"
