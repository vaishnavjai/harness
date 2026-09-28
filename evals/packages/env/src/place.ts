import { provisionDesktopSandbox, provisionWebSandbox, deleteSandboxes, daytonaSandbox } from "@harness/hosts";
import { daytonaPlacement, resolveEvalRef } from "./eval-ref.ts";
import { targetFromEnv } from "@harness/world";
import type {
  ChromeSurfaceOptions,
  DesktopSandbox,
  ElectronSurfaceOptions,
  Host,
  RetainedElectronSurface,
  SurfaceHandle,
} from "@harness/hosts";

/** One placement decision shared by every resource in a test. */
export interface Place {
  kind: "local" | "daytona";
  host(): Host | undefined;
  exposeMock(handle: { url: string }): Promise<URL>;
  /** The repository ref a remote placement checks out; undefined for local runs. */
  sourceRef(): string | undefined;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class LocalPlace implements Place {
  readonly kind = "local";

  host(): undefined {
    return undefined;
  }

  sourceRef(): undefined {
    return undefined;
  }

  async exposeMock(handle: { url: string }): Promise<URL> {
    return new URL(handle.url);
  }
}

interface PlacedSurface {
  host: Host;
  sandbox: string;
  created: boolean;
  release?: Awaited<ReturnType<typeof provisionDesktopSandbox>>["release"];
}

/** Provisions one isolated sandbox for each app surface, only when it is used. */
class DaytonaPlacementHost implements Host {
  readonly kind = "daytona";
  readonly workspaceRoot = "/workspace";
  readonly #ref: string;
  readonly #preparedSandbox: string | undefined;
  readonly #preparedHost: Host | undefined;
  readonly #surfaces = new Map<SurfaceHandle, PlacedSurface>();

  constructor(ref: string, preparedSandbox?: string) {
    this.#ref = ref;
    this.#preparedSandbox = preparedSandbox;
    this.#preparedHost = preparedSandbox ? daytonaSandbox(preparedSandbox) : undefined;
  }

  async #provision(name: string, surface: "desktop" | "web", options?: ElectronSurfaceOptions): Promise<PlacedSurface> {
    // The pooled lane prepares one desktop sandbox per worker; surfaces share
    // it unless a spec asks for its own (two desktops on two sandboxes).
    if (this.#preparedSandbox && this.#preparedHost && !options?.ownSandbox) {
      if (options?.release) throw new Error("Published release previews require a newly owned Daytona sandbox.");
      return {
        host: this.#preparedHost,
        sandbox: this.#preparedSandbox,
        created: false,
      };
    }
    const provisionOptions = {
      ref: this.#ref,
      name,
      ...(process.env.HARNESS_WORLD_PREVIEW_DAYTONA === "1" ? { autoStopMinutes: 0 } : {}),
      log: (line: string) => console.error(`[harness/testkit] ${line}`),
    };
    const provisioned: DesktopSandbox = surface === "web"
      ? await provisionWebSandbox(provisionOptions)
      : await provisionDesktopSandbox({ ...provisionOptions, ...(options?.release ? { release: options.release } : {}) });
    return {
      host: daytonaSandbox(provisioned.sandbox),
      sandbox: provisioned.sandbox,
      created: provisioned.created,
      ...(provisioned.release ? { release: provisioned.release } : {}),
    };
  }

  async spawnElectron(name: string, options?: ElectronSurfaceOptions): Promise<SurfaceHandle> {
    const placed = await this.#provision(name, "desktop", options);
    try {
      const handle = await placed.host.spawnElectron(name, {
        ...options,
        ...(placed.release ? { binaryPath: placed.release.binaryPath } : {}),
      });
      if (placed.release) {
        handle.meta = {
          ...handle.meta,
          releaseArchive: placed.release.archivePath,
          releaseAsset: placed.release.assetName,
          releaseBinary: placed.release.binaryPath,
          releaseDigest: placed.release.digest,
          releaseDistribution: placed.release.distribution,
          releaseInstallRoot: placed.release.installRoot,
          releaseManifest: placed.release.manifestPath,
          releaseVersion: placed.release.version,
        };
      }
      this.#surfaces.set(handle, placed);
      return handle;
    } catch (error) {
      if (placed.created) {
        await deleteSandboxes([placed.sandbox]).catch((cleanupError: unknown) => {
          console.error(`[harness/testkit] Daytona cleanup failed: ${messageText(cleanupError)}`);
        });
      }
      throw error;
    }
  }

