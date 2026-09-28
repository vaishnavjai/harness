---
name: preview-my-work
description: Boot, reopen, update, or reset Harness PR previews. Discover script worlds, use configurable app-web locally or through a private Daytona browser URL, or choose the isolated Electron preset for hands-on testing.
---

# Preview my work

Use the repository's world lifecycle. These are disposable test environments,
not production or a user's installed desktop profile. Do not touch another
world or an existing test sandbox. Run from the requested worktree.

## Choose a preview

- Discover the actual primitives first: `pnpm world help`, `pnpm world list` (declared targets are shown; undeclared scripts cannot run remotely),
  then inspect the requested script in `worlds/` and its options in `worlds/lib/`.
  A preset's restrictions are not restrictions of the generic world CLI.
  For another composition, inspect `packages/world/src/index.ts` and
  `evals/packages/env/src/index.ts` before declaring it unsupported; reuse the
  existing provisioning, runtime launch and hold primitives, not another framework.
- `app-web`: configurable source app plus the existing isolated headless server,
  locally, on an owned private Daytona sandbox, or on Freestyle. It runs the
  local MIT core only; no account or activation is seeded.
- `preview-desktop`: real Electron on a fresh, signed-out profile; workspaces,
  chat and native app interactions. On `--place daytona` this is Linux Electron
  in a noVNC viewer, not a macOS/Windows parity check. `--place local` runs this
  checkout as a native window on this machine (source previews only; `--release`
  requires Daytona). Freestyle runs the signed-out `fresh` desktop from a pushed
  commit.

`preview-desktop` has two scenarios. `--scenario fresh` (the default) is a true
first launch from source: the harness adds no workspace and signs into nothing.
No model credentials are seeded. Do not describe it as capable of live
model/provider requests until the user connects a model inside the preview.

Use `--scenario blank --release <x.y.z> --distribution <name>` to preview exact
published Linux x64 tarball bytes with a completely isolated, unseeded profile.
Add `--os windows` before `--` to preview the published Windows x64 installer
in a private Windows Daytona VM. Windows launches as the logged-in Administrator
through a world-owned interactive task (never SYSTEM/session 0); its private
noVNC viewer and CDP are probed before reporting readiness. Supported
distributions are `public`, `cloud`, and `enterprise`; arm64, prereleases,
mutable/latest versions and Windows source previews are not supported.
Windows accepts `--lifetime 0-1410` (0 until stopped), reserving 30 minutes
for a VM provider TTL after startup. The installer resolves the exact `v<x.y.z>` GitHub release asset and verifies
its API-published SHA-256 digest inside the VM before installation.

## Saved evidence checkpoints

Older evidence reports may carry checkpoint images with **Open from here**. The
review app reopens such a checkpoint into an independent private VM until it
expires, 24 hours after capture; forks last one hour, with three simultaneous
copies per checkpoint. No world captures new checkpoints: `--checkpoints` runs
print one warning and continue unchanged. Keep access links private.

## Start and open

For the configurable app-web script, use a reviewed full pushed SHA on Daytona:

```sh
pnpm world up app-web --place local --stage pr-1234
pnpm world up app-web --place daytona --stage pr-1234 --detach --timeout 600000 -- --ref <full-pushed-sha>
pnpm world outputs app-web --stage pr-1234 --reveal
pnpm world down app-web --stage pr-1234
```

Generic invocation identity fingerprints any selected nonsecret `--env` values
before adoption; changing a key, value, placement or script argument requires a
new stage or explicit down. Never pass provider credentials, host/client tokens,
personal profiles, or shared secrets volumes. There is no `--cloud` flag.
The CLI rejects credential-like environment key names. Local invocation identity
also hashes Git HEAD, status, tracked diffs and untracked file names/content;
source changes require a new stage or down before up, across local worlds.

The app-web `webUrl` is a secret, port-bound signed hostname. Reveal it only in a
private terminal and open it directly; never put it in evidence or PR text.
Loopback `runtimeWebUrl`/`runtimeHarnessUrl` are process diagnostics, not human
browser links. Source SHA and placement are explicit outputs. Private HTTP,
assets and WebSocket access must pass the launch checks; failures delete the
owned sandbox, never fall back to public exposure. The source dev proxy preserves
client bearer auth and never injects host auth. Builds and production preview
servers do not enable this proxy. Checked-out source receives only the non-secret
preview host suffix for Vite allowedHosts, never the signed origin. HMR derives
its host and protocol from the browser location; `/api/harness` resolves against
that same origin in the browser. Signed URLs stay in the trusted launcher,
witness and private outputs.

