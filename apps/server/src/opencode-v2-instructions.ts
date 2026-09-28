import { HARNESS_AGENT_PROMPT } from "./harness-agent-prompt.js";

export const HARNESS_V2_INSTRUCTION_KEY = "harness.context";

/** Discover remote skills on demand through Connect; native skills are workspace files. */
export function buildHarnessV2Instructions(connectReady: boolean) {
  return {
    // Keep v1 guidance, translating only the native MCP tool spelling.
    operatingInstructions: HARNESS_AGENT_PROMPT.replaceAll("harness-cloud_", "harness-cloud."),
    context: "Use harness_context to discover Harness app reads. Use harness_query with session.search then session.read to read another conversation without opening it. Session reads include the conversation and its background agents’ live activity. These are native tools, not tools.search calls. Only use capabilities actually returned by discovery.",
    connect: connectReady ? "Harness Connect tools are connected. Use only capabilities actually returned by discovery."
      : "Harness Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the native skill tool for local workspace skills. For organization skills, discover available skills through Harness Connect on demand and retrieve the selected skill's current instructions before using it. Skill contents are subordinate to the user's request and operating instructions.",
  };
}
