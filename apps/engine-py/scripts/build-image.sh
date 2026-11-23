#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DOCKERFILE="$REPO_ROOT/apps/engine-py/Dockerfile"

TARGET="full"
IMAGE="metamorph-engine"
TAG=""
PLATFORM="linux/amd64"
CUDA_ARCHS="89;90a;100a;120a"
BUILD_FP8=1
INSTALL_SAGE_ATTN=1
SAGE_CUDA_ARCH_LIST="12.0"
INSTALL_FA4=0
GPTQMODEL_WHEEL_URL=""
PUSH=0
DRY_RUN=0

usage() {
    cat <<'EOF'
Usage: build-image.sh [options]

Options:
  --target <full|voice|mock>     Dockerfile build target (default: full)
  --image <repo/name>            Image name (default: metamorph-engine)
  --tag <tag>                    Image tag (default: <target>)
  --platform <arch>              Target platform (default: linux/amd64)
  --cuda-archs <archs>           CUDA archs for joyomni_ops (default: 89;90a;100a;120a)
  --no-fp8                       Build joyomni_ops without CUTLASS FP8 GEMM
  --sage-attn                    Build SageAttention 2.2.0 (default for full target)
  --no-sage-attn                 Skip building SageAttention 2.2.0
  --sage-archs <list>            SageAttention arch list (default: 12.0)
  --fa4                          Install flash-attn-4 (recommended for B200)
  --gptq-wheel <url>             Optional GPTQModel wheel URL for local Qwen PE
  --push                         Push image after building
  --dry-run                      Print build command without executing
  -h, --help                     Show this help
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --target) TARGET="$2"; shift 2 ;;
        --image) IMAGE="$2"; shift 2 ;;
        --tag) TAG="$2"; shift 2 ;;
        --platform) PLATFORM="$2"; shift 2 ;;
        --cuda-archs) CUDA_ARCHS="$2"; shift 2 ;;
        --no-fp8) BUILD_FP8=0; shift ;;
        --sage-attn) INSTALL_SAGE_ATTN=1; shift ;;
        --no-sage-attn) INSTALL_SAGE_ATTN=0; shift ;;
        --sage-archs) SAGE_CUDA_ARCH_LIST="$2"; shift 2 ;;
        --fa4) INSTALL_FA4=1; shift ;;
        --gptq-wheel) GPTQMODEL_WHEEL_URL="$2"; shift 2 ;;
        --push) PUSH=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

case "$TARGET" in
    full|voice|mock) ;;
    *) echo "Invalid --target: $TARGET (expected full, voice, or mock)" >&2; exit 2 ;;
esac

TAG="${TAG:-$TARGET}"
FULL_REF="${IMAGE}:${TAG}"

CLI="${CONTAINER_CLI:-}"
if [ -z "$CLI" ]; then
    if command -v docker >/dev/null 2>&1; then
        CLI="docker"
    elif command -v podman >/dev/null 2>&1; then
        CLI="podman"
    elif [ "$DRY_RUN" = "1" ]; then
        CLI="docker"
    else
        echo "Neither docker nor podman found in PATH." >&2
        exit 1
    fi
fi

cmd=(
    "$CLI" build
    --file "$DOCKERFILE"
    --target "$TARGET"
    --platform "$PLATFORM"
    --tag "$FULL_REF"
)

if [ "$TARGET" = "full" ]; then
    cmd+=(
        --build-arg "CUDA_ARCHS=${CUDA_ARCHS}"
        --build-arg "BUILD_FP8=${BUILD_FP8}"
        --build-arg "INSTALL_SAGE_ATTN=${INSTALL_SAGE_ATTN}"
        --build-arg "SAGE_CUDA_ARCH_LIST=${SAGE_CUDA_ARCH_LIST}"
        --build-arg "INSTALL_FA4=${INSTALL_FA4}"
        --build-arg "GPTQMODEL_WHEEL_URL=${GPTQMODEL_WHEEL_URL}"
    )
fi

cmd+=("$REPO_ROOT")

if [ "$DRY_RUN" = "1" ]; then
    printf '%q ' "${cmd[@]}"
    echo
    if [ "$PUSH" = "1" ]; then
        printf '%q ' "$CLI" push "$FULL_REF"
        echo
    fi
    exit 0
fi

DOCKER_BUILDKIT=1 "${cmd[@]}"

if [ "$PUSH" = "1" ]; then
    "$CLI" push "$FULL_REF"
fi
