/** CI supplies an explicitly selected real OpenAI provider. Credentials never
 * become fixture evidence, and credentials alone never opt into inference. */
export async function configuredLiveProvider() {
  if (process.env.HARNESS_LIVE_PROVIDER !== "OpenAI") return null;
  const keyName = process.env.HARNESS_LIVE_KEY_ENV;
  const key = keyName ? process.env[keyName]?.trim() : undefined;
  const ids = (process.env.HARNESS_LIVE_MODELS ?? process.env.HARNESS_LIVE_MODEL)?.split(",").map(id => id.trim()).filter(Boolean);
  if (!key || !ids?.length) throw new Error("Live OpenAI requires a credential and HARNESS_LIVE_MODELS; no mock fallback is allowed");
  return { key, baseURL: "https://api.openai.com/v1", models: ids.map((id, index) => ({ id, config: {
    id, name: `Live model ${index === 0 ? "one" : "two"}`, tool_call: true,
    limit: { context: 128_000, output: 16_384 },
  } })) };
}
