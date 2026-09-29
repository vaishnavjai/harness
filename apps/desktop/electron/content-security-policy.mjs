// Content-Security-Policy for the main window, applied by the main process.
//
// The app loads from file://.../app-dist/index.html, which has no server to
// send headers, so the policy is attached to that one document as it loads
// (Electron's webRequest hook fires for file:// too). Nothing in the app's own
// files changes. Inline scripts in index.html are allowed by hash, computed
// from the file that is actually shipped, so an injected script still cannot run.

import { createHash } from "node:crypto";
import { readFile as readFileFromDisk } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @param {string} html */
export function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(match[1])) continue;
    if (!match[2].trim()) continue;
    hashes.add(`'sha256-${createHash("sha256").update(match[2], "utf8").digest("base64")}'`);
  }
  return [...hashes];
}

/**
 * Scripts, plugins, workers, frames, base URL and form targets are locked to the
 * app itself. Styles allow inline (React and Tailwind set style attributes).
 * Images may come from the web (transcripts show remote images) and connections
 * are not yet restricted, because the renderer talks to user-configured model
 * endpoints. Both are recorded as follow-ups in docs/security-checklist.md.
 *
 * @param {{ scriptHashes?: string[] }} [input]
 */
export function buildAppCsp({ scriptHashes = [] } = {}) {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${scriptHashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:*",
    "font-src 'self' data:",
    "media-src 'self' blob: data: http://127.0.0.1:* http://localhost:*",
    "connect-src 'self' blob: data: http: https: ws: wss:",
    "frame-src 'self' blob: data: http://127.0.0.1:* http://localhost:*",
    "object-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

const CSP_HEADER_NAMES = new Set(["content-security-policy", "content-security-policy-report-only"]);

function comparableUrl(value, platform) {
  return platform === "win32" ? value.toLowerCase() : value;
}

/**
 * Attach the policy to the app's own document. `mode: "report-only"` reports
 * violations to the console without blocking, for finding what a policy would
 * break on a machine we cannot test on.
 *
 * @param {{ webRequest: { onHeadersReceived: (listener: (details: any, callback: (response: any) => void) => void) => void } }} session
 * @param {{ indexPath: string; mode?: "enforce" | "report-only"; readFile?: (file: string, encoding: "utf8") => Promise<string>; platform?: NodeJS.Platform }} options
 */
export async function installAppCsp(session, { indexPath, mode = "enforce", readFile = (file, encoding) => readFileFromDisk(file, encoding), platform = process.platform }) {
  const html = await readFile(indexPath, "utf8");
  const policy = buildAppCsp({ scriptHashes: inlineScriptHashes(html) });
  const headerName = mode === "report-only" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
  const appFolder = comparableUrl(pathToFileURL(path.dirname(indexPath) + path.sep).href, platform);
  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders ?? {}) };
    if (details.resourceType === "mainFrame" && comparableUrl(String(details.url), platform).startsWith(appFolder)) {
      for (const name of Object.keys(responseHeaders)) {
        if (CSP_HEADER_NAMES.has(name.toLowerCase())) delete responseHeaders[name];
      }
      responseHeaders[headerName] = [policy];
    }
    callback({ responseHeaders });
  });
  return { policy, headerName };
}
