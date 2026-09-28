import { useSyncExternalStore } from "react";

import { t } from "../../../i18n";
import type { StartupPreference, WorkspaceDisplay } from "../../../app/types";
import { isDesktopRuntime } from "../../../app/utils";
import {
  harnessServerInfo,
  harnessServerRestart,
  type HarnessServerInfo,
} from "../../../app/lib/desktop";
import {
  getHarnessGatewayOrigin,
  readHarnessGatewayDenToken,
} from "../../../app/lib/gateway-runtime";
import {
  clearHarnessServerSettings,
  createHarnessServerClient,
  isLoopbackHarnessServerUrl,
  normalizeHarnessServerUrl,
  readHarnessServerSettings,
  writeHarnessServerSettings,
  type HarnessAuditEntry,
  type HarnessServerCapabilities,
  type HarnessServerClient,
  type HarnessServerDiagnostics,
  type HarnessServerError,
  type HarnessServerSettings,
  type HarnessServerStatus,
} from "../../../app/lib/harness-server";

type SetStateAction<T> = T | ((current: T) => T);

type RemoteWorkspaceInput = {
  harnessHostUrl: string;
  harnessToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export type HarnessServerStoreSnapshot = {
  harnessServerSettings: HarnessServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  harnessServerUrl: string;
  harnessServerBaseUrl: string;
  harnessServerAuth: { token?: string; hostToken?: string };
  harnessServerClient: HarnessServerClient | null;
  harnessServerStatus: HarnessServerStatus;
  harnessServerCapabilities: HarnessServerCapabilities | null;
  harnessServerReady: boolean;
  harnessServerWorkspaceReady: boolean;
  resolvedHarnessCapabilities: HarnessServerCapabilities | null;
  harnessServerCanWriteSkills: boolean;
  harnessServerCanWritePlugins: boolean;
  harnessServerHostInfo: HarnessServerInfo | null;
  harnessServerDiagnostics: HarnessServerDiagnostics | null;
  harnessReconnectBusy: boolean;
  harnessAuditEntries: HarnessAuditEntry[];
  harnessAuditStatus: "idle" | "loading" | "error";
  harnessAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

export type HarnessServerStore = ReturnType<typeof createHarnessServerStore>;

type CreateHarnessServerStoreOptions = {
  startupPreference: () => StartupPreference | null;
  documentVisible: () => boolean;
  developerMode: () => boolean;
  runtimeWorkspaceId: () => string | null;
  activeClient: () => unknown | null;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  restartLocalServer: () => Promise<boolean>;
  createRemoteWorkspaceFlow: (input: RemoteWorkspaceInput) => Promise<boolean>;
};

type MutableState = {
  harnessServerSettings: HarnessServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  harnessServerUrl: string;
  harnessServerStatus: HarnessServerStatus;
  harnessServerCapabilities: HarnessServerCapabilities | null;
  harnessServerCheckedAt: number | null;
  harnessServerHostInfo: HarnessServerInfo | null;
  harnessServerHostInfoReady: boolean;
  harnessServerDiagnostics: HarnessServerDiagnostics | null;
  harnessReconnectBusy: boolean;
  harnessAuditEntries: HarnessAuditEntry[];
  harnessAuditStatus: "idle" | "loading" | "error";
  harnessAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
  typeof next === "function" ? (next as (value: T) => T)(current) : next;

function sameHarnessServerSnapshot(
  current: HarnessServerStoreSnapshot,
  next: HarnessServerStoreSnapshot,
): boolean {
  return (
    current.harnessServerSettings === next.harnessServerSettings &&
    current.shareRemoteAccessBusy === next.shareRemoteAccessBusy &&
    current.shareRemoteAccessError === next.shareRemoteAccessError &&
    current.harnessServerUrl === next.harnessServerUrl &&
    current.harnessServerBaseUrl === next.harnessServerBaseUrl &&
    current.harnessServerAuth.token === next.harnessServerAuth.token &&
    current.harnessServerAuth.hostToken === next.harnessServerAuth.hostToken &&
    current.harnessServerClient === next.harnessServerClient &&
    current.harnessServerStatus === next.harnessServerStatus &&
    current.harnessServerCapabilities === next.harnessServerCapabilities &&
    current.harnessServerReady === next.harnessServerReady &&
    current.harnessServerWorkspaceReady === next.harnessServerWorkspaceReady &&
    current.resolvedHarnessCapabilities === next.resolvedHarnessCapabilities &&
    current.harnessServerCanWriteSkills === next.harnessServerCanWriteSkills &&
    current.harnessServerCanWritePlugins === next.harnessServerCanWritePlugins &&
    current.harnessServerHostInfo === next.harnessServerHostInfo &&
    current.harnessServerDiagnostics === next.harnessServerDiagnostics &&
    current.harnessReconnectBusy === next.harnessReconnectBusy &&
    current.harnessAuditEntries === next.harnessAuditEntries &&
    current.harnessAuditStatus === next.harnessAuditStatus &&
    current.harnessAuditError === next.harnessAuditError &&
    current.devtoolsWorkspaceId === next.devtoolsWorkspaceId
  );
}

export function createHarnessServerStore(options: CreateHarnessServerStoreOptions) {
  const bootStartedAt = Date.now();
  const listeners = new Set<() => void>();
  const intervals = new Map<string, number>();

  let clientCacheKey = "";
  let clientCacheValue: HarnessServerClient | null = null;
  let started = false;
  let disposed = false;
  let healthTimeoutId: number | null = null;
  let healthBusy = false;
  let healthDelayMs = 10_000;
  let consecutiveHealthFailures = 0;
  let visibilityChangeHandler: (() => void) | null = null;
  let snapshot: HarnessServerStoreSnapshot | undefined;

  let state: MutableState = {
    harnessServerSettings: readHarnessServerSettings(),
    shareRemoteAccessBusy: false,
    shareRemoteAccessError: null,
    harnessServerUrl: "",
    harnessServerStatus: "disconnected",
    harnessServerCapabilities: null,
    harnessServerCheckedAt: null,
    harnessServerHostInfo: null,
    harnessServerHostInfoReady: !isDesktopRuntime(),
    harnessServerDiagnostics: null,
    harnessReconnectBusy: false,
    harnessAuditEntries: [],
    harnessAuditStatus: "idle",
    harnessAuditError: null,
    devtoolsWorkspaceId: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getBaseUrl = () => {
    const gatewayOrigin = getHarnessGatewayOrigin();
    if (gatewayOrigin) return normalizeHarnessServerUrl(gatewayOrigin) ?? "";

    const pref = options.startupPreference();
    const hostInfo = state.harnessServerHostInfo;
    const settingsUrl = normalizeHarnessServerUrl(state.harnessServerSettings.urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server" && settingsUrl && isLoopbackHarnessServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return hostInfo.baseUrl;
    }
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  };

  const getAuth = () => {
    const gatewayOrigin = getHarnessGatewayOrigin();
    if (gatewayOrigin) {
      const token = readHarnessGatewayDenToken().trim();
      return { token: token || undefined, hostToken: undefined };
    }

    const pref = options.startupPreference();
    const hostInfo = state.harnessServerHostInfo;
    const settingsUrl = normalizeHarnessServerUrl(state.harnessServerSettings.urlOverride ?? "") ?? "";
    const settingsToken = state.harnessServerSettings.token?.trim() ?? "";
    const settingsHostToken = state.harnessServerSettings.hostToken?.trim() ?? "";
    const clientToken = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";

    if (pref === "local") {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    if (pref === "server" && settingsUrl && isLoopbackHarnessServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return {
        token: clientToken || settingsToken || undefined,
        hostToken: hostToken || settingsHostToken || undefined,
      };
    }
    if (pref === "server") {
      return {
        token: settingsToken || undefined,
        hostToken: settingsUrl && isLoopbackHarnessServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
      };
    }
    if (hostInfo?.baseUrl) {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    return {
      token: settingsToken || undefined,
      hostToken: settingsUrl && isLoopbackHarnessServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
    };
  };

  const getClient = () => {
    const baseUrl = getBaseUrl().trim();
    if (!baseUrl) {
      clientCacheKey = "";
      clientCacheValue = null;
      return null;
    }

    const auth = getAuth();
    const key = `${baseUrl}::${auth.token ?? ""}::${auth.hostToken ?? ""}`;
    if (key !== clientCacheKey) {
      clientCacheKey = key;
      clientCacheValue = createHarnessServerClient({
        baseUrl,
        token: auth.token,
        hostToken: auth.hostToken,
      });
    }
    return clientCacheValue;
  };

  const refreshSnapshot = (): boolean => {
    const harnessServerBaseUrl = getBaseUrl().trim();
    const harnessServerAuth = getAuth();
    const harnessServerClient = getClient();
    const harnessServerReady = state.harnessServerStatus === "connected";
    const harnessServerWorkspaceReady = Boolean(options.runtimeWorkspaceId());
    const resolvedHarnessCapabilities = state.harnessServerCapabilities;

    const pref = options.startupPreference();
    const info = state.harnessServerHostInfo;
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeHarnessServerUrl(state.harnessServerSettings.urlOverride ?? "") ?? "";

    let harnessServerUrl = hostUrl || settingsUrl;
    if (pref === "local") harnessServerUrl = hostUrl;
    if (pref === "server") harnessServerUrl = settingsUrl;
    state.harnessServerUrl = harnessServerUrl;

    const nextSnapshot: HarnessServerStoreSnapshot = {
      harnessServerSettings: state.harnessServerSettings,
      shareRemoteAccessBusy: state.shareRemoteAccessBusy,
      shareRemoteAccessError: state.shareRemoteAccessError,
      harnessServerUrl,
      harnessServerBaseUrl,
      harnessServerAuth,
      harnessServerClient,
      harnessServerStatus: state.harnessServerStatus,
      harnessServerCapabilities: state.harnessServerCapabilities,
      harnessServerReady,
      harnessServerWorkspaceReady,
      resolvedHarnessCapabilities,
      harnessServerCanWriteSkills:
        harnessServerReady &&
        (resolvedHarnessCapabilities?.skills?.write ?? false),
      harnessServerCanWritePlugins:
        harnessServerReady &&
        (resolvedHarnessCapabilities?.plugins?.write ?? false),
      harnessServerHostInfo: state.harnessServerHostInfo,
      harnessServerDiagnostics: state.harnessServerDiagnostics,
      harnessReconnectBusy: state.harnessReconnectBusy,
      harnessAuditEntries: state.harnessAuditEntries,
      harnessAuditStatus: state.harnessAuditStatus,
      harnessAuditError: state.harnessAuditError,
      devtoolsWorkspaceId: state.devtoolsWorkspaceId,
    };
    if (snapshot && sameHarnessServerSnapshot(snapshot, nextSnapshot)) return false;
    snapshot = nextSnapshot;
    return true;
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    if (refreshSnapshot()) emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const setHarnessServerSettings = (next: SetStateAction<HarnessServerSettings>) => {
    const resolved = applyStateAction(state.harnessServerSettings, next);
    mutateState((current) => ({ ...current, harnessServerSettings: resolved }));
    queueHealthCheck(0);
  };

  const updateHarnessServerSettings = (next: HarnessServerSettings) => {
    const stored = writeHarnessServerSettings(next);
    mutateState((current) => ({ ...current, harnessServerSettings: stored }));
    queueHealthCheck(0);
  };

  const resetHarnessServerSettings = () => {
    clearHarnessServerSettings();
    mutateState((current) => ({ ...current, harnessServerSettings: {} }));
    queueHealthCheck(0);
  };

  const shouldWaitForLocalHostInfo = () =>
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    !state.harnessServerHostInfoReady;

  const shouldRetryStartupCheck = (status: HarnessServerStatus) =>
    status !== "connected" &&
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    Date.now() - bootStartedAt < 5_000;

  const checkHarnessServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createHarnessServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      const resolved = error as HarnessServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as HarnessServerStatus, capabilities: null };
      }
      return { status: "disconnected" as HarnessServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as HarnessServerStatus, capabilities: null };
    }

    try {
      const capabilities = await client.capabilities();
      return { status: "connected" as HarnessServerStatus, capabilities };
    } catch (error) {
      const resolved = error as HarnessServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as HarnessServerStatus, capabilities: null };
      }
      return { status: "disconnected" as HarnessServerStatus, capabilities: null };
    }
  };

  const clearHealthTimeout = () => {
    if (healthTimeoutId !== null) {
      window.clearTimeout(healthTimeoutId);
      healthTimeoutId = null;
    }
  };

  const queueHealthCheck = (delayMs: number) => {
    if (disposed || typeof window === "undefined") return;
    clearHealthTimeout();
    healthTimeoutId = window.setTimeout(() => {
      healthTimeoutId = null;
      void runHealthCheck();
    }, Math.max(0, delayMs));
  };

  const runHealthCheck = async () => {
    if (disposed || typeof window === "undefined") return;
    if (!options.documentVisible()) {
      queueHealthCheck(healthDelayMs);
      return;
    }
    if (shouldWaitForLocalHostInfo()) {
      queueHealthCheck(250);
      return;
    }
    if (healthBusy) return;

    const url = getBaseUrl().trim();
    const auth = getAuth();
    if (!url) {
      consecutiveHealthFailures = 0;
      mutateState((current) => ({
        ...current,
        harnessServerStatus: "disconnected",
        harnessServerCapabilities: null,
        harnessServerCheckedAt: Date.now(),
      }));
      return;
    }

    healthBusy = true;
    try {
      let result = await checkHarnessServer(url, auth.token, auth.hostToken);

      if (shouldRetryStartupCheck(result.status)) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        if (disposed) return;

        try {
          const info = await harnessServerInfo() as HarnessServerInfo;
          if (disposed) return;

          mutateState((current) => ({
            ...current,
            harnessServerHostInfo: info,
            harnessServerHostInfoReady: true,
          }));

          const retryUrl = info.baseUrl?.trim() ?? "";
          const retryToken = info.clientToken?.trim() || undefined;
          const retryHostToken = info.hostToken?.trim() || undefined;
          if (retryUrl) {
            result = await checkHarnessServer(retryUrl, retryToken, retryHostToken);
          }
        } catch {
          // Preserve the original check result when the retry probe fails.
        }
      }

      if (disposed) return;
      const previousStatus = state.harnessServerStatus;
      const previousCapabilities = state.harnessServerCapabilities;
      const healthy = result.status === "connected" || result.status === "limited";
      if (healthy) {
        consecutiveHealthFailures = 0;
        healthDelayMs = 10_000;
      } else {
        consecutiveHealthFailures += 1;
        healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      }

      const preservePrevious =
        !healthy &&
        consecutiveHealthFailures < 3 &&
        (previousStatus === "connected" || previousStatus === "limited");

      mutateState((current) => ({
        ...current,
        harnessServerStatus: preservePrevious ? previousStatus : result.status,
        harnessServerCapabilities: preservePrevious ? previousCapabilities : result.capabilities,
        harnessServerCheckedAt: Date.now(),
      }));
    } catch {
      healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      mutateState((current) => ({
        ...current,
        harnessServerCheckedAt: Date.now(),
      }));
    } finally {
      healthBusy = false;
      if (!disposed) queueHealthCheck(healthDelayMs);
    }
  };

  const syncFromOptions = () => {
    if (refreshSnapshot()) emitChange();

    if (!isDesktopRuntime()) return;
    const port = state.harnessServerHostInfo?.port;
    if (!port) return;
    if (state.harnessServerSettings.portOverride === port) return;

    updateHarnessServerSettings({
      ...state.harnessServerSettings,
      portOverride: port,
    });
  };

  const startInterval = (key: string, fn: () => void, ms: number) => {
    if (typeof window === "undefined") return;
    if (intervals.has(key)) return;
    intervals.set(key, window.setInterval(fn, ms));
  };

  const stopInterval = (key: string) => {
    const id = intervals.get(key);
    if (id === undefined) return;
    window.clearInterval(id);
    intervals.delete(key);
  };

  const start = () => {
    if (typeof window === "undefined") return;
    if (started) return;
    // Allow restart after a prior dispose() (React 18 StrictMode double-mounts
    // each effect in dev: mount → dispose → re-mount). If we early-return when
    // `disposed` is true, the real mount never arms polling and the UI stays
    // on stale/empty state forever.
    disposed = false;
    started = true;

    syncFromOptions();
    queueHealthCheck(0);
    visibilityChangeHandler = () => {
      if (!options.documentVisible()) return;
      consecutiveHealthFailures = 0;
      queueHealthCheck(0);
    };
    window.addEventListener("visibilitychange", visibilityChangeHandler);

    const refreshHostInfo = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      void (async () => {
        try {
          const info = await harnessServerInfo() as HarnessServerInfo;
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            harnessServerHostInfo: info,
            harnessServerHostInfoReady: true,
          }));
        } catch {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            harnessServerHostInfo: null,
            harnessServerHostInfoReady: true,
          }));
        }
      })();
    };
    refreshHostInfo();
    startInterval("hostInfo", refreshHostInfo, 10_000);

    const refreshDiagnostics = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("harnessServerDiagnostics", null);
        return;
      }

      const client = getClient();
      if (!client || state.harnessServerStatus === "disconnected") {
        setStateField("harnessServerDiagnostics", null);
        return;
      }

      void (async () => {
        try {
          const status = await client.status();
          if (!disposed) setStateField("harnessServerDiagnostics", status);
        } catch {
          if (!disposed) setStateField("harnessServerDiagnostics", null);
        }
      })();
    };
    refreshDiagnostics();
    startInterval("diagnostics", refreshDiagnostics, 10_000);

    const refreshDevtoolsWorkspace = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      const client = getClient();
      if (!client) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      void (async () => {
        try {
          const response = await client.listWorkspaces();
          if (disposed) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const activeMatch = response.activeId
            ? items.find((item) => item.id === response.activeId)
            : null;
          setStateField("devtoolsWorkspaceId", activeMatch?.id ?? items[0]?.id ?? null);
        } catch {
          if (!disposed) setStateField("devtoolsWorkspaceId", null);
        }
      })();
    };
    refreshDevtoolsWorkspace();
    startInterval("devtoolsWorkspace", refreshDevtoolsWorkspace, 20_000);

    const refreshAudit = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        mutateState((current) => ({
          ...current,
          harnessAuditEntries: [],
          harnessAuditStatus: "idle",
          harnessAuditError: null,
        }));
        return;
      }

      const client = getClient();
      const workspaceId = state.devtoolsWorkspaceId;
      if (!client || !workspaceId) {
        mutateState((current) => ({
          ...current,
          harnessAuditEntries: [],
          harnessAuditStatus: "idle",
          harnessAuditError: null,
        }));
        return;
      }

      mutateState((current) => ({
        ...current,
        harnessAuditStatus: "loading",
        harnessAuditError: null,
      }));

      void (async () => {
        try {
          const result = await client.listAudit(workspaceId, 50);
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            harnessAuditEntries: Array.isArray(result.items) ? result.items : [],
            harnessAuditStatus: "idle",
          }));
        } catch (error) {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            harnessAuditEntries: [],
            harnessAuditStatus: "error",
            harnessAuditError:
              error instanceof Error
                ? error.message
                : t("app.error_audit_load"),
          }));
        }
      })();
    };
    refreshAudit();
    startInterval("audit", refreshAudit, 15_000);
  };

  const dispose = () => {
    disposed = true;
    started = false;
    clearHealthTimeout();
    if (visibilityChangeHandler && typeof window !== "undefined") {
      window.removeEventListener("visibilitychange", visibilityChangeHandler);
      visibilityChangeHandler = null;
    }
    for (const key of [...intervals.keys()]) stopInterval(key);
  };

  const testHarnessServerConnection = async (next: HarnessServerSettings) => {
    const derived = normalizeHarnessServerUrl(next.urlOverride ?? "");
    if (!derived) {
      mutateState((current) => ({
        ...current,
        harnessServerStatus: "disconnected",
        harnessServerCapabilities: null,
        harnessServerCheckedAt: Date.now(),
      }));
      return false;
    }

    const result = await checkHarnessServer(derived, next.token);
    consecutiveHealthFailures = result.status === "disconnected" ? consecutiveHealthFailures + 1 : 0;
    mutateState((current) => ({
      ...current,
      harnessServerStatus: result.status,
      harnessServerCapabilities: result.capabilities,
      harnessServerCheckedAt: Date.now(),
    }));

    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isDesktopRuntime()) {
      const active = options.selectedWorkspaceDisplay();
      const shouldAttach =
        !options.activeClient() ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "harness";
      if (shouldAttach) {
        await options
          .createRemoteWorkspaceFlow({
            harnessHostUrl: derived,
            harnessToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectHarnessServer = async () => {
    if (state.harnessReconnectBusy) return false;
    setStateField("harnessReconnectBusy", true);

    try {
      let hostInfo = state.harnessServerHostInfo;
      if (isDesktopRuntime()) {
        try {
          hostInfo = await harnessServerInfo() as HarnessServerInfo;
          mutateState((current) => ({ ...current, harnessServerHostInfo: hostInfo }));
        } catch {
          hostInfo = null;
          setStateField("harnessServerHostInfo", null);
        }
      }

      if (hostInfo?.clientToken?.trim() && options.startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const liveHostToken = hostInfo.hostToken?.trim() ?? "";
        const settings = state.harnessServerSettings;
        if (
          (settings.token?.trim() ?? "") !== liveToken ||
          (settings.hostToken?.trim() ?? "") !== liveHostToken
        ) {
          updateHarnessServerSettings({
            ...settings,
            token: liveToken,
            hostToken: liveHostToken || undefined,
          });
        }
      }

      const url = getBaseUrl().trim();
      const auth = getAuth();
      if (!url) {
        mutateState((current) => ({
          ...current,
          harnessServerStatus: "disconnected",
          harnessServerCapabilities: null,
          harnessServerCheckedAt: Date.now(),
        }));
        return false;
      }

      const result = await checkHarnessServer(url, auth.token, auth.hostToken);
      mutateState((current) => ({
        ...current,
        harnessServerStatus: result.status,
        harnessServerCapabilities: result.capabilities,
        harnessServerCheckedAt: Date.now(),
      }));
      return result.status === "connected" || result.status === "limited";
    } finally {
      setStateField("harnessReconnectBusy", false);
    }
  };

  async function ensureLocalHarnessServerClient(): Promise<HarnessServerClient | null> {
    const healthyClientFromInfo = async (
      info: HarnessServerInfo | null,
    ): Promise<HarnessServerClient | null> => {
      const baseUrl = info?.baseUrl?.trim() ?? "";
      const token = info?.clientToken?.trim() ?? "";
      if (!baseUrl || !token) return null;
      const candidate = createHarnessServerClient({
        baseUrl,
        token,
        hostToken: info?.hostToken?.trim() || undefined,
      });
      try {
        await candidate.health();
      } catch {
        return null;
      }
      return candidate;
    };

    const cached = await healthyClientFromInfo(state.harnessServerHostInfo);
    if (cached) {
      if (options.startupPreference() !== "server") {
        await reconnectHarnessServer();
      }
      return cached;
    }

    if (!isDesktopRuntime()) return null;

    // A store that has not observed the server yet (a fresh route mount)
    // must not treat it as dead: the restart below tears down the embedded
    // server AND its managed engine, killing every live run. Ask the desktop
    // bridge for the live server first and restart only when that running
    // server is genuinely unreachable.
    let hostInfo: HarnessServerInfo | null = null;
    try {
      hostInfo = await harnessServerInfo() as HarnessServerInfo;
      mutateState((current) => ({
        ...current,
        harnessServerHostInfo: hostInfo,
        harnessServerHostInfoReady: true,
      }));
    } catch {
      hostInfo = null;
    }
    const live = await healthyClientFromInfo(hostInfo);
    if (live) {
      if (options.startupPreference() !== "server") {
        await reconnectHarnessServer();
      }
      return live;
    }

    try {
      hostInfo = await harnessServerRestart({
        remoteAccessEnabled: state.harnessServerSettings.remoteAccessEnabled === true,
      }) as HarnessServerInfo;
      mutateState((current) => ({ ...current, harnessServerHostInfo: hostInfo }));
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) return null;

    if (options.startupPreference() !== "server") {
      await reconnectHarnessServer();
    }

    return createHarnessServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (state.shareRemoteAccessBusy) return;
    const previous = state.harnessServerSettings;
    const next: HarnessServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    mutateState((current) => ({
      ...current,
      shareRemoteAccessBusy: true,
      shareRemoteAccessError: null,
    }));
    updateHarnessServerSettings(next);

    try {
      if (isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await options.restartLocalServer();
        if (!restarted) {
          throw new Error(t("app.error_restart_local_worker"));
        }
        await reconnectHarnessServer();
      }
    } catch (error) {
      updateHarnessServerSettings(previous);
      mutateState((current) => ({
        ...current,
        shareRemoteAccessError:
          error instanceof Error
            ? error.message
            : t("app.error_remote_access"),
      }));
      return;
    } finally {
      setStateField("shareRemoteAccessBusy", false);
    }
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => {
    if (!snapshot) throw new Error("Harness server snapshot was not initialized.");
    return snapshot;
  };

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    setHarnessServerSettings,
    updateHarnessServerSettings,
    resetHarnessServerSettings,
    saveShareRemoteAccess,
    checkHarnessServer,
    testHarnessServerConnection,
    reconnectHarnessServer,
    ensureLocalHarnessServerClient,
  };
}

export function useHarnessServerStoreSnapshot(store: HarnessServerStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
