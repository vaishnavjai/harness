import { platform } from "node:os";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { harnessEnvStorePath } from "@harness/paths";
import { EnvStoreLockedError, decryptEnvStore, deriveEnvStoreKey, encryptEnvStore } from "@harness/paths/env-store";

import { ensureDir, exists } from "./utils.js";

// User-level environment variables, persisted so the desktop shell can inject
// them into every spawned child (OpenCode and Harness server). The file is
// AES-256-GCM encrypted (see @harness/paths/env-store) under the vault key the
// desktop keeps in the OS keychain, or HARNESS_ENCRYPTION_KEY when headless;
// a legacy plaintext store is re-encrypted the first time a key is available.
// Motivation: Linux GUI launches don't inherit shell env, so users set
// ANTHROPIC_API_KEY / GCLOUD_* / GCP_* in .bashrc and hit silent auth failures.
// Scope: user/machine, not workspace. Not synced to the cloud.

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Keys reserved for internal wiring by the desktop shell and server. This UI
// is for service credentials, not Harness/OpenCode runtime knobs; users who
// need OPENCODE_* process settings should set them from the launching shell.
// We refuse writes to these and strip them when reading for injection, so a
// tampered file cannot shadow auth credentials, token paths, or process
// identity.
const RESERVED_PREFIXES = ["HARNESS_", "OPENCODE_"] as const;
const PERSISTABLE_INTERNAL_KEYS = new Set([
  "HARNESS_API_KEY",
  "HARNESS_MODELS_API_KEY",
  "HARNESS_INFERENCE_BASE_URL",
  "HARNESS_MODELS_BASE_URL",
]);

export type EnvRecord = {
  key: string;
  value: string;
  updatedAt: number;
};

type EnvStoreFile = {
  schemaVersion: number;
  updatedAt: number;
  variables: EnvRecord[];
};

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}

export function isReservedEnvKey(key: string): boolean {
  return isInternalEnvKey(key) && !PERSISTABLE_INTERNAL_KEYS.has(key);
}

function isInternalEnvKey(key: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function resolveDefaultEnvStorePath(): string {
  return harnessEnvStorePath();
}

function parseRecord(raw: unknown): EnvRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<EnvRecord>;
  const key = typeof record.key === "string" ? record.key : "";
  const value = typeof record.value === "string" ? record.value : "";
  if (!isValidEnvKey(key)) return null;
  return {
    key,
    value,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}

function emptyStore(): EnvStoreFile {
  return { schemaVersion: 1, updatedAt: Date.now(), variables: [] };
}

/** Supplies the 32-byte vault key; rejects when secure storage is unavailable. */
export type EnvStoreRootKey = () => Promise<Uint8Array>;

type LoadedStore = EnvStoreFile & { encrypted: boolean };

async function resolveStoreKey(rootKey: EnvStoreRootKey | undefined): Promise<Buffer> {
  if (!rootKey) throw new EnvStoreLockedError(SECURE_STORAGE_UNAVAILABLE);
  try {
    return deriveEnvStoreKey(await rootKey());
  } catch {
    throw new EnvStoreLockedError(SECURE_STORAGE_UNAVAILABLE);
  }
}

const SECURE_STORAGE_UNAVAILABLE =
  "Secure storage for environment variables is unavailable. Start through Harness Desktop or set HARNESS_ENCRYPTION_KEY.";

async function readStore(
  path: string,
  options: { tolerateInvalid?: boolean; rootKey?: EnvStoreRootKey } = {},
): Promise<LoadedStore> {
  const empty = (): LoadedStore => ({ ...emptyStore(), encrypted: true });
  if (!(await exists(path))) {
    return empty();
  }
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return empty();
    if (options.tolerateInvalid) return empty();
    throw new EnvStoreReadError("Environment variable store could not be read");
  }

  let schemaVersion: unknown;
  try {
    schemaVersion = (JSON.parse(raw) as { schemaVersion?: unknown } | null)?.schemaVersion;
  } catch {
    if (options.tolerateInvalid) return empty();
    throw new EnvStoreReadError("Environment variable store is invalid JSON");
  }

  let decoded: ReturnType<typeof decryptEnvStore>;
  try {
    const key = schemaVersion === 2 ? await resolveStoreKey(options.rootKey) : null;
    decoded = decryptEnvStore(raw, key);
  } catch (error) {
    if (options.tolerateInvalid) return empty();
    if (error instanceof EnvStoreLockedError) throw error;
    throw new EnvStoreReadError("Environment variable store has an invalid format or could not be decrypted");
  }

  const variables = decoded.variables
    .map(parseRecord)
    .filter((entry): entry is EnvRecord => Boolean(entry));
  return {
    schemaVersion: 2,
    updatedAt: decoded.updatedAt ?? Date.now(),
    variables,
    encrypted: decoded.encrypted,
  };
}

