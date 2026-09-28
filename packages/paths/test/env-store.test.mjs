import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { EnvStoreLockedError, decryptEnvStore, deriveEnvStoreKey, encryptEnvStore } from "../env-store.mjs";

const payload = { updatedAt: 1, variables: [{ key: "ANTHROPIC_API_KEY", value: "sk-ant-secret", updatedAt: 1 }] };

describe("env store format", () => {
  test("round-trips encrypted and never writes the value in the clear", () => {
    const key = deriveEnvStoreKey(randomBytes(32));
    const text = encryptEnvStore(payload, key);
    expect(text).not.toContain("sk-ant-secret");
    expect(text).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 2, algorithm: "aes-256-gcm" });
    expect(decryptEnvStore(text, key)).toEqual({ encrypted: true, updatedAt: 1, variables: payload.variables });
  });

  test("refuses the wrong key, a tampered file, and a missing key", () => {
    const text = encryptEnvStore(payload, deriveEnvStoreKey(randomBytes(32)));
    expect(() => decryptEnvStore(text, deriveEnvStoreKey(randomBytes(32)))).toThrow();
    const envelope = JSON.parse(text);
    const data = Buffer.from(envelope.data, "base64");
    data[0] ^= 1;
    expect(() => decryptEnvStore(JSON.stringify({ ...envelope, data: data.toString("base64") }), deriveEnvStoreKey(randomBytes(32)))).toThrow();
    expect(() => decryptEnvStore(text, null)).toThrow(EnvStoreLockedError);
  });

  test("reads a legacy plaintext store so it can be migrated", () => {
    const legacy = JSON.stringify({ schemaVersion: 1, updatedAt: 5, variables: payload.variables });
    expect(decryptEnvStore(legacy, null)).toEqual({ encrypted: false, updatedAt: 5, variables: payload.variables });
  });

  test("derives a domain-separated key", () => {
    const root = randomBytes(32);
    expect(deriveEnvStoreKey(root).equals(root)).toBe(false);
    expect(deriveEnvStoreKey(root).equals(deriveEnvStoreKey(root))).toBe(true);
    expect(() => deriveEnvStoreKey(randomBytes(16))).toThrow();
  });
});
