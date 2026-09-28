import { browserScript } from "@harness/cdp";
import { createAndSelectWorkspace } from "@harness/behaviors";
import { attachSurface, evaluateOnSurface, isInteractive, probeAppStateOnSurface } from "@harness/cdp";
import type { Surface } from "@harness/cdp";
import { desktop, retainedDesktop } from "@harness/hosts";
import { liveSharedProductionStateEnv } from "@harness/hosts";
import { progress, trackResource } from "@harness/world";
import type { AppReadiness, DesktopHandle, DesktopRelease, Host, InstalledProductionDesktopState, RetainedDesktopHandle } from "@harness/hosts";
import type { Place } from "./place.ts";

const steps = progress();

export interface AppOptions {
  place: Place;
  host?: Host;
  model?: string;
  /** Extra environment for this isolated Electron process. */
  env?: Record<string, string>;
  workspacePath?: string;
  /** Reuse this caller-owned local Electron profile root instead of creating one. */
  profileDir?: string;
  /** Eval-only delay before the desktop starts its embedded Harness server. */
  localServerDelayMs?: number;
  /**
   * `false` leaves the first launch exactly as a person sees it: no harness
   * workspace is added next to whatever the app arranges itself, and
   * `workspacePath` is ignored. `workspaceId` is then "".
   */
  workspace?: false;
}

/** A desktop; its Electron profile root is available at handle.profileDir. */
export interface App extends DesktopHandle {
  workspaceId: string;
  /** Live-state launches may have no selected workspace; snapshots preserve that as null. */
  snapshotWorkspaceId?: string | null;
}

