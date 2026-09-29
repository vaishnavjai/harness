// The engine holds provider API keys in its in-memory config, so its config
// and provider listings contain them. Harness's own routes must never hand
// those back to a client, an agent or a script: the keys live encrypted in the
// vault precisely so that nothing can read them out in plaintext.

export const REDACTED = "[redacted]";

/** Engine reads whose JSON can carry provider credentials. */
const CREDENTIAL_BEARING_PATHS = new Set(["/config", "/config/providers", "/provider", "/global/config"]);

const SECRET_FIELD_NAME = /^(api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password)$/i;

/** Short strings would match innocent text; real keys are longer than this. */
const MIN_SECRET_LENGTH = 8;

export function proxyPathCarriesCredentials(method: string, normalizedPath: string): boolean {
  const verb = method.toUpperCase();
  return (verb === "GET" || verb === "HEAD") && CREDENTIAL_BEARING_PATHS.has(normalizedPath);
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
