// Applications Harness may offer for "Open with", and the check that a
// requested one is really among them. The renderer picks from the list, but
// the launch request carries only a path, so the main process re-derives the
// list and refuses anything that is not on it: a renderer that has been
// tricked must not be able to start an arbitrary program.

import path from "node:path";

/**
 * @typedef {{ name: string; appPath: string; icon: string | null }} OpenWithApp
 * @typedef {{
 *   platform: NodeJS.Platform;
 *   homedir: string;
 *   readdir: (dir: string) => Promise<string[]>;
 *   readFile: (file: string, encoding: "utf-8") => Promise<string>;
 *   getFileIcon?: (file: string) => Promise<{ isEmpty(): boolean; toDataURL(): string }>;
 * }} OpenWithDeps
 */

/** @param {OpenWithDeps} deps @param {string} file */
async function iconFor(deps, file) {
  if (!deps.getFileIcon) return null;
  try {
    const image = await deps.getFileIcon(file);
    return image.isEmpty() ? null : image.toDataURL();
  } catch {
    return null;
  }
}

/**
 * @param {OpenWithDeps} deps
 * @returns {Promise<OpenWithApp[]>}
 */
export async function discoverOpenWithApps(deps) {
  const results = [];
  try {
    if (deps.platform === "darwin") {
      const appDirs = ["/Applications", "/System/Applications", "/Applications/Utilities", `${deps.homedir}/Applications`];
      const seen = new Set();
      for (const dir of appDirs) {
        let entries;
        try { entries = await deps.readdir(dir); } catch { continue; }
        for (const entry of entries) {
          if (!entry.endsWith(".app")) continue;
          const appPath = path.join(dir, entry);
          if (seen.has(appPath)) continue;
          seen.add(appPath);
          results.push({ name: entry.replace(/\.app$/i, ""), appPath, icon: await iconFor(deps, appPath) });
        }
      }
    } else if (deps.platform === "linux") {
      const desktopDirs = ["/usr/share/applications", "/usr/local/share/applications", `${deps.homedir}/.local/share/applications`];
      const seen = new Set();
      for (const dir of desktopDirs) {
        let entries;
        try { entries = await deps.readdir(dir); } catch { continue; }
        for (const entry of entries) {
          if (!entry.endsWith(".desktop")) continue;
          const filePath = path.join(dir, entry);
          if (seen.has(filePath)) continue;
          seen.add(filePath);
          try {
            const content = await deps.readFile(filePath, "utf-8");
            const nameMatch = content.match(/^Name=(.+)$/m);
            const execMatch = content.match(/^Exec=(.+)$/m);
            if (!nameMatch || !execMatch) continue;
            const appPath = execMatch[1].trim().replace(/%[fFuU]/g, "").trim();
            if (!appPath) continue;
            results.push({ name: nameMatch[1].trim(), appPath, icon: await iconFor(deps, filePath) });
          } catch {
            // an unreadable entry is simply not offered
          }
        }
      }
    }
  } catch {
    // whatever was found before the failure is still valid
  }
  return results;
}

/**
 * @param {string} appPath
 * @param {Omit<OpenWithDeps, "getFileIcon">} deps
 */
export async function isDiscoveredOpenWithApp(appPath, deps) {
  const requested = String(appPath ?? "").trim();
  if (!requested) return false;
  const apps = await discoverOpenWithApps({ ...deps, getFileIcon: undefined });
  return apps.some((candidate) => candidate.appPath === requested);
}