  async spawnElectronRetained(name: string, options?: ElectronSurfaceOptions): Promise<RetainedElectronSurface> {
    const placed = await this.#provision(name, "desktop", options);
    try {
      if (!placed.host.spawnElectronRetained) throw new Error("The selected host cannot retain a failed Electron launch.");
      const surface = await placed.host.spawnElectronRetained(name, {
        ...options,
        ...(placed.release ? { binaryPath: placed.release.binaryPath } : {}),
      });
      if (placed.release) {
        surface.handle.meta = {
          ...surface.handle.meta,
          releaseArchive: placed.release.archivePath,
          releaseAsset: placed.release.assetName,
          releaseBinary: placed.release.binaryPath,
          releaseDigest: placed.release.digest,
          releaseDistribution: placed.release.distribution,
          releaseInstallRoot: placed.release.installRoot,
          releaseManifest: placed.release.manifestPath,
          releaseVersion: placed.release.version,
        };
      }
      this.#surfaces.set(surface.handle, placed);
      return surface;
    } catch (error) {
      if (placed.created) {
        await deleteSandboxes([placed.sandbox]).catch((cleanupError: unknown) => {
          console.error(`[harness/testkit] Daytona cleanup failed: ${messageText(cleanupError)}`);
        });
      }
      throw error;
    }
  }

  async spawnChrome(name: string, options?: ChromeSurfaceOptions): Promise<SurfaceHandle> {
    const placed = await this.#provision(name, "web");
    try {
      const handle = await placed.host.spawnChrome(name, options);
      this.#surfaces.set(handle, placed);
      return handle;
    } catch (error) {
      if (placed.created) {
        await deleteSandboxes([placed.sandbox]).catch((cleanupError: unknown) => {
          console.error(`[harness/testkit] Daytona cleanup failed: ${messageText(cleanupError)}`);
        });
      }
      throw error;
    }
  }

  async disposeSurface(handle: SurfaceHandle): Promise<void> {
    const placed = this.#surfaces.get(handle);
    if (!placed) return;
    this.#surfaces.delete(handle);
    try {
      await placed.host.disposeSurface(handle);
    } finally {
      if (placed.created) await deleteSandboxes([placed.sandbox]);
    }
  }
}

class DaytonaPlace implements Place {
  readonly kind = "daytona";
  readonly #ref: string;
  readonly #host: Host;

  constructor(ref: string, preparedDesktopSandbox?: string) {
    this.#ref = ref;
    this.#host = new DaytonaPlacementHost(ref, preparedDesktopSandbox);
  }

  host(): Host {
    return this.#host;
  }

  sourceRef(): string {
    return this.#ref;
  }

  async exposeMock(handle: { url: string }): Promise<URL> {
    const url = new URL(handle.url);
    if (["127.0.0.1", "localhost", "0.0.0.0", "::1"].includes(url.hostname)) {
      throw new Error("A loopback mock is unreachable from a remote placement.");
    }
    return url;
  }
}

/** Resolve placement once; resources never inspect placement environment again. */
export function resolvePlace(env: NodeJS.ProcessEnv = process.env): Place {
  // Explicit values must not silently fall through to a local runtime.
  const target = targetFromEnv(env);
  if (target.provider === "freestyle") {
    throw new Error("Freestyle placement supports app-web only; this recipe does not support Freestyle.");
  }
  // The preview recipe provisions a Windows VM for a release desktop separately.
  if (target.provider === "daytona" && target.os === "windows" && env.HARNESS_WORLD_PREVIEW_DAYTONA !== "1") {
    throw new Error("Daytona Windows is available only for the published preview-desktop release recipe.");
  }
  if (daytonaPlacement(env)) {
    return new DaytonaPlace(
      resolveEvalRef(env),
      env.HARNESS_EVAL_DAYTONA_DESKTOP_SANDBOX?.trim(),
    );
  }
  return new LocalPlace();
}
