# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@12.21.0 --activate
WORKDIR /app

# ---
FROM base AS prepare
RUN apk add --no-cache curl
# Pin a release compatible with the turbo version in package.json.
ARG TURBO_VERSION=2.11.13
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) target=x86_64-unknown-linux-musl ;; \
      aarch64) target=aarch64-unknown-linux-musl ;; \
      *) echo 'Unsupported architecture' >&2; exit 1 ;; \
    esac; \
    archive="turbo-$TURBO_VERSION-$target.tar.gz"; \
    release="https://github.com/vercel/turborepo/releases/download/v$TURBO_VERSION"; \
    cd /tmp; \
    curl -fsSL "$release/SHA256SUMS" -o SHA256SUMS; \
    curl -fsSL "$release/$archive" -o "$archive"; \
    awk -v name="$archive" '$2 == name && NF == 2 { print }' SHA256SUMS > turbo-checksum; \
    [ "$(wc -l < turbo-checksum)" -eq 1 ]; \
    sha256sum -c turbo-checksum; \
    [ "$(tar -tzf "$archive")" = turbo ]; \
    tar -xzf "$archive" -C /usr/local/bin turbo; \
    chmod 755 /usr/local/bin/turbo; \
    rm SHA256SUMS turbo-checksum "$archive"

COPY . .
RUN turbo prune @metamorph/api --docker

# ---
FROM base AS builder
ENV NODE_ENV=development
COPY --from=prepare /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=prepare /app/out/full/ .
COPY --from=prepare /app/tsconfig.base.json ./tsconfig.base.json

# Optional Turborepo Remote Caching build args
# ARG TURBO_TEAM
# ENV TURBO_TEAM=$TURBO_TEAM
# ARG TURBO_TOKEN
# ENV TURBO_TOKEN=$TURBO_TOKEN

RUN pnpm turbo build --filter=@metamorph/api...
RUN pnpm prune --prod

# ---
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3001 \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-ca-bundle.pem

ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-ca-bundle.pem
RUN chmod 644 /etc/ssl/certs/rds-ca-bundle.pem

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 metamorph

COPY --from=builder --chown=metamorph:nodejs /app/package.json ./package.json
COPY --from=builder --chown=metamorph:nodejs /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder --chown=metamorph:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=metamorph:nodejs /app/packages/shared-ts/package.json ./packages/shared-ts/package.json
COPY --from=builder --chown=metamorph:nodejs /app/packages/shared-ts/node_modules ./packages/shared-ts/node_modules
COPY --from=builder --chown=metamorph:nodejs /app/packages/shared-ts/dist ./packages/shared-ts/dist
COPY --from=builder --chown=metamorph:nodejs /app/packages/orchestrator/package.json ./packages/orchestrator/package.json
COPY --from=builder --chown=metamorph:nodejs /app/packages/orchestrator/node_modules ./packages/orchestrator/node_modules
COPY --from=builder --chown=metamorph:nodejs /app/packages/orchestrator/dist ./packages/orchestrator/dist
COPY --from=builder --chown=metamorph:nodejs /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=metamorph:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=metamorph:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=metamorph:nodejs /app/apps/api/drizzle ./apps/api/drizzle

USER metamorph
WORKDIR /app/apps/api
EXPOSE 3001

CMD ["node", "dist/index.js"]
