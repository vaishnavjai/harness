# OpenCode app parity

Harness runs against two pinned OpenCode engines (v1 and v2). These checks show
that the same user journeys work on both, against the local MIT core only: the
real development web app, the Harness server and the native engine executables.
No organization control plane, database server or AI gateway is involved.

## Deterministic integration parity

Run `pnpm evals:parity` from the repository root. The command runs both pinned engines, then collects three fresh-profile app launch samples per engine. Use `pnpm evals:parity --iterations=5` for more timing samples.

The runner downloads only native engine executables into the ignored results directory, checks archive integrity and reported versions against `constants.json`, and never runs package installation scripts. Explicit `HARNESS_OPENCODE_BIN` and `HARNESS_OPENCODE2_BIN` overrides must report the pinned versions.

The output is `evals/results/engine-parity/<timestamp>/report.md`. It links each journey to a human-readable page with named steps, screenshots and assertions. `results.json`, individual test JSON and logs sit beside it. A skipped, missing, duplicated, failed or wrong-engine case makes the command fail.

## What a person should be able to do

| Journey | Visible proof | Independent proof |
| --- | --- | --- |
| First boot (`PARITY-BOOT`) | Open a fresh signed-out app, see a model selected automatically, type a task, receive its answer once. | No model preference is seeded; the upstream records the selected model and exactly one final answer. |
| Streaming (`PARITY-STREAM`) | Read the first sentence while the rest of the answer is still unavailable. | The model fixture holds the second chunk until the screenshot and assertion complete. |
| Skills (`PARITY-SKILLS`) | Install a skill and answer using its actual instructions. V2 also installs, edits, removes and reinstalls it across five turns in one conversation. | Random codes exist only in skill files. The real native skill tool reads them; prompts and canned replies never contain them. |

V2 must retain the same browser document, conversation and engine PID throughout skill updates. The v2 assertions reject both HTTP reload requests and internal engine rollover.

## What is real and what is controlled

The renderer, Harness server and OpenCode executables are real processes. Only the model responses are local deterministic witnesses. Every app has an isolated profile, engine database, home, configuration and environment store. Fixtures use synthetic identities and credentials. No account is needed.

## Reading launch measurements

The launch clock starts immediately before starting the real app-web stack and ends at the interactive renderer or the ready composer. Model fixture preparation and binary download are outside that boundary. First-answer timing starts when the user presses Run task. Each sample uses a fresh app profile.

These are development app-web measurements, including browser and development-server startup. They are not packaged Electron startup numbers, cold filesystem-cache measurements or real-provider latency. App-web uses the same renderer and server paths and is the portable route for this comparison.

## Other engine checks

- `engine-live-parity.e2e.test.ts` verifies a browser-host server starting with zero workspaces. Because the browser has no native folder chooser, it creates the first workspace through the real host API and verifies the visible composer.
- `engine-provider-filters.e2e.test.ts` checks the pinned native v2 catalog: remove/restore a model, apply deny-list precedence, allow no models, then remove restrictions, retaining the same engine PID. It uses a synthetic credential and makes no inference requests. Runtime model filtering applies to built-in models as well as configured aliases.
- `engine-live-provider.test.ts` covers the opt-in real-provider selection (`HARNESS_LIVE_PROVIDER`): credentials alone never enable real inference, and missing credentials fail instead of falling back to a scripted model.

## Scope of a green result

For the deterministic suite, PASS means the three journeys above passed on both pinned engines, including the stricter v2 hot-update checks, and all requested timing samples were captured. It does not mean the repository's entire E2E suite is green.

Earlier revisions of this document recorded real-model journeys that depended on
the removed organization control plane (organization sign-in, organization
skills, gateway model assignments and organization connectors). Those specs were
removed with it; their historical results are not reproducible from this
repository.