async function writeStore(path: string, variables: EnvRecord[], rootKey: EnvStoreRootKey | undefined): Promise<void> {
  const key = await resolveStoreKey(rootKey);
  const dir = dirname(path);
  await ensureDir(dir);
  const tempPath = join(
    dir,
    `.env.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(tempPath, encryptEnvStore({ updatedAt: Date.now(), variables }, key), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await chmod(tempPath, 0o600);
  } catch (error) {
    // chmod is a no-op on Windows; values may still contain secrets.
    if (platform() !== "win32") {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    await chmod(path, 0o600);
  } catch (error) {
    // chmod is a no-op on Windows; values may still contain secrets.
    if (platform() !== "win32") throw error;
  }
}

export type EnvEntry = { key: string; value: string };

export class EnvService {
  private readonly path: string;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private variables: EnvRecord[] = [];
  private readonly changeListeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private readonly rootKey: EnvStoreRootKey | undefined;

  constructor(options?: { path?: string; rootKey?: EnvStoreRootKey }) {
    this.path = options?.path ? resolve(options.path) : resolveDefaultEnvStorePath();
    this.rootKey = options?.rootKey;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = readStore(this.path, { rootKey: this.rootKey })
        .then(async (store) => {
          if (!store.encrypted && store.variables.length) {
            // Re-encrypt a plaintext store from an older build. Without a key
            // it stays readable and is re-encrypted on the first write.
            await writeStore(this.path, store.variables, this.rootKey).catch(() => undefined);
          }
          this.variables = store.variables;
          this.loaded = true;
        })
        .finally(() => {
          this.loadPromise = null;
        });
    }
    await this.loadPromise;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.catch(() => {}).then(operation);
    this.mutationQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async list(): Promise<EnvRecord[]> {
    await this.ensureLoaded();
    return this.variables.slice();
  }

  async upsertMany(entries: EnvEntry[]): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded();
      const now = Date.now();
      const next = new Map(this.variables.map((entry) => [entry.key, entry] as const));
      for (const entry of entries) {
        if (!isValidEnvKey(entry.key)) {
          throw new InvalidEnvKeyError(entry.key, "invalid_env_key");
        }
        if (isReservedEnvKey(entry.key)) {
          throw new InvalidEnvKeyError(entry.key, "reserved_env_key");
        }
        next.set(entry.key, { key: entry.key, value: entry.value, updatedAt: now });
      }
      const nextVariables = Array.from(next.values()).sort((a, b) => a.key.localeCompare(b.key));
      await writeStore(this.path, nextVariables, this.rootKey);
      this.variables = nextVariables;
      for (const listener of this.changeListeners) listener();
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded();
      const before = this.variables.length;
      const nextVariables = this.variables.filter((entry) => entry.key !== key);
      if (nextVariables.length === before) return false;
      await writeStore(this.path, nextVariables, this.rootKey);
      this.variables = nextVariables;
      for (const listener of this.changeListeners) listener();
      return true;
    });
  }

  // Used by the Electron shell at spawn time. Keep desktop runtime injection
  // in sync on path resolution and reserved-keys policy.
  static async readForInjection(overridePath?: string, rootKey?: EnvStoreRootKey): Promise<Record<string, string>> {
    const path = overridePath?.trim() ? resolve(overridePath.trim()) : resolveDefaultEnvStorePath();
    const store = await readStore(path, { tolerateInvalid: true, rootKey });
    const out: Record<string, string> = {};
    for (const entry of store.variables) {
      if (isInternalEnvKey(entry.key)) continue;
      out[entry.key] = entry.value;
    }
    return out;
  }
}

export { EnvStoreLockedError };

export class EnvStoreReadError extends Error {
  readonly code = "invalid_env_store";
}

export class InvalidEnvKeyError extends Error {
  readonly code: "invalid_env_key" | "reserved_env_key";
  constructor(key: string, code: "invalid_env_key" | "reserved_env_key") {
    super(
      code === "reserved_env_key"
        ? `Environment variable name is reserved for Harness internals: ${key}`
        : `Invalid environment variable name: ${key}`,
    );
    this.code = code;
  }
}
