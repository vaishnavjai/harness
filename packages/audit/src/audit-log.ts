import { createHash, randomBytes } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only, tamper-evident JSON-lines audit log (~/.config/harness/audit.log).
 *
 * Every process that writes (desktop shell, local server, the agent engine's
 * audit plugin) is a "session" with a random id, published only as a SHA-256
 * hash. Each record carries the hash of the previous record in its session,
 * so editing, reordering or deleting a record breaks the chain that
 * verifyAuditLog() recomputes. Records are appended with O_APPEND in one write
 * each, and the file is created 0600 inside a 0700 directory.
 *
 * A file the user owns cannot be made immutable from user space; the chain
 * makes tampering detectable instead. Values are redacted for common secret
 * shapes and bounded in size before they are written.
 */

export const AUDIT_FORMAT_VERSION = 1;
const GENESIS = "0".repeat(64);
const MAX_STRING = 1_024;
const MAX_DETAIL_KEYS = 24;
/** Keep one record per write() well inside atomic-append territory. */
const MAX_LINE_BYTES = 3_800;

export type AuditSource = "desktop" | "server" | "engine" | "memory";
export type AuditDetailValue = string | number | boolean | null;

export interface AuditEvent {
  /** Dotted event name, e.g. "tool.execute", "file.write", "terminal.session.start". */
  kind: string;
  /** What the event is about: a tool, a path, a command. */
  subject?: string;
  /** Who initiated it: "agent", "user", "harness". */
  actor?: "agent" | "user" | "harness";
  detail?: Record<string, AuditDetailValue | undefined>;
}

export interface AuditRecord {
  v: number;
  ts: string;
  seq: number;
  session: string;
  source: AuditSource;
  kind: string;
  actor: "agent" | "user" | "harness";
  subject?: string;
  detail?: Record<string, AuditDetailValue>;
  prev: string;
  hash: string;
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]"],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]"],
];

/** Mask common credential shapes; the audit log must never become a secret store. */
export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function bound(value: string): string {
  const redacted = redactSecrets(value);
  return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…[truncated]` : redacted;
}

function sanitizeDetail(detail: AuditEvent["detail"]): Record<string, AuditDetailValue> | undefined {
  if (!detail) return undefined;
  const out: Record<string, AuditDetailValue> = {};
  for (const [key, value] of Object.entries(detail).slice(0, MAX_DETAIL_KEYS)) {
    if (value === undefined) continue;
    out[key.slice(0, 64)] = typeof value === "string" ? bound(value) : value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Stable serialization: fixed key order, so a hash can be recomputed. */
function canonical(record: Omit<AuditRecord, "hash">): string {
  const ordered: Record<string, unknown> = {
    v: record.v,
    ts: record.ts,
    seq: record.seq,
    session: record.session,
    source: record.source,
    kind: record.kind,
    actor: record.actor,
  };
  if (record.subject !== undefined) ordered.subject = record.subject;
  if (record.detail !== undefined) {
    ordered.detail = Object.fromEntries(Object.entries(record.detail).sort(([a], [b]) => a.localeCompare(b)));
  }
  ordered.prev = record.prev;
  return JSON.stringify(ordered);
}

export function hashRecord(record: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(record.prev).update("\n").update(canonical(record)).digest("hex");
}

export interface AuditLoggerOptions {
  filePath: string;
  source: AuditSource;
  now?: () => Date;
  /** Called when a write fails; auditing never throws into callers. */
  onError?: (error: unknown) => void;
}

export interface AuditLogger {
  readonly session: string;
  record(event: AuditEvent): void;
  /** Resolves once every record queued so far is on disk. */
  flush(): Promise<void>;
}

export function createAuditLogger(options: AuditLoggerOptions): AuditLogger {
  const session = createHash("sha256").update(randomBytes(32)).digest("hex");
  const now = options.now ?? (() => new Date());
  let seq = 0;
  let prev = GENESIS;
  let queue: Promise<void> = Promise.resolve();
  let prepared = false;

  async function prepare(): Promise<void> {
    if (prepared) return;
    await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
    const handle = await open(options.filePath, "a", 0o600);
    await handle.close();
    await chmod(options.filePath, 0o600).catch(() => undefined);
    prepared = true;
  }

  function build(event: AuditEvent): AuditRecord {
    seq += 1;
    const detail = sanitizeDetail(event.detail);
    const base: Omit<AuditRecord, "hash"> = {
      v: AUDIT_FORMAT_VERSION,
      ts: now().toISOString(),
      seq,
      session,
      source: options.source,
      kind: event.kind.slice(0, 96),
      actor: event.actor ?? "harness",
      ...(event.subject !== undefined ? { subject: bound(event.subject) } : {}),
      ...(detail ? { detail } : {}),
      prev,
    };
    let record: AuditRecord = { ...base, hash: hashRecord(base) };
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_LINE_BYTES) {
      const trimmed: Omit<AuditRecord, "hash"> = {
        ...base,
        subject: base.subject?.slice(0, 256),
        detail: { truncated: true },
      };
      record = { ...trimmed, hash: hashRecord(trimmed) };
    }
    prev = record.hash;
    return record;
  }

  return {
    session,
    record(event) {
      const line = `${JSON.stringify(build(event))}\n`;
      queue = queue
        .then(prepare)
        .then(() => appendFile(options.filePath, line, { encoding: "utf8", mode: 0o600, flag: "a" }))
        .catch((error: unknown) => options.onError?.(error));
    },
    flush() {
      return queue;
    },
  };
}

export interface AuditVerification {
  ok: boolean;
  records: number;
  sessions: number;
  firstBreak?: { line: number; reason: string };
}

/** Recompute every session's hash chain. */
export async function verifyAuditLog(filePath: string): Promise<AuditVerification> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return { ok: true, records: 0, sessions: 0 };
  }
  const tails = new Map<string, { hash: string; seq: number }>();
  const lines = text.split("\n");
  let records = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const lineNumber = index + 1;
    let record: AuditRecord;
    try {
      record = JSON.parse(line) as AuditRecord;
    } catch {
      return { ok: false, records, sessions: tails.size, firstBreak: { line: lineNumber, reason: "unparseable record" } };
    }
    const { hash, ...rest } = record;
    if (hashRecord(rest) !== hash) {
      return { ok: false, records, sessions: tails.size, firstBreak: { line: lineNumber, reason: "record contents do not match its hash" } };
    }
    const tail = tails.get(record.session) ?? { hash: GENESIS, seq: 0 };
    if (record.prev !== tail.hash || record.seq !== tail.seq + 1) {
      return { ok: false, records, sessions: tails.size, firstBreak: { line: lineNumber, reason: "chain broken: a record was removed, reordered or inserted" } };
    }
    tails.set(record.session, { hash, seq: record.seq });
    records += 1;
  }
  return { ok: true, records, sessions: tails.size };
}

/** The newest `limit` records, newest first, reading only the file's tail. */
export async function readAuditTail(filePath: string, limit = 200): Promise<AuditRecord[]> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return [];
  }
  const window = Math.min(size, Math.max(limit, 1) * MAX_LINE_BYTES);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(window);
    await handle.read(buffer, 0, window, size - window);
    const lines = buffer.toString("utf8").split("\n");
    if (window < size) lines.shift(); // partial first line
    const records: AuditRecord[] = [];
    for (const line of lines.reverse()) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as AuditRecord);
      } catch {
        // skip a torn line
      }
      if (records.length >= limit) break;
    }
    return records;
  } finally {
    await handle.close();
  }
}
