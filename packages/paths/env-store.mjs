import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * On-disk format of the user environment store (Settings → Environment), which
 * holds service credentials such as ANTHROPIC_API_KEY. Version 2 is
 * AES-256-GCM encrypted under a key derived from the vault key the desktop
 * keeps in the OS keychain (or HARNESS_ENCRYPTION_KEY headless). Version 1 was
 * plaintext JSON; it is still read so an existing store can be migrated, and
 * never written.
 *
 * Shared by the local server (which edits the store) and the desktop main
 * process (which injects the variables into the processes it starts).
 */

const INFO = Buffer.from("harness-env-store-v2", "utf8");

export class EnvStoreLockedError extends Error {
  constructor(message = "The environment store is encrypted and secure storage is unavailable.") {
    super(message);
    this.name = "EnvStoreLockedError";
  }
}

/** @param {Uint8Array} rootKey */
export function deriveEnvStoreKey(rootKey) {
  if (rootKey.byteLength !== 32) throw new Error("The environment store root key must be 32 bytes.");
  return Buffer.from(hkdfSync("sha256", rootKey, Buffer.alloc(0), INFO, 32));
}

/**
 * @param {{ updatedAt: number, variables: Array<{ key: string, value: string, updatedAt: number }> }} payload
 * @param {Uint8Array} key from deriveEnvStoreKey
 */
export function encryptEnvStore(payload, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(INFO);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `${JSON.stringify({
    schemaVersion: 2,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  }, null, 2)}\n`;
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} text file contents
 * @param {Uint8Array | null} key from deriveEnvStoreKey, or null when unavailable
 * @returns {{ encrypted: boolean, updatedAt: number | null, variables: unknown[] }}
 */
export function decryptEnvStore(text, key) {
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("The environment store has an invalid format.");
  if (parsed.schemaVersion === 2) {
    if (parsed.algorithm !== "aes-256-gcm" || typeof parsed.iv !== "string" || typeof parsed.tag !== "string" || typeof parsed.data !== "string") {
      throw new Error("The environment store envelope is invalid.");
    }
    if (!key) throw new EnvStoreLockedError();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
    decipher.setAAD(INFO);
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]).toString("utf8");
    const payload = JSON.parse(plaintext);
    if (!isRecord(payload) || !Array.isArray(payload.variables)) throw new Error("The environment store payload is invalid.");
    return { encrypted: true, updatedAt: typeof payload.updatedAt === "number" ? payload.updatedAt : null, variables: payload.variables };
  }
  if (!Array.isArray(parsed.variables)) throw new Error("The environment store has an invalid format.");
  return { encrypted: false, updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : null, variables: parsed.variables };
}
