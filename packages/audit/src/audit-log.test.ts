import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuditLogger, readAuditTail, redactSecrets, verifyAuditLog, type AuditRecord } from "./audit-log.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop() ?? "", { recursive: true, force: true });
});

async function logPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-audit-"));
  dirs.push(dir);
  return join(dir, "nested", "audit.log");
}

async function lines(path: string): Promise<AuditRecord[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as AuditRecord);
}

describe("audit log", () => {
  test("appends UTC-timestamped JSON lines chained by hash, with private permissions", async () => {
    const path = await logPath();
    const logger = createAuditLogger({ filePath: path, source: "desktop", now: () => new Date("2026-09-28T12:00:00Z") });
    logger.record({ kind: "terminal.session.start", actor: "user", subject: "/bin/zsh", detail: { cwd: "/tmp/work" } });
    logger.record({ kind: "file.write", actor: "agent", subject: "/tmp/work/notes.md", detail: { bytes: 42 } });
    await logger.flush();
    const records = await lines(path);
    expect(records).toHaveLength(2);
    expect(records[0]?.ts).toBe("2026-09-28T12:00:00.000Z");
    expect(records[0]?.session).toMatch(/^[0-9a-f]{64}$/);
    expect(records[0]?.prev).toBe("0".repeat(64));
    expect(records[1]?.prev).toBe(records[0]?.hash);
    expect(records.map((record) => record.seq)).toEqual([1, 2]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect(await verifyAuditLog(path)).toEqual({ ok: true, records: 2, sessions: 1 });
  });

  test("detects edited, deleted and reordered records", async () => {
    const path = await logPath();
    const logger = createAuditLogger({ filePath: path, source: "engine" });
    for (const command of ["ls", "git status", "rm -rf build"]) logger.record({ kind: "tool.execute", subject: "bash", detail: { command } });
    await logger.flush();
    const original = (await readFile(path, "utf8")).trim().split("\n");

    await writeFile(path, `${original.map((line) => line.replace("rm -rf build", "echo ok")).join("\n")}\n`);
    expect((await verifyAuditLog(path)).firstBreak?.reason).toContain("do not match");

    await writeFile(path, `${[original[0], original[2]].join("\n")}\n`);
    expect((await verifyAuditLog(path)).firstBreak).toEqual({ line: 2, reason: "chain broken: a record was removed, reordered or inserted" });

    await writeFile(path, `${[original[1], original[0], original[2]].join("\n")}\n`);
    expect((await verifyAuditLog(path)).ok).toBe(false);
  });

  test("interleaved writers keep independent, verifiable chains", async () => {
    const path = await logPath();
    const desktop = createAuditLogger({ filePath: path, source: "desktop" });
    const engine = createAuditLogger({ filePath: path, source: "engine" });
    for (let index = 0; index < 20; index += 1) {
      desktop.record({ kind: "file.write", subject: `a${index}` });
      engine.record({ kind: "tool.execute", subject: `b${index}` });
    }
    await Promise.all([desktop.flush(), engine.flush()]);
    expect(await verifyAuditLog(path)).toEqual({ ok: true, records: 40, sessions: 2 });
    const newestFirst = (await lines(path)).reverse();
    const tail = await readAuditTail(path, 5);
    expect(tail.map((record) => record.hash)).toEqual(newestFirst.slice(0, 5).map((record) => record.hash));
    const all = await readAuditTail(path, 100);
    expect(new Set(all.map((record) => record.subject)).size).toBe(40);
  });

  test("redacts credentials and bounds oversized values", async () => {
    expect(redactSecrets("curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://x")).toContain("Bearer [redacted]");
    expect(redactSecrets("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv")).toBe("OPENAI_API_KEY=[redacted]");
    expect(redactSecrets("export password='hunter2'")).toBe("export password=[redacted]");
    expect(redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("token [redacted]");
    const path = await logPath();
    const logger = createAuditLogger({ filePath: path, source: "engine" });
    logger.record({ kind: "tool.execute", subject: "bash", detail: { command: `echo ${"x".repeat(10_000)}` } });
    await logger.flush();
    const [record] = await lines(path);
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(3_800);
    expect(String(record?.detail?.command)).toContain("[truncated]");
    expect((await verifyAuditLog(path)).ok).toBe(true);
  });

  test("never throws into the caller when the log cannot be written", async () => {
    const errors: unknown[] = [];
    const logger = createAuditLogger({ filePath: "/proc/definitely/not/writable/audit.log", source: "desktop", onError: (error) => errors.push(error) });
    expect(() => logger.record({ kind: "file.write" })).not.toThrow();
    await logger.flush();
    expect(errors).toHaveLength(1);
  });
});
