import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { createSecretStore } from "./secret-store.mjs";

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function store(key = randomBytes(32)) {
  const root = await mkdtemp(path.join(tmpdir(), "harness-secrets-"));
  roots.push(root);
  const filePath = path.join(root, "nested", "secrets.json");
  return { filePath, key, secrets: createSecretStore({ filePath, getKey: async () => key }) };
}

describe("secret store", () => {
  test("round-trips values that never appear in plaintext on disk", async () => {
    const { filePath, secrets } = await store();
    await secrets.set("memory.llm.api-key", "sk-live-very-secret-value");
    assert.equal(await secrets.get("memory.llm.api-key"), "sk-live-very-secret-value");
    assert.equal(await secrets.has("memory.llm.api-key"), true);
    const onDisk = await readFile(filePath, "utf8");
    assert.equal(onDisk.includes("very-secret"), false);
    assert.match(onDisk, /harness-secret-store\/v1/);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    await secrets.delete("memory.llm.api-key");
    assert.equal(await secrets.get("memory.llm.api-key"), null);
  });

  test("detects tampering and ciphertexts moved between names", async () => {
    const { filePath, secrets } = await store();
    await secrets.set("a.key", "alpha");
    await secrets.set("b.key", "bravo");
    const envelope = JSON.parse(await readFile(filePath, "utf8"));
    envelope.entries["a.key"] = envelope.entries["b.key"];
    await writeFile(filePath, JSON.stringify(envelope));
    await assert.rejects(secrets.get("a.key"));
    envelope.entries["b.key"].data = Buffer.from("forged").toString("base64");
    await writeFile(filePath, JSON.stringify(envelope));
    await assert.rejects(secrets.get("b.key"));
  });

  test("a different key cannot read the store", async () => {
    const { filePath, secrets } = await store();
    await secrets.set("memory.llm.api-key", "value");
    const other = createSecretStore({ filePath, getKey: async () => randomBytes(32) });
    await assert.rejects(other.get("memory.llm.api-key"));
  });

  test("fails closed when the OS keychain is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "harness-secrets-"));
    roots.push(root);
    const filePath = path.join(root, "secrets.json");
    const secrets = createSecretStore({
      filePath,
      getKey: async () => {
        throw new Error("A secure Linux password store is required");
      },
    });
    await assert.rejects(secrets.set("memory.llm.api-key", "value"), /secure Linux password store/);
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
  });

  test("rejects unsafe names and empty values", async () => {
    const { secrets } = await store();
    await assert.rejects(secrets.set("../escape", "x"), /Invalid secret name/);
    await assert.rejects(secrets.set("ok.name", ""), /non-empty/);
  });
});
