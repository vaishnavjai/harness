import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ApiError } from "./errors.js";

export function assertAbsolute(path: string): void {
  if (!isAbsolute(path)) {
    throw new ApiError(400, "invalid_path", "Path must be absolute");
  }
}

const MAX_SYMLINK_HOPS = 40;

/**
 * The real location a path refers to, even when it does not exist yet: the
 * nearest existing ancestor is resolved through symlinks and the missing tail
 * is appended. A new file under a symlinked directory, or a dangling symlink,
 * is therefore judged by where a write would actually land.
 */
export async function realLocation(path: string, hops = 0): Promise<string> {
  if (hops > MAX_SYMLINK_HOPS) throw new ApiError(400, "path_escape", "Too many symbolic links");
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    // realpath fails on a link whose target is missing; follow it by hand.
    const info = await lstat(current).catch(() => null);
    if (info?.isSymbolicLink()) {
      const target = resolve(dirname(current), await readlink(current));
      return realLocation(join(target, ...missing.reverse()), hops + 1);
    }
    const parent = dirname(current);
    if (parent === current) return path;
    missing.push(basename(current));
    current = parent;
  }
}

/** Whether `candidate` really lies inside `root` once every symlink is followed. */
export async function isWithinRealRoot(root: string, candidate: string): Promise<boolean> {
  const realRoot = await realLocation(root);
  const realCandidate = await realLocation(candidate);
  return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
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
