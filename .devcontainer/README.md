# Daytona / Dev Container Setup

Dev environment that runs the **real Electron app** in a cloud sandbox. You see and steer the desktop app through your browser via noVNC.

## What's included

| Service | Port | Description |
|---------|------|-------------|
| **Desktop App (noVNC)** | 6080 | The real Electron app rendered in a virtual display, accessible in your browser |
| **CDP Debug** | 9825 | Chrome DevTools Protocol — for app and browser automation |
| **Vite HMR** | 5173 | Hot module replacement for the React UI |

## Quick start with Daytona Electron/noVNC

```bash
bash .devcontainer/create-daytona-harness-snapshot.sh   # one-time / refresh when deps change
bash .devcontainer/test-on-daytona.sh [branch-or-commit]
```

The test script creates a sandbox from the reusable `harness-eval-vnc` snapshot
when present, checks out the target ref, skips `pnpm install` if the lockfile is
unchanged, starts XFCE/noVNC, Vite, and Electron, then prints the noVNC and CDP
URLs. If the snapshot is missing, it fails fast and tells you to create it. The
snapshot intentionally does not bake `node_modules`; installs use the reusable
`harness-eval-pnpm-store` volume so the image stays under Daytona's 20 GB limit.

For provider evals, create/populate the reusable Daytona secrets volume once:

```bash
bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken
bash .devcontainer/setup-daytona-secrets-volume.sh .anthropic anthropic.env
```

Future Daytona test sandboxes mount `harness-eval-secrets:/daytona-secrets`
and source every `/daytona-secrets/*.env` file automatically before Electron
starts. Use this volume for provider keys and other eval-only secrets; never
commit those files into the repo.

For downloadable eval artifacts or optional video recording, use:

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --artifacts-volume
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --record-video
```

The artifacts flow mounts `harness-eval-artifacts:/daytona-artifacts`, starts a
static download server on port 8090, and prints a Daytona preview URL. Recording
writes mp4 files to `/daytona-artifacts/recordings` and prints the direct video
URL. Screenshots write png files to `/daytona-artifacts/screenshots` for quick
AI/human validation checkpoints. Stop recording with
`.devcontainer/stop-daytona-recording.sh` so ffmpeg finalizes the file cleanly.

Do not use the generic `daytona create https://github.com/vaishnavjai/harness`
flow for Electron/noVNC tests. The default resource size is too small and the
generic image path does not guarantee the desktop stack we need.

## How it works

1. `.devcontainer/Dockerfile.daytona-vnc` starts from `daytonaio/sandbox:0.6.0`,
   which includes Daytona's expected desktop packages: Xvfb, XFCE, x11vnc,
   noVNC, websockify, and dbus-x11.
2. `.devcontainer/create-daytona-harness-snapshot.sh` bakes that image into
   `harness-eval-vnc` without `node_modules`.
3. `/opt/harness-daytona/start-daytona-vnc.sh` starts Xvfb, XFCE, x11vnc, and
   noVNC on display `:99`.
4. `test-on-daytona.sh` installs dependencies through the reusable
   `harness-eval-pnpm-store` volume when `node_modules` is missing or the
   lockfile changed.
5. Vite serves the React UI on port 5173.
6. `/opt/harness-daytona/start-daytona-electron.sh` sources optional secrets,
   applies Daytona-safe Chromium flags, and starts Electron on display `:99`.
7. **CDP on port 9825** enables Chrome MCP and browser-tool automation.
8. Optional artifact capture mounts `/daytona-artifacts`, serves it on port 8090,
   records display `:99` with ffmpeg when `--record-video` is passed, and can
   capture screenshot checkpoints with `.devcontainer/capture-daytona-screenshot.sh`.

## Validation Evidence

Use three layers of evidence for Daytona UI work:

- **CDP assertions:** use browser tools against port 9825 to inspect text, URL,
  state, and accessibility snapshots. This is the primary AI validation path.
- **Screenshots:** run `daytona exec "$SANDBOX" -- 'bash .devcontainer/capture-daytona-screenshot.sh'` after important states. These png files live in `/daytona-artifacts/screenshots`.
- **Recordings:** start with `--record-video --recording-name <name>` for flows
  that need PR evidence. These mp4 files live in `/daytona-artifacts/recordings`.

Recordings prove the flow to humans. CDP assertions and screenshots give the AI
fast checkpoints to decide whether behavior is correct before reporting success.

## AI Skills

The Daytona toolbox is exposed to opencode through focused skills:

- `daytona`: CLI setup, long-lived sandboxes, logs, snapshots, and the secrets volume.
- `record-a-demo`: supplementary screenshots, recordings, and presentation artifacts.
- `run-tests`: runs `evals/specs` coverage; the CLI chooses and reports placement.

## Architecture

```
Your Browser
    │
    ├── :6080 noVNC ──▶ x11vnc ──▶ XFCE/Xvfb ──▶ Electron App
    │                              │
    │                              ├── CDP :9825 (automatable)
    │                              └── Vite HMR :5173
```

## Automation

The Electron app exposes CDP on port 9825. You can:

- Connect Playwright: `const browser = await chromium.connectOverCDP('ws://localhost:9825')`
- Connect Chrome MCP for AI agent testing
- Take screenshots, run UI tests, etc.
