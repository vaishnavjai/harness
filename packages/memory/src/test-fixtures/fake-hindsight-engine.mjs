// Stand-in for harness_hindsight_launcher.py in supervisor tests. It keeps
// the same contract: bind HINDSIGHT_API_HOST:HINDSIGHT_API_PORT, require the
// tenant bearer token on /v1 routes, spawn a long-lived grandchild (as the
// real engine does with its database), and shut down when stdin closes.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const host = process.env.HINDSIGHT_API_HOST;
const port = Number(process.env.HINDSIGHT_API_PORT);
const token = process.env.HINDSIGHT_API_TENANT_API_KEY;
const mode = process.env.FAKE_ENGINE_MODE ?? "normal";

if (process.env.FAKE_ENGINE_ENV_FILE) {
  writeFileSync(process.env.FAKE_ENGINE_ENV_FILE, JSON.stringify(process.env));
}
if (mode === "crash-on-boot") {
  console.error("fatal: could not initialise the database");
  process.exit(7);
}

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
if (process.env.FAKE_ENGINE_PID_FILE) {
  writeFileSync(process.env.FAKE_ENGINE_PID_FILE, JSON.stringify({ engine: process.pid, grandchild: grandchild.pid }));
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"status":"healthy"}');
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401, { "content-type": "application/json" }).end('{"detail":"Invalid API key"}');
    return;
  }
  if (request.url === "/v1/default/banks") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"banks":[]}');
    return;
  }
  response.writeHead(404).end();
});

function shutdown() {
  grandchild.kill("SIGTERM");
  server.close();
  process.exit(0);
}

// Crash once, shortly after becoming ready, to exercise restart supervision.
if (mode === "crash-once-after-ready" && process.env.FAKE_ENGINE_CRASH_MARKER) {
  const marker = process.env.FAKE_ENGINE_CRASH_MARKER;
  const { existsSync } = await import("node:fs");
  if (!existsSync(marker)) {
    writeFileSync(marker, "crashed");
    setTimeout(() => {
      grandchild.kill("SIGKILL");
      process.exit(9);
    }, 300);
  }
}

// Stalls before listening, as an engine blocked on a dependency would.
if (mode === "never-ready" && !process.env.FAKE_ENGINE_QUIET) console.log("loading the embeddings model");

const bootDelay = mode === "slow-boot" ? 400 : 0;
if (mode !== "never-ready") {
  setTimeout(() => {
    server.listen(port, host, () => console.log(`fake engine listening on ${host}:${port}`));
  }, bootDelay);
}

// The orphan guard: EOF on the supervisor's pipe means the parent is gone.
process.stdin.on("data", () => undefined);
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
