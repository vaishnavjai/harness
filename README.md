# Harness

Harness is a local agent desktop for macOS, Windows and Linux. AI agents work on your own files, remember what they learn across sessions, and talk only to the models you choose — including models running on your own machine.

It is a fork of [OpenWork](https://github.com/different-ai/openwork) (MIT), runs the [OpenCode](https://github.com/anomalyco/opencode) agent engine, and embeds [Hindsight](https://github.com/vectorize-io/hindsight) (MIT) for long-term memory. See [Attribution](#license-and-attribution).

## What makes it different

- **Local-first by default.** Out of the box Harness makes no request to any host you did not configure: no analytics, no crash reporting, no update checks, no remote model catalog, no icon CDNs. Details: [Outbound network access](packages/docs/start-here/outbound-network-access.mdx).
- **Bring your own model.** Point it at Ollama, vLLM, llama.cpp or LM Studio (for example `http://127.0.0.1:11434/v1`), or add an API key for a hosted provider. Hosted services nobody configured, such as OpenCode Zen, are not offered.
- **Long-term memory on your machine.** Hindsight runs as a supervised child process on `127.0.0.1:8888` with its own embedded PostgreSQL + pgvector. Memories are stored in `~/.config/harness/data/hindsight`, and the memory engine can reach only loopback and the model endpoint you set.
- **Keys stay encrypted.** API keys go to your OS keychain (Electron `safeStorage`) or an AES-256-GCM vault keyed by it — never plaintext JSON or `.env` files. The agent engine receives them in memory only.
- **Everything the agent does is on record.** Tool runs, terminal commands, file writes and every remote host contacted are appended to a hash-chained audit log at `~/.config/harness/audit.log`. **Settings → Audit log** shows it in plain language and verifies the chain.

## Build it

One command produces a self-contained app for the machine you run it on:

```bash
corepack enable        # pnpm, pinned in package.json
npm run package
```

Prerequisites: Node 22+, [bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/). The command installs dependencies, typechecks, builds the Python runtime for the memory engine, builds the desktop app with its OpenCode engine, aggregates every third-party license into `THIRD_PARTY_LICENSES.txt`, assembles the app with electron-builder, and then checks that the bundled engine and memory runtime start. The app lands in `apps/desktop/dist-electron/` (`linux-unpacked/`, `mac-*/Harness.app`, or `win-unpacked/`).

Network access is needed while building (packages, CPython, the pinned OpenCode release). The packaged app downloads nothing.

Flags: `--skip-install`, `--skip-typecheck`, `--fresh-runtime` (rebuild the memory runtime even when it is current).

## Set up models and memory

1. Open **Settings → Providers** and add a local server or an API key.
2. Open **Settings → Memory**, turn memory on, and pick the model and embedding endpoints (Ollama with `llama3.1:8b` and `nomic-embed-text` is the default). The page shows where the engine listens, where data lives, and the only remote host memory text can reach, if any.

Memories are retained and recalled through the local engine; nothing leaves the device unless you choose a hosted model.

## Develop

```bash
pnpm install
pnpm dev                                   # Electron app with hot reload
node scripts/hindsight/prepare-runtime.mjs --dev   # memory engine runtime for dev (./.hindsight-runtime)
```

Tests:

```bash
pnpm --filter @harness/app test:core
pnpm --filter @harness/server test:core
pnpm --filter @harness/desktop test:core
cd packages/memory && bun test src test/e2e   # includes a real Hindsight retain/recall run
pnpm test:packaging
```

`HARNESS_TEST_OPENCODE_BIN=/path/to/opencode bun test apps/server/src/provider-keys.real-engine.e2e.test.ts` drives the real engine end to end.

Contributor rules live in [AGENTS.md](AGENTS.md); UI work follows [DESIGN.md](DESIGN.md).

### Layout

| Path | What it is |
| --- | --- |
| `apps/desktop` | Electron main process: windows, keychain, audit log, memory supervisor wiring, packaging |
| `apps/app` | React renderer (settings, chat, memory and audit views) |
| `apps/server` | Local Harness server and the OpenCode engine plugins |
| `packages/memory` | `HindsightSupervisor`, loopback client, settings, Python launcher |
| `packages/audit` | Hash-chained, append-only audit log |
| `vendor/hindsight` | Vendored Hindsight engine (unmodified; see `VENDORED.md`) |
| `scripts/package.mjs` | `npm run package` |

## License and attribution

Harness is MIT licensed (see [LICENSE](LICENSE)). It keeps OpenWork's original MIT copyright notice and includes Hindsight under its MIT license; both notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Every build also ships `THIRD_PARTY_LICENSES.txt` with the license of each bundled npm package, Python package and runtime.
