// Runs a supervisor in its own process so a test can SIGKILL it and check
// that the engine it started does not outlive it.
import { fileURLToPath } from "node:url";

import { HindsightSupervisor } from "../HindsightSupervisor.js";
import { parseMemorySettings } from "../memory-settings.js";

const [dataDir, pidFile] = process.argv.slice(2);
if (!dataDir || !pidFile) throw new Error("usage: supervisor-host <dataDir> <pidFile>");

const supervisor = new HindsightSupervisor({
  launch: {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fake-hindsight-engine.mjs", import.meta.url))],
    env: { FAKE_ENGINE_PID_FILE: pidFile },
  },
  dataDir,
  settings: parseMemorySettings({ enabled: true, port: 18_888 }),
  readyTimeoutMs: 20_000,
});

const endpoint = await supervisor.start();
console.log(JSON.stringify({ ready: true, port: endpoint.port }));
setInterval(() => undefined, 60_000);
