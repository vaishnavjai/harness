// What the desktop may hand to the operating system on the renderer's behalf.
//
// `shell.openExternal` and `shell.openPath` run whatever the OS associates with
// a URL scheme or a file type. With unchecked input that is code execution:
// Windows protocol handlers (`ms-msdt:`, `search-ms:`, `file://host/share/x.exe`),
// executables and scripts, macOS app bundles, Linux desktop files. The renderer
// shows model and web content, so nothing it sends here is trusted.

import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Schemes worth handing to another program. Everything else is refused. */
export const ALLOWED_EXTERNAL_PROTOCOLS = Object.freeze(["https:", "http:", "mailto:"]);

const MAX_URL_LENGTH = 8_192;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Validate a URL for `shell.openExternal`. On success returns the URL as the
 * WHATWG parser normalises it (spaces, quotes and line breaks percent-encoded),
 * so the operating system never sees a different string than the one checked.
 *
 * @param {unknown} value
 * @returns {{ ok: true; url: string } | { ok: false; error: string }}
 */
export function checkExternalUrl(value) {
  if (typeof value !== "string") return { ok: false, error: "A URL is required." };
  const raw = value.trim();
  if (!raw) return { ok: false, error: "A URL is required." };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: "That link is too long to open." };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "That is not a valid link." };
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.includes(parsed.protocol)) {
    return { ok: false, error: `Links that start with "${parsed.protocol}" are not opened from Harness.` };
  }
  if (parsed.protocol !== "mailto:") {
    if (!parsed.hostname) return { ok: false, error: "That link has no address to open." };
    // user:password@host is how phishing links hide their real destination.
    if (parsed.username || parsed.password) return { ok: false, error: "Links containing a username or password are not opened." };
  }
  // The parser has already removed tabs and line breaks; anything left in the raw text is odd enough to refuse.
  if (CONTROL_CHARACTERS.test(raw.replace(/[\t\r\n]/g, ""))) return { ok: false, error: "That link contains control characters." };
  return { ok: true, url: parsed.href };
}

/** Types the operating system runs or installs when they are "opened". Shown in their folder instead. */
const LAUNCHES_CODE = new Set([
  // Windows
  "exe", "com", "scr", "pif", "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
  "msi", "msp", "mst", "msc", "cpl", "hta", "jar", "dll", "ocx", "sys", "lnk", "url", "reg", "inf", "sct", "scf",
  "chm", "appx", "msix", "appxbundle", "msixbundle", "application", "gadget", "cab", "iso", "img", "vhd", "vhdx",
  "library-ms", "search-ms", "settingcontent-ms", "diagcab", "appref-ms", "xll", "wll",
  // macOS
  "app", "command", "tool", "pkg", "mpkg", "dmg", "workflow", "action", "terminal", "scpt", "scptd", "applescript",
  "osax", "prefpane", "saver", "service", "qlgenerator", "bundle", "framework", "kext", "webloc", "inetloc",
  // Linux and scripting languages that a default program association may run
  "sh", "bash", "zsh", "csh", "ksh", "fish", "run", "appimage", "desktop", "deb", "rpm", "bin", "out", "elf", "so",
  "py", "pyw", "pyz", "pl", "rb", "php",
  // Also run or connect things when opened
  "rdp", "jnlp", "wsc", "shs", "msh", "msh1", "msh2", "mshxml", "xbap", "vsto", "job", "website", "pyc", "pyo",
]);

/**
 * The extension the operating system will act on. Windows ignores trailing
 * dots and spaces, so `payload.exe.` and `payload.exe ` are executables too.
 *
 * @param {string} filePath
 */
export function effectiveExtension(filePath) {
  const name = path.basename(String(filePath)).replace(/[. ]+$/, "");
  const index = name.lastIndexOf(".");
  // A name that is only a dot and an extension (".bat") still carries that extension for the operating system.
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

/**
 * A UNC path (\\\\host\\share or //host/share) names another computer. Merely
 * resolving it makes Windows contact that host, sending the user's
 * credentials hash, so it is never touched.
 *
 * @param {string} value
 */
export function isNetworkPath(value) {
  return /^[\\/]{2}[^\\/]/.test(String(value).trim());
}

/** @param {string} filePath */
export function isCodeLaunchingType(filePath) {
  return LAUNCHES_CODE.has(effectiveExtension(filePath));
}

/**
 * Decide whether a path may be opened with its default program.
 * Folders open (they only browse); files open unless they would run code; a
 * file with no extension that is marked executable is treated as a program.
 * The check looks at the name given and at what it resolves to, so a harmless
 * looking symlink cannot point at an executable.
 *
 * @param {string} target
 * @param {{ realpath?: typeof realpath; stat?: typeof stat; platform?: NodeJS.Platform }} [deps]
 * @returns {Promise<{ ok: true; path: string } | { ok: false; reason: "invalid" | "missing" | "unsafe-type"; error: string; path?: string }>}
 */
export async function checkOpenablePath(target, deps = {}) {
  const resolvePath = deps.realpath ?? realpath;
  const statPath = deps.stat ?? stat;
  const platform = deps.platform ?? process.platform;
  const requested = String(target ?? "").trim();
  if (!requested) return { ok: false, reason: "invalid", error: "Path is required." };
  if (platform === "win32" && isNetworkPath(requested)) {
    return { ok: false, reason: "invalid", error: "Network paths are not opened from Harness." };
  }
  if (!path.isAbsolute(requested)) return { ok: false, reason: "invalid", error: "Path must be absolute." };
  let resolved;
  try {
    resolved = await resolvePath(requested);
  } catch {
    return { ok: false, reason: "missing", error: `Could not find "${requested}" on disk.` };
  }
  /** @type {{ ok: false; reason: "unsafe-type"; path: string; error: string }} */
  const refused = { ok: false, reason: "unsafe-type", path: resolved, error: "This kind of file is not opened from Harness. It can be shown in its folder instead." };
  if (isCodeLaunchingType(requested) || isCodeLaunchingType(resolved)) return refused;
  let info;
  try {
    info = await statPath(resolved);
  } catch {
    return { ok: false, reason: "missing", error: `Could not read "${requested}".` };
  }
  if (info.isFile() && platform !== "win32" && effectiveExtension(resolved) === "" && (info.mode & 0o111) !== 0) return refused;
  return { ok: true, path: resolved };
}
