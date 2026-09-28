// Session-route adapter for the provider-auth store's `harnessServer` slice.
//
// The settings route feeds the store the full harness-server store, whose
// snapshot carries the server's real capabilities (including `providerSync`)
// and host-token auth. The session route used to fabricate a snapshot with
// hard-coded `{ config }` capabilities and no auth at all, so on the app's
// default surface `serverHandlesProviderSync()` was permanently false:
// PUT /den-session never fired after sign-in, the local server never learned
// the Den session, and server-side cloud provider sync never started (#3671).
//
// This adapter reports the truth for the endpoint it wraps:
// - loopback local endpoints (the desktop's own Harness server) advertise
//   `providerSync: true` — every Harness server does
//   (apps/server/src/types.ts `Capabilities.providerSync: true`) — and carry
//   the live host token so the store can PUT /den-session and
//   POST /cloud-provider-sync/run;
// - remote workspaces and non-loopback local URL overrides stay config-only:
//   a local workspace label does not authorize forwarding desktop credentials.
import {
  createHarnessServerClient,
  isLoopbackHarnessServerUrl,
  readHarnessServerSettings,
  type HarnessServerClient,
} from "@/app/lib/harness-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { ProviderAuthHarnessServer } from "./store";

type SessionHarnessServerSnapshot = ReturnType<ProviderAuthHarnessServer["getSnapshot"]>;

export type CreateSessionHarnessServerInput = {
  endpoint: () => ResolvedWorkspaceEndpoint | null;
  /** Live host token from the desktop runtime (harnessServerInfo). */
  hostToken?: () => string;
  generation?: () => number | null;
};

function resolveHostToken(endpoint: ResolvedWorkspaceEndpoint, live: string): string {
  // Fallback mirrors harness-server-store's getAuth(): persisted settings may
  // hold the host token (ensureDesktopLocalHarnessConnection writes it), but
  // both live and stored host tokens must stay on loopback servers.
  if (!isLoopbackHarnessServerUrl(endpoint.baseUrl)) return "";
  if (live) return live;
  return readHarnessServerSettings().hostToken?.trim() ?? "";
}

export function createSessionHarnessServer(
  input: CreateSessionHarnessServerInput,
): ProviderAuthHarnessServer {
  let clientCacheKey = "";
  let clientCacheValue: HarnessServerClient | null = null;

  const hostAwareClient = (endpoint: ResolvedWorkspaceEndpoint, hostToken: string): HarnessServerClient => {
    if (!hostToken) return endpoint.client;
    const key = `${endpoint.baseUrl}\u001f${endpoint.token}\u001f${hostToken}`;
    if (key !== clientCacheKey || !clientCacheValue) {
      clientCacheKey = key;
      clientCacheValue = createHarnessServerClient({
        baseUrl: endpoint.baseUrl,
        token: endpoint.token || undefined,
        hostToken,
      });
    }
    return clientCacheValue;
  };

  return {
    getSnapshot: (): SessionHarnessServerSnapshot => {
      const endpoint = input.endpoint();
      if (!endpoint) {
        return {
          harnessServerStatus: "disconnected",
          harnessServerClient: null,
          harnessServerCapabilities: null,
        };
      }
      if (endpoint.isRemote || !isLoopbackHarnessServerUrl(endpoint.baseUrl)) {
        return {
          harnessServerStatus: "connected",
          harnessServerClient: endpoint.client,
          harnessServerCapabilities: { config: { read: true, write: true } },
        };
      }
      const hostToken = resolveHostToken(endpoint, input.hostToken?.().trim() ?? "");
      return {
        harnessServerStatus: "connected",
        harnessServerClient: hostAwareClient(endpoint, hostToken),
        harnessServerHostInfo: { generation: input.generation?.() ?? null },
        harnessServerAuth: {
          token: endpoint.token || undefined,
          hostToken: hostToken || undefined,
        },
        harnessServerCapabilities: {
          config: { read: true, write: true },
          providerSync: true,
        },
      };
    },
  };
}
