export const liveOpenAiEnabled = () => process.env.HARNESS_EVAL_LIVE_OPENAI === "1";
export const liveOpenAiModel = () => process.env.HARNESS_EVAL_OPENAI_MODEL?.trim() || "gpt-5.4";

export function assertNoLiveSecret(value: unknown): void {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key && JSON.stringify(value)?.includes(key)) throw new Error("Live credential appeared in a public response (value suppressed)");
}

type Request = (path: string, method?: string, body?: unknown) => Promise<{status: number; json: unknown}>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);


/** Observe a fresh completed assistant response, never match historical text. */
export async function liveV2Turn(request: Request, v2: string, sessionId: string, prompt: string) {
  const path = `${v2}/api/session/${sessionId}`;
  const before = (await request(`${path}/message`)).json;
  const oldIds = new Set(record(before) && Array.isArray(before.data) ? before.data.filter(record).map((message) => message.id) : []);
  const sinceIso = new Date().toISOString();
  if ((await request(`${path}/prompt`, "POST", { text: prompt })).status !== 200) throw new Error("Live v2 prompt was not admitted");
  const deadline = Date.now() + 120_000;
  do {
    const permissions = (await request(`${path}/permission`)).json;
    if (record(permissions) && Array.isArray(permissions.data)) for (const permission of permissions.data) {
      if (record(permission) && typeof permission.id === "string") {
        const relevant = permission.action === "skill" || permission.action === "reload-witness_read_report"
          || permission.action === "harness-cloud_search_capabilities";
        const allowed = await request(`${path}/permission/${permission.id}/reply`, "POST", { reply: relevant ? "once" : "reject" });
        if (![200, 204].includes(allowed.status)) throw new Error("Live tool permission could not be approved");
      }
    }
    const result = (await request(`${path}/message`)).json;
    assertNoLiveSecret(result);
    const messages = record(result) && Array.isArray(result.data) ? result.data.filter(record).filter((message) => message.type === "assistant" && !oldIds.has(message.id)) : [];
    if (messages.length > 16) {
      await request(`${path}/interrupt`, "POST", {});
      throw new Error("Live model exceeded the bounded tool-call budget");
    }
    if (messages.some((message) => message.error || message.finish === "error")) throw new Error("Live model request failed (inspect redacted engine status)");
    const completed = messages.find((message) => record(message.time) && typeof message.time.completed === "number" && message.finish === "stop");
    if (completed) {
      if (!record(completed.model) || completed.model.id !== liveOpenAiModel()
        || !record(completed.tokens) || typeof completed.tokens.output !== "number" || completed.tokens.output <= 0) {
        throw new Error("Live response did not report the requested model and generated tokens");
      }
      const text = Array.isArray(completed.content) ? completed.content.filter(record).filter((part) => part.type === "text").map((part) => part.text).join("\n") : "";
      if (!text) throw new Error("Live model returned no final text");
      return { text, messages: JSON.stringify(messages), sinceIso };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error("Live model did not finish within 120 seconds");
}
