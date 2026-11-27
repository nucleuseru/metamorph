#!/usr/bin/env bash
set -euo pipefail

DEST="${JOYOMNI_CKPT_ROOT:-${MODEL_VOLUME_DIR:-/models}/checkpoints}"
WANT_VOICE=0
WANT_VIDEO=0
FORCE=0
DRY_RUN=0

usage() {
    cat <<'EOF'
Usage: download_models.sh [options]

Download Seed-VC and JoyAI-Video-Edit checkpoints into a model volume directory.

Options:
  --dest <dir>      Checkpoint root (default: $MODEL_VOLUME_DIR/checkpoints or /models/checkpoints)
  --voice           Download Seed-VC v1 real-time checkpoints (XLSR, DiT, HiFT)
  --video           Download JoyAI-Video-Edit DiT, xVAE, and MiMo-VL weights
  --all             Download voice and video checkpoints
  --force           Re-download even if destination files already exist
  --dry-run         Print download actions without executing
  -h, --help        Show this help
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --dest) DEST="$2"; shift 2 ;;
        --voice) WANT_VOICE=1; shift ;;
        --video) WANT_VIDEO=1; shift ;;
        --all) WANT_VOICE=1; WANT_VIDEO=1; shift ;;
        --force) FORCE=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [ "$WANT_VOICE" = "0" ] && [ "$WANT_VIDEO" = "0" ]; then
    WANT_VOICE=1
    WANT_VIDEO=1
fi

run_or_echo() {
    if [ "$DRY_RUN" = "1" ]; then
        printf '[dry-run] %s\n' "$*"
    else
        "$@"
    fi
}

PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
    if [ -x /app/.venv/bin/python ]; then
        PYTHON_BIN="/app/.venv/bin/python"
    elif command -v python3 >/dev/null 2>&1; then
        PYTHON_BIN="python3"
    else
        PYTHON_BIN="python"
    fi
fi

hf_download_file() {
    local repo="$1"
    local filename="$2"
    local local_dir="$3"
    run_or_echo "$PYTHON_BIN" -c "
from huggingface_hub import hf_hub_download
hf_hub_download(repo_id='$repo', filename='$filename', local_dir='$local_dir')
"
}

hf_download_repo() {
    local repo="$1"
    local local_dir="$2"
    local revision="${3:-}"
    local include_json="${4:-}"
    run_or_echo "$PYTHON_BIN" -c "
import json
from huggingface_hub import snapshot_download
kw = {'repo_id': '$repo', 'local_dir': '$local_dir'}
rev = '$revision'
if rev:
    kw['revision'] = rev
inc = '''$include_json'''
if inc:
    kw['allow_patterns'] = json.loads(inc)
snapshot_download(**kw)
"
}

if [ "$DRY_RUN" = "0" ]; then
    mkdir -p "$DEST"
fi

if [ "$WANT_VOICE" = "1" ]; then
    SEEDVC_CACHE="${ENGINE_VOICE_CACHE_DIR:-$DEST/seed-vc}"
    echo "[download_models] Preparing Seed-VC checkpoints in $SEEDVC_CACHE"
    if [ "$DRY_RUN" = "0" ]; then
        mkdir -p "$SEEDVC_CACHE"
    fi
    hf_download_file "Plachta/Seed-VC" "DiT_uvit_tat_xlsr_ema.pth" "$SEEDVC_CACHE"
    hf_download_file "FunAudioLLM/CosyVoice-300M" "hift.pt" "$SEEDVC_CACHE"
    hf_download_file "funasr/campplus" "campplus_cn_common.bin" "$SEEDVC_CACHE"
    # Pre-cache XLSR feature extractor and encoder weights as flat files (FUSE/global-volume safe)
    hf_download_repo "facebook/wav2vec2-xls-r-300m" "$SEEDVC_CACHE/facebook__wav2vec2-xls-r-300m" "" '["config.json", "preprocessor_config.json", "pytorch_model.bin", "model.safetensors"]'
fi

if [ "$WANT_VIDEO" = "1" ]; then
    JOYAI_DIR="$DEST/JoyAI-Video-Edit"
    MIMO_DIR="$DEST/MiMo-VL-7B-RL-2508"
    if [ "$FORCE" = "1" ] || [ ! -f "$JOYAI_DIR/dit/joyai_video_edit_dit_1101_face++.pth" ] || [ ! -f "$JOYAI_DIR/vae/diffusion_pytorch_model.safetensors" ]; then
        echo "[download_models] Downloading JoyAI-Video-Edit DiT + xVAE -> $JOYAI_DIR"
        hf_download_repo "jdopensource/JoyAI-Video-Edit" "$JOYAI_DIR" "" '["dit/joyai_video_edit_dit_1101_face++.pth", "vae/*"]'
    else
        echo "[download_models] JoyAI DiT + xVAE already present at $JOYAI_DIR"
    fi

    if [ "$FORCE" = "1" ] || [ ! -d "$MIMO_DIR" ] || [ -z "$(ls -A "$MIMO_DIR" 2>/dev/null || true)" ]; then
        echo "[download_models] Downloading MiMo-VL-7B-RL-2508 -> $MIMO_DIR"
        hf_download_repo "XiaomiMiMo/MiMo-VL-7B-RL-2508" "$MIMO_DIR"
    else
        echo "[download_models] MiMo-VL already present at $MIMO_DIR"
    fi
fi

echo "[download_models] Done."
