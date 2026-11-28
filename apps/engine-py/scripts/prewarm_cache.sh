#!/usr/bin/env bash
set -euo pipefail

# Pre-warm TorchInductor/Triton/CUDA compile caches for JoyAI-Video-Edit on the current GPU
# and persist a single compressed `.tar.zst` archive onto the persistent model volume.
#
# Run once per GPU SKU (e.g., RTX 5090, RTX PRO 6000) so production pods extract the archive
# in ~1-2s instead of cold-compiling kernels on every startup.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRYPOINT="$APP_ROOT/docker/entrypoint.sh"

COMPILE_MODE="${ENGINE_VIDEO_COMPILE_MODE:-max-autotune-no-cudagraphs}"
BOTH_ORIENTATIONS="${ENGINE_VIDEO_WARMUP_BOTH_ORIENTATIONS:-false}"
RESOLUTIONS=()

usage() {
    cat <<'EOF'
Usage: prewarm_cache.sh [options]

Pre-warm JoyAI-Video-Edit compile caches on the active GPU and archive them to the
persistent model volume as `<MODEL_VOLUME_DIR>/cache/<gpu_slug>.tar.zst`.

Options:
  --res <WxH>           Resolution to pre-warm (repeatable; default: 840x480)
  --compile-mode <mode> torch.compile mode (default: max-autotune-no-cudagraphs)
  --both-orientations   Warm up both landscape and portrait orientations
  -h, --help            Show this help
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --res) RESOLUTIONS+=("$2"); shift 2 ;;
        --compile-mode) COMPILE_MODE="$2"; shift 2 ;;
        --both-orientations) BOTH_ORIENTATIONS="true"; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [ "${#RESOLUTIONS[@]}" -eq 0 ]; then
    RESOLUTIONS=("840x480")
fi

# Resolve volume/GPU cache environment via entrypoint.sh
while IFS='=' read -r key val; do
    [ -n "$key" ] && export "$key=$val"
done < <("$ENTRYPOINT" --print-env)

mkdir -p \
    "$TORCHINDUCTOR_CACHE_DIR" \
    "$TRITON_CACHE_DIR" \
    "$CUDA_CACHE_PATH"

# Seed existing cache archive if present so multiple resolutions accumulate cleanly
if [ "$JOYOMNI_CACHE_ROOT" != "$JOYOMNI_VOLUME_CACHE_ROOT" ]; then
    if [ -f "${JOYOMNI_VOLUME_CACHE_ROOT}.tar.zst" ] && command -v zstd >/dev/null 2>&1; then
        tar --zstd -xf "${JOYOMNI_VOLUME_CACHE_ROOT}.tar.zst" -C "$JOYOMNI_CACHE_ROOT" 2>/dev/null || true
    elif [ -f "${JOYOMNI_VOLUME_CACHE_ROOT}.tar.gz" ]; then
        tar -xzf "${JOYOMNI_VOLUME_CACHE_ROOT}.tar.gz" -C "$JOYOMNI_CACHE_ROOT" 2>/dev/null || true
    fi
fi

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

for res in "${RESOLUTIONS[@]}"; do
    width="${res%x*}"
    height="${res#*x}"
    echo "[prewarm_cache] Warming up JoyAI ${width}x${height} (mode=${COMPILE_MODE}, both_orientations=${BOTH_ORIENTATIONS})"
    ENGINE_BACKEND=gpu \
    ENGINE_ENABLE_VOICE=false \
    ENGINE_ENABLE_VIDEO=true \
    ENGINE_VIDEO_WIDTH="$width" \
    ENGINE_VIDEO_HEIGHT="$height" \
    ENGINE_VIDEO_COMPILE_MODE="$COMPILE_MODE" \
    ENGINE_VIDEO_WARMUP_BOTH_ORIENTATIONS="$BOTH_ORIENTATIONS" \
    ENGINE_VIDEO_PERSIST_COMPILE_CACHE=false \
    "$PYTHON_BIN" -c "
from metamorph_engine.config import EngineSettings
from metamorph_engine.pipelines.video_joyai import JoyAIVideoPipeline

pipe = JoyAIVideoPipeline(EngineSettings())
pipe.warmup()
pipe.close()
"
done

# Force synchronous atomic archive write-back (overwriting any lower-tier archive)
PREWARM_LOCAL_CACHE_ROOT="$JOYOMNI_CACHE_ROOT" \
PREWARM_VOLUME_CACHE_ROOT="$JOYOMNI_VOLUME_CACHE_ROOT" \
PREWARM_COMPILE_MODE="$COMPILE_MODE" \
PREWARM_RESOLUTIONS="${RESOLUTIONS[*]}" \
PREWARM_BOTH_ORIENTATIONS="$BOTH_ORIENTATIONS" \
"$PYTHON_BIN" -c "
import os
from pathlib import Path
from metamorph_engine.pipelines.video_joyai import _persist_compile_cache_archive

try:
    from xvideo.serving.serve_joyomni_streaming import _snap_to_align
except Exception:
    def _snap_to_align(val: int, align: int = 24) -> int:
        return max(align, ((val + align // 2) // align) * align)

both = os.environ.get('PREWARM_BOTH_ORIENTATIONS', 'false').lower() == 'true'
warmed_shapes: list[tuple[int, int]] = []
for token in os.environ.get('PREWARM_RESOLUTIONS', '').split():
    if 'x' not in token:
        continue
    w_str, h_str = token.split('x', 1)
    w = _snap_to_align(int(w_str), 24)
    h = _snap_to_align(int(h_str), 24)
    warmed_shapes.append((w, h))
    if both and w != h:
        warmed_shapes.append((h, w))

out = _persist_compile_cache_archive(
    local_cache_root=Path(os.environ['PREWARM_LOCAL_CACHE_ROOT']),
    volume_cache_root=Path(os.environ['PREWARM_VOLUME_CACHE_ROOT']),
    compile_mode=os.environ['PREWARM_COMPILE_MODE'],
    warmed_shapes=warmed_shapes,
    force=True,
)
if out is None:
    raise SystemExit('Failed to persist compile cache archive')
print(f'[prewarm_cache] Archive ready: {out}')
"
