import { existsSync } from "node:fs";
import { join } from "node:path";

import type { HindsightLaunchCommand } from "./HindsightSupervisor.js";

export const LAUNCHER_SCRIPT_NAME = "harness_hindsight_launcher.py";

export type HindsightRuntimeSource = "override" | "bundled" | "development";

export interface HindsightRuntime {
  source: HindsightRuntimeSource;
  launch: HindsightLaunchCommand;
}

export interface ResolveHindsightRuntimeOptions {
  /**
   * The packaged runtime directory (resources/hindsight-runtime): a
   * relocatable Python with Hindsight installed plus the launcher script.
   */
  bundledRoot?: string;
  /** Repository root, for the development venv and launcher source. */
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Where the relocatable interpreter lives inside a runtime directory. */
export function runtimePythonPath(root: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(root, "python", "python.exe") : join(root, "python", "bin", "python3");
}

/** The development runtime prepared by `node scripts/hindsight/prepare-runtime.mjs --dev`. */
export function developmentRuntimeRoot(repoRoot: string): string {
  return join(repoRoot, ".hindsight-runtime");
}

function sourceLauncher(repoRoot: string | undefined): string | null {
  if (!repoRoot) return null;
  const path = join(repoRoot, "packages", "memory", "python", LAUNCHER_SCRIPT_NAME);
  return existsSync(path) ? path : null;
}

/**
 * Find an interpreter that can run the memory engine without any network
 * access. Returns null when none is installed; memory then stays off rather
 * than falling back to downloading packages at runtime.
 */
export function resolveHindsightRuntime(options: ResolveHindsightRuntimeOptions): HindsightRuntime | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const override = env.HARNESS_HINDSIGHT_PYTHON?.trim();
  if (override) {
    const launcher =
      (options.bundledRoot && existsSync(join(options.bundledRoot, LAUNCHER_SCRIPT_NAME))
        ? join(options.bundledRoot, LAUNCHER_SCRIPT_NAME)
        : null) ?? sourceLauncher(options.repoRoot);
    if (!launcher) return null;
    return { source: "override", launch: { command: override, args: [launcher] } };
  }

  if (options.bundledRoot) {
    const python = runtimePythonPath(options.bundledRoot, platform);
    const launcher = join(options.bundledRoot, LAUNCHER_SCRIPT_NAME);
    if (existsSync(python) && existsSync(launcher)) {
      return { source: "bundled", launch: { command: python, args: [launcher] } };
    }
  }

  if (options.repoRoot) {
    const python = runtimePythonPath(developmentRuntimeRoot(options.repoRoot), platform);
    const launcher = sourceLauncher(options.repoRoot);
    if (existsSync(python) && launcher) {
      return { source: "development", launch: { command: python, args: [launcher] } };
    }
  }
  return null;
}
