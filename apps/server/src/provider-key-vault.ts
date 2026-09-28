import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { localSecretVaultKey } from "./local-managed-mcp.js";
import { runtimeStorageDir } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

/**
 * Model-provider API keys, encrypted at rest with AES-256-GCM.
 *
 * The engine's own credential store (`auth.json`) is plaintext, so Harness
 * never gives it an API key. Keys live here instead, under a key held by the
 * OS keychain (desktop) or HARNESS_ENCRYPTION_KEY (headless). The engine
 * receives them in memory through the `harness-provider-keys` plugin, which
 * asks this server over loopback with a per-launch secret only the engine
 * process is given.
 */

const VAULT_FILE = "provider-keys.json";
const AAD = Buffer.from("harness-provider-keys-v1", "utf8");
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_KEY_LENGTH = 8_192;

/** Header the engine plugin sends; its value is ENGINE_PROVIDER_KEYS_SECRET. */
export const ENGINE_PROVIDER_KEYS_HEADER = "x-harness-engine-secret";
/** Env var that carries the per-launch secret into managed engine processes. */
export const ENGINE_PROVIDER_KEYS_ENV = "HARNESS_ENGINE_SECRET";
/** Generated once per server process; never persisted or sent to a client. */
export const ENGINE_PROVIDER_KEYS_SECRET = randomBytes(32).toString("base64url");

type Envelope = {
  schemaVersion: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

type ProviderKeys = Record<string, string>;

const writesByPath = new Map<string, Promise<unknown>>();

function vaultPath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), VAULT_FILE);
}

async function vaultSubKey(config: ServerConfig): Promise<Buffer> {
  const root = await localSecretVaultKey(config);
  return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), AAD, 32));
}

function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && record.algorithm === "aes-256-gcm"
    && typeof record.iv === "string"
    && typeof record.tag === "string"
    && typeof record.data === "string";
}

function parseKeys(value: unknown): ProviderKeys {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The provider key vault payload is invalid.");
  }
  const keys: ProviderKeys = {};
  for (const [providerId, key] of Object.entries(value)) {
    if (PROVIDER_ID_PATTERN.test(providerId) && typeof key === "string" && key) keys[providerId] = key;
  }
  return keys;
}

export function isValidProviderId(providerId: string): boolean {
  return PROVIDER_ID_PATTERN.test(providerId);
}

/** Every stored key, decrypted. Missing vault → empty. */
export async function readProviderKeys(config: ServerConfig): Promise<ProviderKeys> {
  let raw: string;
  try {
    raw = await readFile(vaultPath(config), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const envelope: unknown = JSON.parse(raw);
  if (!isEnvelope(envelope)) throw new Error("The provider key vault envelope is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", await vaultSubKey(config), Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  return parseKeys(JSON.parse(plaintext));
}

/** Provider ids that have a stored key. Never returns key material. */
export async function listProviderKeyIds(config: ServerConfig): Promise<string[]> {
  return Object.keys(await readProviderKeys(config)).sort();
}

async function writeProviderKeys(config: ServerConfig, keys: ProviderKeys): Promise<void> {
  const path = vaultPath(config);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await vaultSubKey(config), iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(keys), "utf8"), cipher.final()]);
  const envelope: Envelope = {
    schemaVersion: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  await mkdir(runtimeStorageDir(config), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Store (or, with null, remove) one provider's key. Writes are serialized. */
export async function setProviderKey(config: ServerConfig, providerId: string, key: string | null): Promise<void> {
  if (!isValidProviderId(providerId)) throw new Error("Invalid provider id.");
  if (key !== null && (!key.trim() || key.length > MAX_KEY_LENGTH)) throw new Error("Invalid API key.");
  const path = vaultPath(config);
  const previous = writesByPath.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const keys = await readProviderKeys(config);
    if (key === null) delete keys[providerId];
    else keys[providerId] = key.trim();
    await writeProviderKeys(config, keys);
  });
  writesByPath.set(path, next);
  try {
    await next;
  } finally {
    if (writesByPath.get(path) === next) writesByPath.delete(path);
  }
}

/** Constant-time check of the secret presented by an engine plugin. */
export function isEngineProviderKeysSecret(presented: string | null): boolean {
  if (!presented) return false;
  const expected = Buffer.from(ENGINE_PROVIDER_KEYS_SECRET, "utf8");
  const actual = Buffer.from(presented, "utf8");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
