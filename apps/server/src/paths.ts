import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ApiError } from "./errors.js";

export function assertAbsolute(path: string): void {
  if (!isAbsolute(path)) {
    throw new ApiError(400, "invalid_path", "Path must be absolute");
  }
}

/**
 * The real location a path refers to, even when it does not exist yet: the
 * nearest existing ancestor is resolved through symlinks and the missing tail
 * is appended. A new file under a symlinked directory is therefore judged by
 * where it would actually be written.
 */
async function realLocation(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return path;
    missing.push(basename(current));
    current = parent;
  }
}

export async function resolveWithinRoot(root: string, ...segments: string[]): Promise<string> {
  const resolvedRoot = await realpath(root);
  const candidate = resolve(resolvedRoot, ...segments);
  const resolvedCandidate = await realLocation(candidate);
  if (resolvedCandidate === resolvedRoot) return candidate;
  if (!resolvedCandidate.startsWith(resolvedRoot + sep)) {
    throw new ApiError(400, "path_escape", "Path escapes workspace root");
  }
  return candidate;
}
