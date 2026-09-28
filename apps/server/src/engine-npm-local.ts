import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { exists } from "./utils.js";

/**
 * OpenCode installs `@opencode-ai/plugin` from the npm registry into every
 * config folder it loads (its global config folder and each workspace's
 * `.opencode`), in the background and with no switch to turn it off. Its
 * installer reads that folder's `.npmrc`, so `offline=true` there keeps the
 * install on the machine. Harness's own plugins do not need the package;
 * npm plugins and `npx` MCP servers the person adds are unaffected.
 */
export const OFFLINE_NPMRC = [
  "# Written by Harness. OpenCode installs @opencode-ai/plugin into each of its",
  "# config folders in the background; \"offline\" keeps that install from",
  "# contacting the npm registry. Delete this file to let OpenCode download it.",
  "offline=true",
  "",
].join("\n");

/** OpenCode's global config folder for an engine environment (xdg-basedir). */
export function engineGlobalConfigDir(env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(configHome, "opencode");
}

/**
 * Write `.npmrc` into a config folder unless one is already there. With
 * `onlyIfUnmanaged`, a folder that already has a package.json (the person set
 * up their own tools there) is left alone. Returns whether a file was written.
 */
export async function keepConfigDirInstallsLocal(
  dir: string,
  options: { onlyIfUnmanaged?: boolean } = {},
): Promise<boolean> {
  const npmrc = join(dir, ".npmrc");
  if (await exists(npmrc)) return false;
  if (options.onlyIfUnmanaged && (await exists(join(dir, "package.json")))) return false;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(npmrc, OFFLINE_NPMRC, { flag: "wx", mode: 0o644 });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EACCES" || code === "EPERM" || code === "EROFS") return false;
    throw error;
  }
}
