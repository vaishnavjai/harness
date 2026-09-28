import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type TreeSignal = "SIGTERM" | "SIGKILL" | "SIGINT";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/**
 * Signal a process and everything it started.
 *
 * POSIX: the supervisor spawns the engine as a process-group leader
 * (`detached: true`), so a negative pid reaches the whole group, including
 * grandchildren the engine never waited on. Windows has no process groups
 * for this purpose; `taskkill /T` walks the child tree instead (always
 * forced for SIGKILL). Never throws: a tree that is already gone is fine.
 */
export function signalProcessTree(pid: number, signal: TreeSignal, platform: NodeJS.Platform = process.platform): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    const args = ["/pid", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true, shell: false });
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    if (errorCode(error) !== "ESRCH" && errorCode(error) !== "EPERM") throw error;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already exited.
  }
}

export async function waitForExit(pid: number, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !isProcessAlive(pid);
}

/** Read the postmaster PID Postgres records in its data directory. */
export async function readPostmasterPid(pgDataDir: string): Promise<number | null> {
  try {
    const [firstLine] = (await readFile(join(pgDataDir, "postmaster.pid"), "utf8")).split(/\r?\n/, 1);
    const pid = Number.parseInt(firstLine ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Confirm a PID still belongs to Postgres before signalling it: a stale
 * postmaster.pid can name a PID the OS has since reused.
 */
function isPostgresProcess(pid: number, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
    });
    return /postgres/i.test(result.stdout ?? "");
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", shell: false });
  return /postgres|postmaster/i.test(result.stdout ?? "");
}

/**
 * Stop an embedded Postgres left running by an engine that died without its
 * own cleanup (for example SIGKILL). pg_ctl daemonizes the postmaster out of
 * the engine's process group, so the group signal cannot reach it.
 * Returns true when a postmaster was found and stopped.
 */
export async function reapEmbeddedPostgres(
  pgDataDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const pid = await readPostmasterPid(pgDataDir);
  if (!pid || !isProcessAlive(pid) || !isPostgresProcess(pid, platform)) return false;
  if (platform === "win32") {
    signalProcessTree(pid, "SIGKILL", platform);
    return waitForExit(pid, 5_000);
  }
  // SIGINT is Postgres' "fast shutdown": roll back, checkpoint, exit.
  try {
    process.kill(pid, "SIGINT");
  } catch {
    return true;
  }
  if (await waitForExit(pid, 10_000)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Exited between checks.
  }
  return waitForExit(pid, 2_000);
}
