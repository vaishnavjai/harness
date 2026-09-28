# AGENTS.md

Harness is a local-first agent desktop (macOS, Windows, Linux), forked from
OpenWork and built on the OpenCode engine. Agents work on the user's own files,
keep long-term memory in an embedded Hindsight engine, and reach only the model
endpoints the user configures (local servers such as Ollama, or hosted
providers with the user's own keys).

* **Desktop app** (`apps/desktop`, `apps/app`, `apps/server`, `packages/`) —
  chat on files, skills, browser automation, scheduled automations,
  Anthropic-compatible plugins, memory, and the audit log.
* **Memory engine** (`packages/memory`, `vendor/hindsight`) — Hindsight run as a
  supervised, loopback-only child process with a bundled Python runtime.

Hard rules for this fork:

* No telemetry, analytics or crash reporting, and no request to a host the user
  did not configure. New outbound hosts go in
  `docs/enterprise/outbound-access.json` (CI checks it).
* Secrets live in the OS keychain or an AES-256-GCM vault keyed by it — never in
  plaintext files.
* Agent tool runs, terminal commands and file writes are recorded in the
  hash-chained audit log (`packages/audit`).
* Spawn processes with argument vectors, never interpolated shell strings.

The app consumes Harness server surfaces rather than inventing parallel
behavior. Anything OpenCode can do is available in Harness, even before a
dedicated UI exists.

## Confidentiality (hard rule — this repo is public)

Never let a branch name, commit, PR text, comment, fixture, or evidence identify
a customer, prospect, partner, or outside person; use internal ticket IDs, and
escalate any leak instead of rewriting history.

## Coding

* pnpm only, never npm/yarn (`npm run package` is the one entry point that uses
  npm: it only runs `scripts/package.mjs`, which installs through pnpm). TypeScript: never `any`, typecasts, or `as` unless
  100% necessary or instructed.
* Prefer Tailwind, React, shadcn/ui (Base UI), TanStack Query, Zustand, Zod,
  Drizzle, Better-Auth. Reuse `@/components`; end users are non-technical.
* Any user-facing UI (desktop app, Den web, MCP Apps, artifact views) follows
  `DESIGN.md`: read it before designing, cite its rule ids in PRs, and attach
  screenshots of new UI. The optional
  `.warden/skills/design-spec-review` skill can review these rules locally.