/** A published desktop with an isolated empty profile; no bootstrap, workspace, activation, or sign-in is seeded. */
export async function blankReleaseApp(options: {
  place: Place;
  release: DesktopRelease;
  startupTimeoutMs?: number;
}): Promise<RetainedDesktopHandle> {
  const host = options.place.host();
  if (!host) throw new Error("Published desktop previews require a host.");
  const electronStep = steps.step("electron-release-blank", "Electron (published blank release)");
  try {
    const stage = process.env.HARNESS_WORLD_STAGE?.trim();
    const surface = await retainedDesktop({
      name: `release-${options.release.distribution}-${options.release.version}${stage ? `-${stage}` : ""}`,
      host,
      release: options.release,
      ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
    });
    await electronStep.note(`startup ${surface.startup.state}`);
    await electronStep.note(`log ${surface.handle.meta?.log}`);
    await electronStep.ok(surface.startup.state);
    return surface;
  } catch (error) {
    await electronStep.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


async function mirrorInstalledProductionRendererState(target: Surface): Promise<AppReadiness> {
  const cdpUrl = process.env.HARNESS_EVAL_INSTALLED_PRODUCTION_CDP_URL?.trim() || "http://127.0.0.1:9223";
  await using source = await attachSurface({
    name: "installed-production-source",
    kind: "electron",
    hostKind: "local",
    cdpUrl,
  });
  const raw = await evaluateOnSurface(source, () => (({
    route: location.hash,
    entries: Object.entries(localStorage).filter(([key]) => key.startsWith("harness.")),
  })));
  if (!isRecord(raw) || typeof raw.route !== "string" || !Array.isArray(raw.entries)) {
    throw new Error(`Installed production desktop at ${cdpUrl} returned invalid renderer state.`);
  }
  const entries: [string, string][] = [];
  for (const entry of raw.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new Error(`Installed production desktop at ${cdpUrl} returned an invalid localStorage entry.`);
    }
    entries.push([entry[0], entry[1]]);
  }
  try {
    await evaluateOnSurface(target, browserScript((inputValue) => {
      const state = inputValue;
      for (const [key, value] of state.entries) localStorage.setItem(key, value);
      location.hash = state.route;
      location.reload();
      return true;
    }, [{ route: raw.route, entries }]));
  } catch {
    // The CDP evaluator includes expression prefixes in timeout errors. Never
    // propagate the expression because it contains production localStorage.
    throw new Error("Dev desktop could not adopt installed production renderer state.");
  }

  const deadline = Date.now() + 60_000;
  let lastRoute = "";
  while (Date.now() < deadline) {
    try {
      const probe = await probeAppStateOnSurface(target, { timeoutMs: 5_000 });
      lastRoute = probe.route;
      if (isInteractive(probe) && probe.surface && !probe.route.endsWith("/signin")) {
        return { state: probe.surface, workspaceId: probe.workspaceId, route: probe.route };
      }
    } catch {
      // Reload briefly destroys the renderer execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Dev desktop did not adopt installed production renderer state within 60 seconds; last route ${JSON.stringify(lastRoute)}.`);
}

export async function liveSharedProductionApp(options: {
  host: Host;
  name: string;
  state: InstalledProductionDesktopState;
}): Promise<App> {
  const surface = await desktop({
    name: options.name,
    host: options.host,
    devCommand: "dev",
    prepareSharedResources: false,
    env: liveSharedProductionStateEnv(options.state),
  });
  try {
    const readiness = await mirrorInstalledProductionRendererState(surface);
    const selectedWorkspaceId = readiness.workspaceId;
    return {
      handle: surface.handle,
      client: surface.client,
      readiness,
      workspaceRoot: surface.workspaceRoot,
      workspaceId: selectedWorkspaceId === null ? "" : selectedWorkspaceId,
      snapshotWorkspaceId: selectedWorkspaceId,
      stop: () => surface.stop(),
      [Symbol.asyncDispose]: () => surface[Symbol.asyncDispose](),
    };
  } catch (error) {
    await surface[Symbol.asyncDispose]();
    throw error;
  }
}

export async function app(options: AppOptions): Promise<App> {
  const env: Record<string, string> = { ...options.env };
  if (options.model) env.HARNESS_EVAL_MODEL = options.model;
  if (options.localServerDelayMs !== undefined) {
    env.HARNESS_EVAL_LOCAL_SERVER_DELAY_MS = String(options.localServerDelayMs);
  }
  const electronStep = steps.step("electron-fresh", "Electron (fresh)");
  let surface: Awaited<ReturnType<typeof desktop>>;
  try {
    surface = await desktop({
      name: "testkit-fresh",
      host: options.host ?? options.place.host(),
      profileDir: options.profileDir,
      env: Object.keys(env).length > 0 ? env : undefined,
    });
  } catch (error) {
    await electronStep.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
  await electronStep.note(`log ${surface.handle.meta?.log}`);
  await electronStep.ok(surface.handle.cdpUrl);
  if (surface.handle.pid !== undefined) {
    await trackResource({ kind: "process", id: String(surface.handle.pid), label: "electron", match: process.env.HARNESS_EVAL_ELECTRON_BINARY?.trim() || "dev:electron" });
  }
  if (surface.handle.meta?.profileOwner !== "caller" && typeof surface.handle.profileDir === "string") {
    await trackResource({ kind: "tmpdir", id: surface.handle.profileDir, label: "electron-profile" });
  }
  let workspaceId = "";
  try {
    if (options.workspace !== false) {
      const path = options.workspacePath ?? `/tmp/harness-fresh-${Date.now()}`;
      const workspaceStep = steps.step("workspace-fresh", "Create workspace");
      ({ workspaceId } = await createAndSelectWorkspace(surface, { path }));
      await workspaceStep.ok(workspaceId);
    }
  } catch (error) {
    await surface[Symbol.asyncDispose]();
    throw error;
  }
  return {
    handle: surface.handle,
    client: surface.client,
    readiness: surface.readiness,
    workspaceRoot: surface.workspaceRoot,
    workspaceId,
    stop: () => surface.stop(),
    [Symbol.asyncDispose]: () => surface[Symbol.asyncDispose](),
  };
}
