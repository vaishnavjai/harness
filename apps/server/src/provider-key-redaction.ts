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
  for (const segment of current.split("/")) {
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
  if (CREDENTIAL_BEARING_PATHS.has(canonical)) return true;
  const plain = `/${(path ?? "").split(/[?#]/)[0]?.split("/").filter(Boolean).join("/") ?? ""}`;
  return canonical !== plain || /%|\/\/|\/\.\.?(\/|$)/.test((path ?? "").split(/[?#]/)[0] ?? "");
}

function scrubString(value: string, secrets: readonly string[]): string {
  let next = value;
  for (const secret of secrets) {
    if (next.includes(secret)) next = next.split(secret).join(REDACTED);
  }
  return next;
}

/** Redact by field name and by exact value, so a key is caught wherever the engine puts it. */
export function redactSecretsDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return scrubString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item, secrets));
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    result[name] = typeof item === "string" && item && SECRET_FIELD_NAME.test(name) ? REDACTED : redactSecretsDeep(item, secrets);
  }
  return result;
}

/** Returns the response unchanged unless it is a JSON read of a credential-bearing engine path. */
export async function redactProviderSecrets(
  response: Response,
  input: { method: string; normalizedPath: string; loadSecrets: () => Promise<readonly string[]> },
): Promise<Response> {
  if (!proxyPathCarriesCredentials(input.method, input.normalizedPath)) return response;
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return response;
  const text = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  let body = text;
  try {
    const secrets = (await input.loadSecrets()).filter((secret) => secret.length >= MIN_SECRET_LENGTH);
    body = JSON.stringify(redactSecretsDeep(JSON.parse(text), secrets));
  } catch {
    // Unparseable output cannot be inspected, so withhold it rather than risk a key.
    body = JSON.stringify({ error: "response withheld: could not be checked for credentials" });
    return new Response(body, { status: 502, headers: { "Content-Type": "application/json" } });
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
