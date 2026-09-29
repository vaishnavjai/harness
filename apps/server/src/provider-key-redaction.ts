// The engine holds provider API keys in its in-memory config, so its config
// and provider listings contain them. Harness's own routes must never hand
// those back to a client, an agent or a script: the keys live encrypted in the
// vault precisely so that nothing can read them out in plaintext.

export const REDACTED = "[redacted]";

/** Engine routes whose JSON can carry provider credentials, whatever the HTTP method. */
const CREDENTIAL_BEARING_PATHS = new Set(["/config", "/config/providers", "/provider", "/global/config"]);

const SECRET_FIELD_NAME = /^(api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password)$/i;

/** Short strings would match innocent text; real keys are longer than this. */
const MIN_SECRET_LENGTH = 8;

/**
 * The path the engine will route: percent-escapes decoded (repeatedly, in case
 * of double encoding), repeated and trailing slashes collapsed, dot segments
 * resolved. Returns null when the path cannot be decoded.
 */
export function canonicalEnginePath(path: string): string | null {
  let current = (path ?? "").split(/[?#]/)[0] ?? "";
  for (let round = 0; round < 4; round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) break;
    current = decoded;
  }
  const parts: string[] = [];
  for (const raw of current.split("/")) {
    // The engine ignores ";parameters" on a segment.
    const segment = raw.split(";")[0] ?? "";
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/**
 * Whether the response to this request must be scrubbed. The engine decodes
 * and normalises the path itself, so matching the raw spelling would miss
 * `/%63onfig` or `//config`. Any path that does not decode to itself is
 * treated as credential-bearing: scrubbing an innocent response costs nothing.
 */
export function proxyPathCarriesCredentials(_method: string, path: string): boolean {
  const canonical = canonicalEnginePath(path);
  if (canonical === null) return true;
  // The engine routes case-insensitively.
  if (CREDENTIAL_BEARING_PATHS.has(canonical.toLowerCase())) return true;
  const plain = `/${(path ?? "").split(/[?#]/)[0]?.split("/").filter(Boolean).join("/") ?? ""}`;
  return canonical !== plain || /%|;|\/\/|\/\.\.?(\/|$)/.test((path ?? "").split(/[?#]/)[0] ?? "");
}

function scrubString(value: string, secrets: readonly string[]): string {
  let next = value;
  for (const secret of secrets) {
    if (next.includes(secret)) next = next.split(secret).join(REDACTED);
  }
  return next;
}

/**
 * Redact by exact value, and (unless told not to) by field name, so a key is
 * caught wherever the engine puts it. Field names are only safe to scrub on
 * routes that are about credentials; elsewhere a "password" field can be data.
 */
export function redactSecretsDeep(value: unknown, secrets: readonly string[], options: { fieldNames?: boolean } = {}): unknown {
  const byName = options.fieldNames !== false;
  if (typeof value === "string") return scrubString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item, secrets, options));
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    result[name] = byName && typeof item === "string" && item && SECRET_FIELD_NAME.test(name) ? REDACTED : redactSecretsDeep(item, secrets, options);
  }
  return result;
}

/** application/json and application/*+json, but not streaming variants such as ndjson. */
const JSON_CONTENT_TYPE = /^application\/(?:[\w.-]+\+)?json\b/i;

function withheld(): Response {
  return new Response(JSON.stringify({ error: "response withheld: could not be checked for credentials" }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Removes stored provider keys from a proxied engine response.
 *
 * Every JSON response is scrubbed by the exact key values, whatever the path:
 * the engine decodes and normalises paths its own way (percent-escapes, case,
 * ";" parameters), so a list of routes is a list of spellings to miss. Routes
 * known to be about credentials are also scrubbed by field name. A response is
 * only buffered when there is something to look for.
 */
export async function redactProviderSecrets(
  response: Response,
  input: { method: string; normalizedPath: string; loadSecrets: () => Promise<readonly string[]> },
): Promise<Response> {
  if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) return response;
  const credentialRoute = proxyPathCarriesCredentials(input.method, input.normalizedPath);
  let secrets: string[] = [];
  try {
    secrets = (await input.loadSecrets()).filter((secret) => secret.length >= MIN_SECRET_LENGTH);
  } catch {
    // An unreadable vault holds no keys to leak; on a credential route the output cannot be vouched for.
    if (credentialRoute) return withheld();
  }
  if (!credentialRoute && secrets.length === 0) return response;
  const text = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const init = { status: response.status, statusText: response.statusText, headers };
  if (!credentialRoute && !secrets.some((secret) => text.includes(secret))) return new Response(text, init);
  try {
    return new Response(JSON.stringify(redactSecretsDeep(JSON.parse(text), secrets, { fieldNames: credentialRoute })), init);
  } catch {
    // Output that cannot be parsed cannot be inspected, so withhold it rather than risk a key.
    return withheld();
  }
}
