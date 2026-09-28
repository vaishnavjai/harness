import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Only frontend source changes can reach this path. All service code, schema,
// dependency inputs and controller files are part of the running-template key.
const root = "/opt/harness-preview";
const services = JSON.parse(await readFile(`${root}/services.json`, "utf8"));
const seen = new Set();
async function warm(path) {
  if (seen.has(path) || !path.startsWith("/") || path.startsWith("//")) return;
  seen.add(path);
  const response = await fetch(`${services.app}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Updated app module unavailable: ${path}`);
  const source = await response.text();
  for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*|src=)["'](\/[^"']+)["']/g)) await warm(match[1]);
}
// Let the development servers consume checkout's filesystem notifications.
await delay(500);
await warm("/");
await import("./health.mjs");
await writeFile(`${root}/source-sha`, process.argv[2]);
