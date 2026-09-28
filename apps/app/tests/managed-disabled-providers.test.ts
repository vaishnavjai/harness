import { expect, test } from "bun:test";

import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import type { HarnessServerClient } from "../src/app/lib/harness-server";
import type { Client } from "../src/app/types";
import { readManagedDisabledProviders } from "../src/react-app/domains/connections/managed-engine-config";

function serverClient(disabledProviders: string[], reads: string[]) {
  const client: Pick<HarnessServerClient, "getRuntimeDisabledProviders"> = {
    getRuntimeDisabledProviders: async (workspaceId: string) => {
      reads.push(workspaceId);
      return { ok: true, disabledProviders };
    },
  };
  // Only the one method this path calls is implemented.
  return client as HarnessServerClient;
}

test("OpenCode v2 reads disabled providers from the Harness server, not its private engine config", async () => {
  const reads: string[] = [];
  const originalFetch = globalThis.fetch;
  let engineRequests = 0;
  globalThis.fetch = async () => {
    engineRequests += 1;
    return new Response("{}", { status: 403 });
  };
  try {
    const v2 = createClientV2("http://localhost/opencode2", "/workspace", {});
    expect(await readManagedDisabledProviders({
      opencodeClient: v2,
      harnessClient: serverClient(["opencode", " opencode ", "litellm"], reads),
      workspaceId: "ws_1",
      workspaceType: "local",
    })).toEqual(["opencode", "litellm"]);
    expect(reads).toEqual(["ws_1"]);
    expect(engineRequests).toBe(0);

    // Without a Harness server there is no source of truth; never invent one.
    expect(await readManagedDisabledProviders({ opencodeClient: v2, workspaceId: "ws_1", workspaceType: "local" })).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenCode v1 keeps reading disabled providers from engine config", async () => {
  const reads: string[] = [];
  const v1 = {
    config: { get: async () => ({ data: { disabled_providers: ["opencode"] } }) },
  } as unknown as Client;
  expect(await readManagedDisabledProviders({
    opencodeClient: v1,
    harnessClient: serverClient(["other"], reads),
    workspaceId: "ws_1",
    workspaceType: "local",
  })).toEqual(["opencode"]);
  expect(reads).toEqual([]);
});
