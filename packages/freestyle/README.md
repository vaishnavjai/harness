# Freestyle preview preparation

Freestyle previews run the local MIT core only: the Harness web app with its
local engine (`app-web`), or the Electron desktop app on a fresh, signed-out
profile (`desktop`). No organization control plane, databases, AI gateway or
seeded accounts are started, and no model credentials are placed in a guest.

## Preview worlds

The first reviewer launch builds one running snapshot per commit and world. Each launch
clones that snapshot into a separate VM with its own URL, access token, and filesystem.
Build caches never contain a reviewer's running VM.

- **`app-web`** runs the web app and its local engine behind the private preview
  gateway. The engine uses an isolated state directory and an empty workspace.
- **`desktop`** is a standalone Electron/XFCE desktop. Its private noVNC viewer is
  the primary URL. The app's blank-slate profile isolates its home, config, engine
  and user-data paths. Desktop health and source refresh verify empty onboarding.

Preparation reuses four private, immutable layers:

1. **Tools**: OS packages, package manager and OpenCode, keyed by the install recipe.
2. **Dependencies**: all workspace manifests, both lockfiles, package manager
   configuration and patches. Application source and lifecycle hooks are excluded
   during installation; only explicit registry dependency rebuilds run. Manifest
   scripts and descriptive metadata do not invalidate this layer; lockfiles,
   dependency declarations, configuration and unknown fields still do.
3. **Compiled packages**: the dependency key, build recipe and compiled source/config
   inputs. Generated workspace `dist` directories and desktop sidecars are restored
   after checking out the requested commit. Changes to shared packages, the server,
   desktop or build configuration invalidate this layer. Interpreted app source is
   checked out fresh and compiled by its development server on every world build.
4. **Running services**: a fully booted and verified world, keyed by every backend,
   dependency and controller input. Only app frontend source and inert docs/CI files
   may vary. This cache expires after 24 hours. It is an immutable snapshot, never a
   reviewer's live VM.

The final commit snapshot is a new clone of those running services. It checks out
that exact commit and warms the updated module graph (`app-web`), or reloads the
desktop into a verified new document (`desktop`). Backend/input changes rebuild and
verify the running template first. Reviewer isolation is unchanged.

The private gateway (`src/gateway.mjs`) is the only public route. It requires the
launch's own token, strips it before forwarding, rejects cross-origin requests and
sockets, and forwards paths to the named loopback service unchanged.

Concurrent misses share a provider-enforced builder slug. Failed builders publish
nothing and are deleted. Builder deletion runs in the background so provider
cleanup latency does not block the next layer; the 30-minute provider TTL also
bounds cleanup failures and host termination. Cache snapshots expire after seven
unused days and at most thirty days. Eval runtime changes never invalidate either
world's keys. Shared package and lockfile changes remain conservative.
Test/lint/typecheck commands in manifests do not invalidate runtime keys; build
and startup commands still do.

`scripts/prepare-freestyle-preview.ts` writes `freestyle-build-proof-<world>.json` and a stage
table (to the job summary when run in Actions). `totalMs` measures preparation through a
fully materialized running snapshot, including cache misses, and excludes runner setup
and subsequent independent-clone checks. Nested stage durations overlap: do not add
them. A `world` cache hit means that exact commit was already prepared and is not
evidence of a fast new build.

## Saved evidence checkpoints

Earlier evidence reports may reference checkpoints: private VM snapshots taken while
a spec ran. The review app can still reopen them (`forkEvidenceCheckpoint` in
`src/checkpoints.ts`) until they expire, 24 hours after capture. Forks deny egress,
last one hour, and at most three run per checkpoint; a retried request reuses its
fork.

No world captures new checkpoints. The co-located evidence world that produced them
depended on the removed organization control plane. The capture API stays generic:
a spec may still call `user.checkpoint()` or tag a test `checkpoints`, and a run with
`--checkpoints` prints one warning and continues unchanged, because no world
advertises `checkpointCapability` from `@harness/env`.

`scripts/cleanup-freestyle.ts` reclaims expired checkpoints and every layer of the
retired `acme-web` and evidence worlds.
