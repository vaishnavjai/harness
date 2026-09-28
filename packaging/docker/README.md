# Harness Host (Docker)

## Pre-baked Micro-Sandbox Image

For micro-sandbox work, use the pre-baked image that compiles `harness-server` from source and downloads the pinned `opencode` binary during `docker build`.

Build it from the repo root:

```bash
./scripts/build-microsandbox-harness-image.sh
```

Run it locally:

```bash
docker run --rm -p 8787:8787 \
  -e HARNESS_CONNECT_HOST=127.0.0.1 \
  harness-microsandbox:dev
```

Defaults:
- `HARNESS_TOKEN=microsandbox-token`
- `HARNESS_HOST_TOKEN=microsandbox-host-token`
- `HARNESS_APPROVAL_MODE=auto`

Verification:
- Health: `curl http://127.0.0.1:8787/health`
- Authenticated API call: `curl -H "Authorization: Bearer microsandbox-token" http://127.0.0.1:8787/workspaces`
- Docker health: `docker inspect --format '{{json .State.Health}}' <container>`

Useful overrides:
- `HARNESS_TOKEN` — set your own client bearer token
- `HARNESS_HOST_TOKEN` — set your own host/admin token
- `HARNESS_CONNECT_HOST` — host name embedded in the printed connect URL
- `DOCKER_PLATFORM` — optional platform passed to `docker build`

---

## Production container

This is a minimal packaging template to run the Harness Host contract in a single container.

It runs:

- `harness-server` published on `0.0.0.0:8787` (the only published surface)
- Managed `opencode` launched internally by `harness-server`

### Local run (compose)

From this directory:

```bash
docker compose up --build
```

Then open:

- `http://127.0.0.1:8787/health`

### Config

Recommended env vars:

- `HARNESS_TOKEN` (client token)
- `HARNESS_HOST_TOKEN` (host/owner token)

Optional:

- `HARNESS_APPROVAL_MODE=auto|manual`
- `HARNESS_APPROVAL_TIMEOUT_MS=30000`

Persistence:

- Workspace is mounted at `/workspace`
- Host data dir is mounted at `/data` (OpenCode caches + Harness server config/tokens)

### Notes

- OpenCode is not exposed directly; access it via the Harness proxy (`/opencode/*`).
- For PaaS, replace `./workspace:/workspace` with a volume or a checkout strategy (git clone on boot).
