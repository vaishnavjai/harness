import { expect, test } from "bun:test";

import { HARNESS_AGENT_PROMPT, HARNESS_CONNECT_ROUTING_INSTRUCTION } from "../harness-agent-prompt.js";
import { buildHarnessV2Instructions } from "../opencode-v2-instructions.js";
import { HarnessCapabilitiesKnowledge } from "./harness-capabilities-knowledge.js";
import { HarnessExtensionsPreview } from "./harness-extensions-preview.js";
import {
  HARNESS_CLOUD_CONNECTION_INSTRUCTION,
  HARNESS_EXTENSION_DISCOVERY_INSTRUCTION,
  HARNESS_ON_DEMAND_DISCOVERY_INSTRUCTION,
  HARNESS_GOOGLE_CONNECTION_INSTRUCTION,
} from "./harness-extensions-preview-steering.js";
import { HarnessSpreadsheets } from "./harness-spreadsheets.js";

test.each(["v1", "v2-connected", "v2-disconnected"])("%s gates native connection questions on the current host contract", async (engine) => {
  const prompt = engine === "v1"
    ? (await composePrompt())[0]
    : buildHarnessV2Instructions(engine === "v2-connected").operatingInstructions;
  for (const instruction of [
    "actually blocked on member OAuth",
    "explicitly requests connect/reconnect (never incidental discovery)",
    "call harness_context",
    "root.context",
    "context.features.connectionQuestions === true",
    "native question tool is available",
    "startup fallback snapshots",
    "already verified, unambiguous connection identity",
    "never invent connection IDs",
    'header exactly "Connection"',
    'question exactly "Connect <connectionName> to continue?"',
    '"label":"Authenticate"',
    '"label":"Skip"',
    "multiple: false, custom: false",
    "The native question waits",
    "Authenticate answer only AFTER OAuth confirms",
    "without replaying completed writes",
    "On Skip, continue without that connection",
    "do not substitute authentication, use a workaround, or automatically reconnect",
    "Never abort then send a follow-up",
    "keep the existing manual Connect/Reconnect card response",
    "Do not emit a normal question claiming authentication completed",
  ]) expect(prompt).toContain(instruction);
  expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).not.toContain("connectionQuestions");
  expect(HARNESS_GOOGLE_CONNECTION_INSTRUCTION).not.toContain("connectionQuestions");
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function composePrompt(status = "connected"): Promise<string[]> {
  const engineMcp = {
    async status() {
      return { data: { "harness-cloud": { status } } };
    },
  };
  const extensions = await HarnessExtensionsPreview({ client: { mcp: engineMcp }, directory: "/tmp/spec" });
  const knowledge = await HarnessCapabilitiesKnowledge();
  const output: { system: string[] } = { system: [HARNESS_AGENT_PROMPT] };
  await knowledge["experimental.chat.system.transform"]({}, output);
  await extensions["experimental.chat.system.transform"]({}, output);
  return output.system;
}

test("the composed Harness prompt is single, deduplicated, ordered, and current", async () => {
  const system = await composePrompt();

  expect(system).toHaveLength(1);
  const prompt = system[0];
  expect(prompt.startsWith("You are Harness.")).toBe(true);
  expect(prompt).toContain("\n\nYou are running inside Harness.");
  expect(prompt).toContain("\n\n## Harness app context");
  expect(prompt).toContain("\n\n## Built-in Browser (external websites)");
  expect(prompt).toContain(`\n\n${HARNESS_EXTENSION_DISCOVERY_INSTRUCTION}`);

  expect(prompt).not.toContain("Memory Bank");
  expect(prompt).not.toContain("postMemory");
  expect(prompt).not.toContain("getMemorySearch");
  expect(prompt).not.toContain("deleteMemoryById");
  expect(prompt).not.toContain("packages/docs/");
  expect(prompt).toContain("read cloud/run-in-the-cloud/cloud-mcp.mdx with harness_docs_read");
  expect(prompt).toContain("read cloud/share-with-your-team/desktop-policies.mdx");

  expect(occurrences(prompt, HARNESS_CONNECT_ROUTING_INSTRUCTION)).toBe(1);
  expect(occurrences(HARNESS_AGENT_PROMPT, "harness-cloud_search_capabilities")).toBe(1);
  expect(prompt).not.toContain("2-4 keyword variants");
  expect(prompt).not.toContain("A successful search proves");
  expect(occurrences(prompt, HARNESS_EXTENSION_DISCOVERY_INSTRUCTION)).toBe(1);
  expect(prompt).not.toContain("require the user to sign in to Harness first");
  expect(occurrences(prompt, HARNESS_ON_DEMAND_DISCOVERY_INSTRUCTION)).toBe(1);
  expect(prompt).not.toContain("retrieve the listed remote `create-skill` skill");
  expect(prompt).not.toContain("factor them into a skill");
  expect(occurrences(prompt, "never browser_* tools for the Harness app itself")).toBe(1);
  expect(prompt).not.toContain("NOT browser tools");
  expect(prompt).not.toContain("Never use browser_* tools on the Harness app itself");
  expect(occurrences(prompt, "session.search then session.read")).toBe(1);
  expect(prompt).not.toContain("open the matching session");
  expect(occurrences(prompt, "as the first source of truth")).toBe(1);
  expect(prompt).not.toContain("Important docs to know");
  expect(prompt).not.toContain("from an actual capability call");

  const knowledgeAt = prompt.indexOf("You are running inside Harness.");
  const appContextAt = prompt.indexOf("## Harness app context");
  const browserAt = prompt.indexOf("## Built-in Browser (external websites)");
  const steeringAt = prompt.indexOf(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
  const skillAuthoringAt = prompt.indexOf(HARNESS_ON_DEMAND_DISCOVERY_INSTRUCTION);
  expect(knowledgeAt).toBeGreaterThan(0);
  expect(appContextAt).toBeGreaterThan(knowledgeAt);
  expect(browserAt).toBeGreaterThan(appContextAt);
  expect(steeringAt).toBeGreaterThan(browserAt);
  expect(skillAuthoringAt).toBeGreaterThan(steeringAt);
});

test.each(["connected", "disabled", "needs_auth", "failed"])("the %s prompt retains shared Google guidance and Drive host discovery exactly once", async (status) => {
  const system = await composePrompt(status);
  expect(system).toHaveLength(1);
  expect(occurrences(system[0], HARNESS_GOOGLE_CONNECTION_INSTRUCTION)).toBe(1);
  expect(occurrences(system[0], "only if gmail_create_draft_with_attachments is returned and the user authorizes draft creation")).toBe(1);
  expect(system[0]).not.toContain("google-workspace");
  expect(system[0]).not.toContain("legacyConfigured");
  expect(occurrences(system[0], "Cloud search results alone do not establish that upload is unavailable")).toBe(1);
  expect(occurrences(system[0], "first query extension.actions with extensionId harness-cloud-uploads")).toBe(1);
  expect(occurrences(system[0], "Only if drive_upload_file is returned and the user authorizes the upload")).toBe(1);
});

test("all Harness prompt hooks retain one ordered system message", async () => {
  const engineMcp = {
    async status() {
      return { data: { "harness-cloud": { status: "connected" } } };
    },
  };
  const extensions = await HarnessExtensionsPreview({ client: { mcp: engineMcp }, directory: "/tmp/spec" });
  const knowledge = await HarnessCapabilitiesKnowledge();
  const spreadsheets = await HarnessSpreadsheets({ directory: "/tmp/spec" });
  const output: { system: string[] } = { system: ["engine header"] };

  await knowledge["experimental.chat.system.transform"]({}, output);
  await extensions["experimental.chat.system.transform"]({}, output);
  await spreadsheets["experimental.chat.system.transform"]({}, output);

  expect(output.system).toHaveLength(1);
  expect(output.system[0].startsWith("engine header\n\n")).toBe(true);
  const capabilities = output.system[0].indexOf("You are running inside Harness.");
  const appContext = output.system[0].indexOf("## Harness app context");
  const browser = output.system[0].indexOf("## Built-in Browser (external websites)");
  const routing = output.system[0].indexOf(HARNESS_ON_DEMAND_DISCOVERY_INSTRUCTION);
  const workbooks = output.system[0].indexOf("## Spreadsheets and Excel workbooks");
  expect(capabilities).toBeGreaterThan("engine header".length);
  expect(appContext).toBeGreaterThan(capabilities);
  expect(browser).toBeGreaterThan(appContext);
  expect(routing).toBeGreaterThan(browser);
  expect(workbooks).toBeGreaterThan(routing);
  expect(output.system[0].match(/## Spreadsheets and Excel workbooks/g)).toHaveLength(1);

  const empty: { system: string[] } = { system: [] };
  await knowledge["experimental.chat.system.transform"]({}, empty);
  await extensions["experimental.chat.system.transform"]({}, empty);
  await spreadsheets["experimental.chat.system.transform"]({}, empty);
  expect(empty.system).toHaveLength(1);
  expect(empty.system[0].startsWith("\n")).toBe(false);
});
