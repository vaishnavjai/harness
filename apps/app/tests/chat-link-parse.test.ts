import { describe, expect, test } from "bun:test";
import { parseChatDeepLink } from "../src/app/lib/harness-links";

const PROMPT = "Explain this repo's authentication using code and docs: components, request flow, and how credentials and tokens are handled";

describe("parseChatDeepLink", () => {
  test("parses connector and prompt from production and dev desktop links", () => {
    const params = new URLSearchParams({ connector: "GitHub", prompt: PROMPT });
    const parsed = parseChatDeepLink(`harness://chat?${params}`);
    expect(parsed).toEqual({ prompt: PROMPT, connector: "GitHub", key: `chat:GitHub:${PROMPT}` });
    expect(parseChatDeepLink(`harness-dev://chat?${params}`)?.connector).toBe("GitHub");
    expect(parseChatDeepLink(`harness:///chat?${params}`)?.prompt).toBe(PROMPT);
  });

  test("accepts a prompt without a connector and a connector without a prompt", () => {
    expect(parseChatDeepLink("harness://chat?prompt=Summarize%20my%20week")).toEqual({
      prompt: "Summarize my week",
      connector: null,
      key: "chat::Summarize my week",
    });
    expect(parseChatDeepLink("harness://chat?connector=Notion")?.connector).toBe("Notion");
  });

  test("strips token delimiters from the connector so it cannot break out of its chip", () => {
    expect(parseChatDeepLink("harness://chat?connector=%5BGit%5DHub%0A&prompt=x")?.connector).toBe("GitHub");
  });

  test("does not activate from web URLs, unrelated routes, or empty links", () => {
    expect(parseChatDeepLink(`https://app.harness.invalid/chat?prompt=${encodeURIComponent(PROMPT)}`)).toBeNull();
    expect(parseChatDeepLink("harness://connect?token=abc")).toBeNull();
    expect(parseChatDeepLink("harness://chat")).toBeNull();
    expect(parseChatDeepLink("harness://chat?prompt=%20%20")).toBeNull();
    expect(parseChatDeepLink("not a url")).toBeNull();
  });
});
