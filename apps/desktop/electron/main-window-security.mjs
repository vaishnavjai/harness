// Which preload the main window gets, and whether it can run sandboxed.

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The main window runs sandboxed with the bundled CommonJS preload. Only a
 * development checkout that has not built it yet falls back to the ES-module
 * preload without the sandbox; a packaged app never does.
 *
 * @param {{ dirname: string; isPackaged: boolean; exists?: (file: string) => boolean }} input
 * @returns {{ preload: string; sandbox: boolean; warning?: string }}
 */
export function resolveMainWindowSecurity({ dirname, isPackaged, exists = existsSync }) {
  const bundled = path.join(dirname, "preload.cjs");
  if (exists(bundled)) return { preload: bundled, sandbox: true };
  if (isPackaged) {
    throw new Error("This build is missing electron/preload.cjs, the sandboxed preload. Rebuild it with `npm run package`.");
  }
  return {
    preload: path.join(dirname, "preload.mjs"),
    sandbox: false,
    warning: "electron/preload.cjs is not built, so the main window runs WITHOUT the renderer sandbox. Run `node apps/desktop/scripts/build-preload.mjs`.",
  };
}
