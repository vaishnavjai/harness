import { describe, expect, test } from "bun:test";
import { takePendingDeepLinks } from "../src/app/lib/deep-link-bridge";
import { parseChatDeepLink } from "../src/app/lib/harness-links";
import { connectorPrompt, parseConnectorToken, seededConnectorDraft } from "../src/react-app/domains/session/surface/composer/connector-token";
import {
  connectorChatDeepLink,
  connectorChatPrompt,
  POPULAR_CONNECTORS,
} from "../../../ee/apps/den-web/app/(den)/dashboard/_components/connector-catalog";

/**
 * Den's connector "Chat" action and the desktop composer agree on one link
 * shape. This pins both ends: every popular connector's link round-trips into
 * a draft that leads with the connector chip and ends with its Explain prompt.
 */
describe("connector Chat deep link round trip", () => {
  test("every popular connector's Chat link seeds the connector chip plus its Explain prompt", () => {
    expect(POPULAR_CONNECTORS.length).toBeGreaterThan(0);
    for (const connector of POPULAR_CONNECTORS) {
      const href = connectorChatDeepLink({ connector: connector.displayName, prompt: connectorChatPrompt(connector.displayName) });
      const link = parseChatDeepLink(href);
      expect(link, href).not.toBeNull();
      expect(link?.connector).toBe(connector.displayName);
      expect(link?.prompt).toBe(connector.chatPrompt);
      expect(connector.chatPrompt.startsWith("Explain")).toBe(true);

      const draft = seededConnectorDraft({ connector: link?.connector ?? null, prompt: link?.prompt ?? "" });
      const [chip, ...rest] = draft.split("] ");
      expect(parseConnectorToken(`${chip}]`)).toBe(connector.displayName);
      expect(rest.join("] ")).toBe(connector.chatPrompt);
    }
  });

  test("the GitHub chip supports planning without assuming account access", () => {
    const github = parseChatDeepLink(connectorChatDeepLink({ connector: "GitHub", prompt: connectorChatPrompt("GitHub") }));
    const instruction = connectorPrompt(github?.connector ?? "");
    expect(instruction).toContain('"GitHub"');
    expect(instruction).toContain("do not assume it is connected");
    expect(instruction).toContain("Answer planning and general questions without requiring a connection");
    expect(github?.prompt).toBe(connectorChatPrompt("GitHub"));
  });

  test("only harness://chat links seed a chat, and taking them leaves connect and den-auth links queued", () => {
    expect(parseChatDeepLink("https://app.harness.invalid/chat?prompt=hello")).toBeNull();
    expect(parseChatDeepLink("harness://connect?token=abc")).toBeNull();
    expect(parseChatDeepLink("harness://den-auth?grant=abc")).toBeNull();
    expect(parseChatDeepLink("harness://chat")).toBeNull();

    const queue = {
      deepLinks: ["harness://connect?token=abc", "harness://chat?connector=Notion&prompt=Explain", "harness://den-auth?grant=xyz"],
    };
    const bridgeWindow = { __HARNESS__: queue } as unknown as Window;
    expect(takePendingDeepLinks(bridgeWindow, (url: string) => parseChatDeepLink(url) !== null))
      .toEqual(["harness://chat?connector=Notion&prompt=Explain"]);
    expect(queue.deepLinks).toEqual(["harness://connect?token=abc", "harness://den-auth?grant=xyz"]);
  });
});
