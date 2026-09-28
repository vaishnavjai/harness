// Runs the real engine under a supervisor in its own process, so a test can
// SIGKILL this process and check nothing it started survives.
import { HindsightSupervisor } from "../../src/HindsightSupervisor.js";
import { parseMemorySettings } from "../../src/memory-settings.js";

const [dataDir, port, command, ...args] = process.argv.slice(2);
if (!dataDir || !port || !command) throw new Error("usage: real-supervisor-host <dataDir> <port> <command> [...args]");

const supervisor = new HindsightSupervisor({
  launch: { command, args },
  dataDir,
  settings: parseMemorySettings({ enabled: true, port: Number(port) }),
  readyTimeoutMs: 240_000,
});
const endpoint = await supervisor.start();
console.log(JSON.stringify({ ready: true, pid: endpoint.pid }));
setInterval(() => undefined, 60_000);
