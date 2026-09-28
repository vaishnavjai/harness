import { fileURLToPath } from "node:url";
import { main as runWorldCli, parseWorldArgs } from "@harness/world";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const WORLDS_DIRECTORY = fileURLToPath(new URL("../../../../worlds", import.meta.url));

export { parseWorldArgs };

export function main(argv = process.argv.slice(2)): Promise<number> {
  return runWorldCli(argv, {
    cwd: REPO_ROOT,
    worldsDirectory: WORLDS_DIRECTORY,
    reapers: {
      "daytona-windows-preview": async (entry) => {
        if (!/^harness-world-win-[0-9a-f]{16}$/.test(entry.match ?? "") || !/^[a-zA-Z0-9-]{1,100}$/.test(entry.id)) {
          return { status: "skipped", reason: "outside Windows world ownership boundary" };
        }
        const { defaultDaytonaExec } = await import("@harness/hosts");
        const info = await defaultDaytonaExec(["info", entry.id, "-f", "json"], { timeoutMs: 30_000 });
        if (info.code !== 0) {
          return /not found|does not exist/i.test(info.stderr + info.stdout)
            ? { status: "missing" } : { status: "skipped", reason: "could not verify sandbox ownership" };
        }
        let value: unknown;
        try { value = JSON.parse(info.stdout); } catch { return { status: "skipped", reason: "invalid sandbox identity" }; }
        if (typeof value !== "object" || value === null || !("id" in value) || value.id !== entry.id
          || !("name" in value) || value.name !== entry.match || !("public" in value) || value.public !== false
          || !("snapshot" in value) || value.snapshot !== "windows-medium") {
          return { status: "skipped", reason: "sandbox ownership mismatch" };
        }
        const { deleteSandboxes } = await import("@harness/hosts");
        await deleteSandboxes([entry.id], { log: () => {} });
        return { status: "reaped" };
      },
      "freestyle-evidence": async (entry) => {
        if (entry.match !== entry.id) return { status: "skipped", reason: "identity mismatch" };
        const { deleteEvidenceVm } = await import("../../../../packages/freestyle/src/checkpoints.ts");
        await deleteEvidenceVm(entry.id);
        return { status: "reaped" };
      },
      "freestyle-preview": async (entry) => {
        if (entry.match !== entry.id) return { status: "skipped", reason: "identity mismatch" };
        const { deletePreview } = await import("../../../../packages/freestyle/src/index.ts");
        await deletePreview(entry.id);
        return { status: "reaped" };
      },
    },
  });
}
