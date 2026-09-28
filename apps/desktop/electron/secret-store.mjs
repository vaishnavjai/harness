import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Credentials Harness manages itself (memory-engine API keys and the like),
 * encrypted at rest with AES-256-GCM.
 *
 * The 256-bit key comes from `getKey`; in the app that is
 * createDesktopVaultKeyProvider(), which stores the key only wrapped by the OS
 * keychain (macOS Keychain, Windows DPAPI, libsecret/KWallet on Linux via
 * Electron safeStorage) and refuses to run on Linux's plaintext fallback.
 * Every entry has its own random IV and is bound to its name as associated
 * data, so ciphertexts cannot be swapped between names. Plaintext is never
 * written to disk: if no key can be obtained, writes fail rather than degrade.
 */

const FORMAT = "harness-secret-store/v1";
const NAME_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const MAX_SECRET_LENGTH = 16_384;

/** @param {string} name */
function assertName(name) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error(`Invalid secret name: ${String(name).slice(0, 40)}`);
  }
}

/** @param {string} name */
function associatedData(name) {
  return Buffer.from(`${FORMAT}\0${name}`, "utf8");
}

/**
 * @param {Buffer} key
 * @param {string} name
 * @param {string} value
 */
function seal(key, name, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData(name));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/**
 * @param {Buffer} key
 * @param {string} name
 * @param {{ iv: string, tag: string, data: string }} entry
 */
function open(key, name, entry) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
  decipher.setAAD(associatedData(name));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8");
}

/**
 * @param {{ filePath: string, getKey: () => Promise<Buffer> }} options
 */
export function createSecretStore({ filePath, getKey }) {
  /** @type {Promise<unknown>} */
  let writes = Promise.resolve();

  async function key() {
    const value = await getKey();
    if (!Buffer.isBuffer(value) || value.byteLength !== 32) throw new Error("The secret store key must be 32 bytes.");
    return value;
  }

  /** @returns {Promise<Record<string, { iv: string, tag: string, data: string }>>} */
  async function readEntries() {
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
    const parsed = JSON.parse(raw);
    if (parsed?.format !== FORMAT || typeof parsed.entries !== "object" || parsed.entries === null) {
      throw new Error("The secret store file is not in a recognised format.");
    }
    return parsed.entries;
  }

  /** @param {Record<string, { iv: string, tag: string, data: string }>} entries */
  async function writeEntries(entries) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ format: FORMAT, entries }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
      await chmod(filePath, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** Serialise read-modify-write cycles. */
  function mutate(change) {
    const next = writes.then(async () => {
      const entries = await readEntries();
      await change(entries);
      await writeEntries(entries);
    });
    writes = next.catch(() => undefined);
    return next;
  }

  return {
    /** @param {string} name @returns {Promise<string | null>} */
    async get(name) {
      assertName(name);
      const entry = (await readEntries())[name];
      if (!entry) return null;
      return open(await key(), name, entry);
    },
    /** @param {string} name @param {string} value */
    async set(name, value) {
      assertName(name);
      if (typeof value !== "string" || !value || value.length > MAX_SECRET_LENGTH) {
        throw new Error("Secrets must be non-empty strings.");
      }
      const encryptionKey = await key();
      await mutate((entries) => {
        entries[name] = seal(encryptionKey, name, value);
      });
    },
    /** @param {string} name */
    async delete(name) {
      assertName(name);
      await mutate((entries) => {
        delete entries[name];
      });
    },
    /** @param {string} name */
    async has(name) {
      assertName(name);
      return Boolean((await readEntries())[name]);
    },
  };
}
