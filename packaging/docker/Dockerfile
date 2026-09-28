# Build context: the repository root
#   docker build -f packaging/docker/Dockerfile -t harness-server .
#
# harness-server is built from this checkout. It is deliberately never
# installed from a registry: the harness-server name and the @harness scope
# on npm are not owned by this project.
FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && npm install -g bun@1.3.11

WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@harness/server..." --filter "@harness/app..."
RUN pnpm --filter @harness/server prepare:npm

FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.17.11
ARG OPENCODE_DOWNLOAD_URL=

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/apps/server/dist/npm /opt/harness-server
RUN cd /opt/harness-server \
  && npm install --omit=dev --ignore-scripts \
  && ln -s /opt/harness-server/bin/harness-server.mjs /usr/local/bin/harness-server

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) asset="opencode-linux-x64-baseline.tar.gz" ;; \
    arm64) asset="opencode-linux-arm64.tar.gz" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  url="$OPENCODE_DOWNLOAD_URL"; \
  if [ -z "$url" ]; then \
    url="https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${asset}"; \
  fi; \
  tmpdir="$(mktemp -d)"; \
  curl -fsSL "$url" -o "$tmpdir/$asset"; \
  tar -xzf "$tmpdir/$asset" -C "$tmpdir"; \
  binary="$(find "$tmpdir" -type f -name opencode | head -n 1)"; \
  test -n "$binary"; \
  install -m 0755 "$binary" /usr/local/bin/opencode; \
  rm -rf "$tmpdir"

# Persistent directories (mount volumes here on PaaS/SSH).
# The data path deliberately keeps its historical name: existing deployments
# have volumes mounted at /data/harness-orchestrator, and renaming it here
# would silently orphan their state. The orchestrator CLI itself is gone; this
# is only a directory name kept for compatibility.
ENV HARNESS_DATA_DIR=/data/harness-orchestrator
ENV HARNESS_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV HARNESS_WORKSPACE=/workspace

# Harness host contract surface.
EXPOSE 8787

VOLUME ["/workspace", "/data"]

# Defaults:
# - Harness server is published intentionally via --host 0.0.0.0
# - OpenCode is managed by harness-server and stays internal
CMD ["/bin/sh", "-lc", "plugin_dir=/opt/harness-server/dist/opencode-plugins; test -d \"$plugin_dir\"; export HARNESS_MANAGE_OPENCODE=1 HARNESS_OPENCODE_BIN=/usr/local/bin/opencode HARNESS_EXTENSIONS_PLUGIN_DIR=\"$plugin_dir\"; exec harness-server --workspace \"${HARNESS_WORKSPACE:-/workspace}\" --host 0.0.0.0 --port \"${HARNESS_PORT:-8787}\" --cors \"${HARNESS_CORS_ORIGINS:-*}\" --approval \"${HARNESS_APPROVAL_MODE:-manual}\""]