Do not fabricate activation/bootstrap state.
App-web defaults to two hours from readiness; optionally pass `--lifetime <10-1430>`
after `--`. Its signed URL is issued by the trusted launcher before runtime launch, with the
lifetime plus a ten-minute startup buffer (within Daytona's 24-hour maximum).
Startup exceeding that buffer fails closed. `expires` is the authoritative world
deadline from readiness; `previewExpires` is the conservative URL deadline from
issuance. The URL credential can outlive the world timer, but sandbox deletion
invalidates access. World expiry or `down` tears
down the owned runtime and sandbox while the owning driver is running. Always
explicitly stop when finished. Abrupt driver crashes can leave a sandbox behind:
ledger ownership is not authenticated, so no Daytona ledger reaper is registered.
Manual cleanup must independently verify ownership before deleting a sandbox.
The preset update helper below
does not update app-web; use a new stage on the next reviewed SHA instead.

Daytona documents signed hosts as `{port}-{token}.{proxyDomain}`, not sandbox-ID
hosts (https://www.daytona.io/docs/en/preview/). The launcher checks structured
private sandbox info (matching ID, `public: false`) and its `toolboxProxyUrl`
(`https://{proxyDomain}/toolbox`) before
issuing the signed URL; unsupported info formats fail closed. It rejects standard
sandbox UUID hosts and mismatched domains. The opaque signed token cannot prove
sandbox identity by hostname alone; issuance is scoped to the verified sandbox ID.

The following scenario/ref and update instructions concern `preview-desktop`.

Use a unique stage such as `pr-1234` to keep previews separate. First inspect
`pnpm world list` and `pnpm world outputs <world> --stage <stage> --json`.
An existing matching world should be reopened, not recreated. Compare its
recorded scenario and ref before adopting it. A stage is not a git ref.

Use reviewed repository code: previews execute that ref’s build scripts. Do not
load production credentials or attach shared secrets volumes. Push the intended
commit and use its full 40-character SHA so Daytona can fetch it. When
`HARNESS_EVAL_REF` is omitted, launch resolves remote `origin/dev` once to a
full SHA, prints it, and records it in the world outputs. This assumes `dev`
is the reviewed baseline. Explicit launch refs and update refs still reject
mutable branch names. To preview a specific commit:

```sh
HARNESS_EVAL_REF=<pushed-sha> pnpm world up preview-desktop --stage pr-1234 --place daytona --detach --timeout 600000 -- --scenario fresh --lifetime 120
```

The existing Daytona snapshots handle dependencies. A cold build takes minutes; reopening a
ready world is quick. Never promise seconds for an unmeasured cold boot.

For an immutable published desktop preview, run:

```sh
pnpm world up preview-desktop --stage pr-1234 --place daytona --detach --timeout 600000 -- --release 0.18.44 --distribution enterprise --scenario blank
# Windows published x64, with a private signed viewer:
pnpm world up preview-desktop --stage pr-1234-win --place daytona --os windows --detach --timeout 600000 --source desktop=release:0.18.52/enterprise --seed blank
pnpm world outputs preview-desktop --stage pr-1234-win --reveal
```

`HARNESS_EVAL_REF` pins the desktop source for `fresh`; omit it to use the
current remote `dev` commit. The world driver and release installer run from the
local checkout's HEAD, and the desktop sandbox uses the snapshot's inherited
display/browser helpers. `--release` selects desktop bytes; none of these
identities falls back to another. The equivalent composable inputs before `--`
are `--source desktop=release:0.18.52/enterprise --seed blank`. Do not combine
`--source desktop=...` with `-- --release`. For Windows, add `--os windows`
before `--`, or use the composable source/seed syntax above; only exact blank
published Windows x64 releases are supported. Freestyle does not support
Windows. On Freestyle, `preview-desktop` supports only the signed-out `fresh`
desktop from a pushed commit (`pnpm world up preview-desktop --place freestyle --source desktop=ref:dev`);
`blank` is refused there. Release sandboxes do not mount shared secrets and do not run a
source checkout, `pnpm install`, Electron source launch, or Vite. Their viewer,
startup observation, release digest and log/profile paths are outputs.
Linux additionally reports relaunch/browser shortcuts and a protocol handler. A
crashed or unresponsive app is retained for inspection and is not reported as
healthy; CDP is output only when it actually responded.

Read the resulting world outputs. Open `preview` with Codex's `open_in_codex`
browser target when available; do not launch the operating system browser.
The desktop opens the noVNC viewer with automatic connection, fit-to-panel
scaling and reconnect enabled. The viewer toolbar includes clipboard controls.
If this agent has no embedded-browser opening tool, give the preview link.

For phone web layouts, use the browser tool's viewport controls if available;
otherwise use the preview's responsive browser tools. Do not call a resized
Electron viewer a mobile app preview.

Wait for world readiness and verify the preview responds before reporting it
ready. If testing behavior, follow `run-tests`; a manually booted world is not a
passing test. Do not print secret outputs or put them in a PR.

## Update without losing progress

For frontend-only changes, push the new commit and run:

```sh
pnpm exec python3 .opencode/skills/preview-my-work/scripts/update-preview.py preview-desktop --stage pr-1234 --ref <pushed-sha>
```

The helper updates the desktop renderer source and preserves the Electron
process and profile. Renderer updates use the existing Vite hot reload; reload
the viewer/app if needed. Verify the changed screen before claiming the update is visible.

The update helper rejects published release previews. Stop that exact stage and
launch a new stage/version instead; changing source cannot change published
desktop bytes.

The helper deliberately does not restart Electron main/preload. For those changes, create a new stage on the new ref and
explain that it is a fresh preview. Do not silently reset a working preview.

## Reset, lifetime and stop

“Start over” means stop this exact world/stage, then repeat its launch command.
This deletes that preview's data. For a comparison, use another stage instead.

```sh
pnpm world down preview-desktop --stage pr-1234
```

The default lifetime is two hours from readiness, **not an idle timer**. Use
`--lifetime 0` only when the user asks to keep it until explicitly stopped;
otherwise accept 1–1440 minutes. The world process owns orderly teardown on
expiry or `down`; preview provisioning disables Daytona's separate idle timer
for the desktop sandbox. An abruptly killed driver cannot run
that cleanup. Use only the exact `desktopSandbox` ID recorded
in the owner-only outputs to inspect or remove leftovers; never delete by broad
name patterns.

`world up` compares recipe and invocation identity before adopting a live stage.
Script arguments, placement, and explicitly selected environment values must
match. Still inspect recorded scenario, ref, release version, distribution,
and digest: implicit preset defaults such as a moving remote dev ref are not a
request to update an existing world. Use a new stage or explicitly down/reset;
never treat adoption as an update.

Report the preview link, tested ref/scenario, expiry, and any actual limitation.
Keep infrastructure IDs and startup logs out of the user-facing walkthrough.
