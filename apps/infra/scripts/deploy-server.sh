#!/usr/bin/env bash
set -euo pipefail

IMAGE_URI="${1:?Usage: deploy-server.sh <image-uri>}"
source /etc/metamorph/stack.env

exec 9>/var/lock/metamorph-deploy.lock
flock 9

mkdir -p /etc/nginx/snippets

cat <<'EOF' > /etc/nginx/nginx.conf
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;

include /usr/share/nginx/modules/*.conf;

events {
    worker_connections 1024;
}

http {
    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    server_tokens       off;
    sendfile            on;
    tcp_nopush          on;
    keepalive_timeout   65;
    types_hash_max_size 4096;

    include             /etc/nginx/mime.types;
    default_type        application/octet-stream;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      '';
    }

    map $http_cloudfront_forwarded_proto $forwarded_proto {
        default $http_cloudfront_forwarded_proto;
        ''      $scheme;
    }

    include /etc/nginx/conf.d/*.conf;
}
EOF

cat <<'EOF' > /etc/nginx/snippets/metamorph-proxy.conf
client_max_body_size 50M;

location / {
    proxy_pass http://metamorph_api;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $forwarded_proto;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
EOF

cat <<'EOF' > /etc/nginx/conf.d/metamorph.conf
server {
    listen 80 default_server;
    server_name _;

    include /etc/nginx/snippets/metamorph-proxy.conf;
}
EOF

if [ ! -f /etc/nginx/conf.d/upstream.conf ]; then
  cat <<'EOF' > /etc/nginx/conf.d/upstream.conf
upstream metamorph_api {
    server 127.0.0.1:3001;
    keepalive 32;
    keepalive_timeout 5s;
}
EOF
fi

nginx -t
systemctl enable --now nginx

RDS_CA_BUNDLE="/etc/metamorph/rds-global-bundle.pem"
if [ ! -s "$RDS_CA_BUNDLE" ]; then
  curl -fsSL "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem" -o "${RDS_CA_BUNDLE}.tmp"
  chmod 644 "${RDS_CA_BUNDLE}.tmp"
  mv "${RDS_CA_BUNDLE}.tmp" "$RDS_CA_BUNDLE"
fi

aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker pull "$IMAGE_URI"

DB_SECRET_JSON="$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$DB_SECRET_ARN" --query SecretString --output text)"
APP_SECRET_JSON="$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$APP_SECRET_ID" --query SecretString --output text 2>/dev/null || echo '{}')"

PGHOST="$(jq -r '.host // empty' <<< "$DB_SECRET_JSON")"
PGPORT="$(jq -r '.port // 5432' <<< "$DB_SECRET_JSON")"
PGUSER="$(jq -r '.username // empty' <<< "$DB_SECRET_JSON")"
PGPASSWORD="$(jq -r '.password // empty' <<< "$DB_SECRET_JSON")"
PGDATABASE="$(jq -r '.dbname // "metamorph"' <<< "$DB_SECRET_JSON")"
PGPASSWORD_ENC="$(jq -rn --arg v "$PGPASSWORD" '$v|@uri')"
DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD_ENC}@${PGHOST}:${PGPORT}/${PGDATABASE}?sslmode=require"

RESOLVED_ORIGINS="$(jq -r '.BETTER_AUTH_TRUSTED_ORIGINS // empty' <<< "$APP_SECRET_JSON")"
if [ -z "$RESOLVED_ORIGINS" ]; then
  RESOLVED_ORIGINS="${BETTER_AUTH_TRUSTED_ORIGINS:-}"
fi

BETTER_AUTH_SECRET_VAL="$(jq -r '.BETTER_AUTH_SECRET // empty' <<< "$APP_SECRET_JSON")"
if [ -z "$BETTER_AUTH_SECRET_VAL" ]; then
  echo "Warning: BETTER_AUTH_SECRET is missing in Secrets Manager secret $APP_SECRET_ID" >&2
fi

RESOLVED_JWKS_URL="$(jq -r '.ENGINE_JWT_JWKS_URL // empty' <<< "$APP_SECRET_JSON")"
if [ -z "$RESOLVED_JWKS_URL" ]; then
  RESOLVED_JWKS_URL="${API_PUBLIC_URL}/.well-known/engine-jwks.json"
fi

ENV_TMP="/etc/metamorph/app.env.tmp"
ENV_FILE="/etc/metamorph/app.env"
umask 077
cat > "$ENV_TMP" <<ENVEOF
PORT=3001
NODE_ENV=production
NODE_EXTRA_CA_CERTS=$RDS_CA_BUNDLE
AWS_REGION=$AWS_REGION
DATABASE_URL=$DATABASE_URL
API_PUBLIC_URL=$API_PUBLIC_URL
BETTER_AUTH_URL=$BETTER_AUTH_URL
BETTER_AUTH_TRUSTED_ORIGINS=$RESOLVED_ORIGINS
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET_VAL
JWT_ISSUER=$API_PUBLIC_URL
JWT_AUDIENCE=$API_PUBLIC_URL
ENGINE_JWT_JWKS_URL=$RESOLVED_JWKS_URL
S3_BUCKET=$S3_BUCKET
S3_REGION=$S3_REGION
ENVEOF

{
  for key in \
    GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET \
    ENGINE_JWT_PRIVATE_KEY \
    ENGINE_IMAGE_REPO ENGINE_IMAGE_TAG_FULL ENGINE_IMAGE_TAG_VOICE ENGINE_IMAGE_TAG_MOCK \
    ENGINE_AUTO_DOWNLOAD_MODELS ENGINE_MODEL_VOLUME_DIR ENGINE_ALLOWED_ASSET_HOSTS ENGINE_VIDEO_COMPILE_MODE \
    ENGINE_STARTUP_IDLE_TIMEOUT_S ENGINE_DISCONNECT_TIMEOUT_S \
    ORCHESTRATOR_PROVIDERS ORCHESTRATOR_ALLOW_OVERRIDES \
    ORCHESTRATOR_STARTUP_TIMEOUT_S ORCHESTRATOR_MAX_SESSION_DURATION_S \
    ORCHESTRATOR_VOICE_GPU_IDS ORCHESTRATOR_VIDEO_STANDARD_GPU_IDS ORCHESTRATOR_VIDEO_HIGH_GPU_IDS \
    ORCHESTRATOR_DUAL_STANDARD_GPU_IDS ORCHESTRATOR_DUAL_HIGH_GPU_IDS \
    RUNPOD_API_KEY RUNPOD_CLOUD_TYPE RUNPOD_DATA_CENTER_IDS RUNPOD_NETWORK_VOLUME_ID RUNPOD_GLOBAL_VOLUME_ID \
    VASTAI_API_KEY VASTAI_MAX_PRICE_PER_HR VASTAI_TLS_PROXY_BASE_URL; do
    val="$(jq -r --arg k "$key" '.[$k] // empty' <<< "$APP_SECRET_JSON")"
    if [ -n "$val" ]; then
      printf '%s=%s\n' "$key" "$val"
    fi
  done
} >> "$ENV_TMP"
chmod 600 "$ENV_TMP"
mv "$ENV_TMP" "$ENV_FILE"

docker run --rm \
  --init \
  --env-file "$ENV_FILE" \
  -v "${RDS_CA_BUNDLE}:${RDS_CA_BUNDLE}:ro" \
  --log-driver awslogs \
  --log-opt awslogs-region="$AWS_REGION" \
  --log-opt awslogs-group="$LOG_GROUP_NAME" \
  --log-opt awslogs-stream="migrate-$(date -u +%Y%m%dT%H%M%SZ)" \
  "$IMAGE_URI" \
  node dist/db/migrate.js

CURRENT_SLOT=""
if grep -q '127.0.0.1:3001' /etc/nginx/conf.d/upstream.conf 2>/dev/null && docker ps --format '{{.Names}}' | grep -qx 'metamorph-api-blue'; then
  CURRENT_SLOT="blue"
  TARGET_SLOT="green"
  TARGET_PORT="3002"
elif grep -q '127.0.0.1:3002' /etc/nginx/conf.d/upstream.conf 2>/dev/null && docker ps --format '{{.Names}}' | grep -qx 'metamorph-api-green'; then
  CURRENT_SLOT="green"
  TARGET_SLOT="blue"
  TARGET_PORT="3001"
else
  TARGET_SLOT="blue"
  TARGET_PORT="3001"
  if docker ps --format '{{.Names}}' | grep -qx 'metamorph-api-blue'; then
    CURRENT_SLOT="blue"
    TARGET_SLOT="green"
    TARGET_PORT="3002"
  elif docker ps --format '{{.Names}}' | grep -qx 'metamorph-api-green'; then
    CURRENT_SLOT="green"
  fi
fi

TARGET_CONTAINER="metamorph-api-$TARGET_SLOT"
docker rm -f "$TARGET_CONTAINER" >/dev/null 2>&1 || true

docker run -d \
  --name "$TARGET_CONTAINER" \
  --init \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -v "${RDS_CA_BUNDLE}:${RDS_CA_BUNDLE}:ro" \
  --log-driver awslogs \
  --log-opt awslogs-region="$AWS_REGION" \
  --log-opt awslogs-group="$LOG_GROUP_NAME" \
  --log-opt awslogs-stream="api-${TARGET_SLOT}-$(date -u +%Y%m%dT%H%M%SZ)" \
  -p "127.0.0.1:${TARGET_PORT}:3001" \
  "$IMAGE_URI"

HEALTHY=0
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${TARGET_PORT}/health" >/dev/null; then
    HEALTHY=1
    break
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx "$TARGET_CONTAINER"; then
    echo "Container $TARGET_CONTAINER exited unexpectedly" >&2
    break
  fi
  sleep 2
done

if [ "$HEALTHY" -ne 1 ]; then
  echo "Health check failed for $TARGET_CONTAINER on port $TARGET_PORT" >&2
  docker logs --tail 100 "$TARGET_CONTAINER" 2>&1 || true
  docker rm -f "$TARGET_CONTAINER" >/dev/null 2>&1 || true
  exit 1
fi

cat > /etc/nginx/conf.d/upstream.conf.tmp <<NGXEOF
upstream metamorph_api {
    server 127.0.0.1:${TARGET_PORT};
    keepalive 32;
    keepalive_timeout 5s;
}
NGXEOF
mv /etc/nginx/conf.d/upstream.conf.tmp /etc/nginx/conf.d/upstream.conf
nginx -t
systemctl reload nginx

if [ -n "$CURRENT_SLOT" ] && [ "$CURRENT_SLOT" != "$TARGET_SLOT" ]; then
  OLD_CONTAINER="metamorph-api-$CURRENT_SLOT"
  docker stop --time 30 "$OLD_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$OLD_CONTAINER" >/dev/null 2>&1 || true
fi

docker image prune -af >/dev/null 2>&1 || true
