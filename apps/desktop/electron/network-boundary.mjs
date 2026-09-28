/**
 * Network boundary for the Harness app window.
 *
 * The app window may talk to loopback services freely. It never loads passive
 * remote content (images, fonts, scripts, stylesheets, frames, media, beacons):
 * a remote image in agent output or a web font would otherwise tell a third
 * party that Harness is open and what it is showing. Requests the app makes on
 * purpose (a user-configured remote workspace, a provider the person set up)
 * are allowed, and each new destination is written to the audit log once per
 * launch so the person can see every host Harness contacted.
 *
 * The embedded browser panel uses its own session and is not covered here.
 */

/** Resource types the app window never fetches from a remote host. */
export const PASSIVE_REMOTE_RESOURCE_TYPES = new Set([
  "image",
  "media",
  "font",
  "stylesheet",
  "script",
  "subFrame",
  "object",
  "ping",
  "cspReport",
]);

const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

/** @param {string} hostname */
export function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * @param {string} rawUrl
 * @returns {{ network: false } | { network: true, host: string, path: string, loopback: boolean }}
 */
export function describeDestination(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { network: false };
  }
  if (!NETWORK_SCHEMES.has(url.protocol)) return { network: false };
  // The path, never the query string: queries can carry tokens.
  return { network: true, host: url.host.toLowerCase(), path: url.pathname, loopback: isLoopbackHostname(url.hostname) };
}

/**
 * Decide one request from the app window.
 * @param {{ url: string, resourceType: string }} request
 * @returns {{ allow: true, egressHost: string | null, egressPath: string | null } | { allow: false, host: string }}
 */
export function classifyAppWindowRequest({ url, resourceType }) {
  const destination = describeDestination(url);
  if (!destination.network || destination.loopback) return { allow: true, egressHost: null, egressPath: null };
  if (PASSIVE_REMOTE_RESOURCE_TYPES.has(resourceType)) return { allow: false, host: destination.host };
  return { allow: true, egressHost: destination.host, egressPath: destination.path };
}

/**
 * Records each remote host once per launch, and each blocked host and
 * resource type once per launch, so a polling client cannot flood the log.
 * @param {{ event: (kind: string, detail: Record<string, string | number | boolean | null>) => void }} audit
 */
export function createEgressRecorder(audit) {
  const seen = new Set();
  const once = (key, record) => {
    if (seen.has(key)) return;
    seen.add(key);
    record();
  };
  return {
    /** @param {string} host @param {string} via @param {string | null} [path] first path requested */
    egress(host, via, path = null) {
      once(`egress:${host}`, () => audit.event("network.egress", { host, via, path }));
    },
    /** @param {string} host @param {string} resourceType */
    blocked(host, resourceType) {
      once(`blocked:${host}:${resourceType}`, () => audit.event("network.blocked", { host, resourceType }));
    },
  };
}

/**
 * Install the boundary on the session the app window uses. Requests from
 * other web contents in the same session (none today) and from the main
 * process pass through; the main process records its own egress.
 * @param {{
 *   session: { webRequest: { onBeforeRequest: (filter: { urls: string[] }, listener: (details: { url: string, resourceType: string, webContentsId?: number }, callback: (response: { cancel: boolean }) => void) => void) => void } },
 *   isAppWebContents: (webContentsId: number | undefined) => boolean,
 *   recorder: ReturnType<typeof createEgressRecorder>,
 * }} options
 */
export function installAppWindowNetworkBoundary({ session, isAppWebContents, recorder }) {
  session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (!isAppWebContents(details.webContentsId)) {
      callback({ cancel: false });
      return;
    }
    const decision = classifyAppWindowRequest(details);
    if ("host" in decision) {
      recorder.blocked(decision.host, details.resourceType);
      callback({ cancel: true });
      return;
    }
    if (decision.egressHost) recorder.egress(decision.egressHost, "app-window", decision.egressPath);
    callback({ cancel: false });
  });
}
