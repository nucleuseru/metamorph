#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ENGINE_DIR/../.." && pwd)"

resolve_python() {
    if [ -n "${PYTHON_BIN:-}" ]; then
        printf '%s' "$PYTHON_BIN"
    elif [ -x /app/.venv/bin/python ]; then
        printf '%s' "/app/.venv/bin/python"
    elif [ -x "$REPO_ROOT/.venv/bin/python" ]; then
        printf '%s' "$REPO_ROOT/.venv/bin/python"
    elif command -v python3 >/dev/null 2>&1; then
        printf '%s' "python3"
    else
        printf '%s' "python"
    fi
}

PYTHON="$(resolve_python)"

OUT_DIR=""
MINT_TOKEN=0
PRIVATE_KEY_FILE=""
USER_ID="user-local"
INSTANCE_ID="local-instance"
MODALITIES="voice,video"
ISSUER=""
TTL=3600

usage() {
    cat <<'EOF'
Usage:
  gen-jwt-keys.sh [--out-dir <dir>]
  gen-jwt-keys.sh --mint-token --private-key <path> [options]

Modes:
  Keypair generation (default):
    Generates an Ed25519 keypair and prints JWT_PRIVATE_KEY (for apps/api)
    and escaped ENGINE_JWT_PUBLIC_KEY (for engine env).
    --out-dir <dir>           Write private_ed25519.pem & public_ed25519.pem

  Token minting (--mint-token):
    --private-key <path>      Path to Ed25519 PEM private key
    --user-id <id>            JWT sub claim (default: user-local)
    --instance-id <id>        JWT aud claim (default: local-instance)
    --modalities <csv>        Comma-separated modalities (default: voice,video)
    --issuer <iss>            Optional JWT iss claim
    --ttl <seconds>           Token lifetime in seconds (default: 3600)
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --out-dir) OUT_DIR="$2"; shift 2 ;;
        --mint-token) MINT_TOKEN=1; shift ;;
        --private-key) PRIVATE_KEY_FILE="$2"; shift 2 ;;
        --user-id) USER_ID="$2"; shift 2 ;;
        --instance-id) INSTANCE_ID="$2"; shift 2 ;;
        --modalities) MODALITIES="$2"; shift 2 ;;
        --issuer) ISSUER="$2"; shift 2 ;;
        --ttl) TTL="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [ "$MINT_TOKEN" = "1" ]; then
    if [ -z "$PRIVATE_KEY_FILE" ] || [ ! -f "$PRIVATE_KEY_FILE" ]; then
        echo "--private-key <path> is required for --mint-token." >&2
        exit 2
    fi
    exec "$PYTHON" - "$PRIVATE_KEY_FILE" "$USER_ID" "$INSTANCE_ID" "$MODALITIES" "$ISSUER" "$TTL" <<'PY'
import sys
import time
import jwt
from cryptography.hazmat.primitives import serialization

key_path, sub, aud, modalities_csv, iss, ttl_s = sys.argv[1:7]
with open(key_path, "rb") as fh:
    private_key = serialization.load_pem_private_key(fh.read(), password=None)

now = int(time.time())
payload = {
    "sub": sub,
    "aud": aud,
    "iat": now,
    "exp": now + int(ttl_s),
    "modalities": [m.strip() for m in modalities_csv.split(",") if m.strip()],
}
if iss:
    payload["iss"] = iss
print(jwt.encode(payload, private_key, algorithm="EdDSA"))
PY
fi

exec "$PYTHON" - "$OUT_DIR" <<'PY'
from pathlib import Path
import sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

out_dir = sys.argv[1]
private_key = Ed25519PrivateKey.generate()
priv_pem = private_key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.PKCS8,
    encryption_algorithm=serialization.NoEncryption(),
).decode("utf-8")
pub_pem = private_key.public_key().public_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PublicFormat.SubjectPublicKeyInfo,
).decode("utf-8")

if out_dir:
    target = Path(out_dir)
    target.mkdir(parents=True, exist_ok=True)
    priv_path = target / "private_ed25519.pem"
    pub_path = target / "public_ed25519.pem"
    priv_path.write_text(priv_pem, encoding="utf-8")
    priv_path.chmod(0o600)
    pub_path.write_text(pub_pem, encoding="utf-8")
    print(f"# Saved private key: {priv_path}")
    print(f"# Saved public key:  {pub_path}")

escaped_priv = priv_pem.strip().replace("\n", "\\n")
escaped_pub = pub_pem.strip().replace("\n", "\\n")
print(f'JWT_PRIVATE_KEY="{escaped_priv}"')
print(f'ENGINE_JWT_PUBLIC_KEY="{escaped_pub}"')
PY
