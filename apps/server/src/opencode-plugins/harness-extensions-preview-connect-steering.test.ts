import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  composeHarnessExtensionDiscoveryInstruction,
  composeSkillAuthoringInstruction,
  composeSteeringFromEngineMcpStatus,
  HARNESS_CLOUD_CONNECTION_INSTRUCTION,
  HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION,
  HARNESS_CONNECT_DISABLED_INSTRUCTION,
  HARNESS_CONNECT_SIGN_IN_INSTRUCTION,
  HARNESS_EXTENSION_DISCOVERY_INSTRUCTION,
  HARNESS_GOOGLE_CONNECTION_INSTRUCTION,
  HARNESS_LOCAL_SKILL_AUTHORING_INSTRUCTION,
  resetHarnessExtensionDiscoveryInstructionCacheForTests,
  resolveHarnessExtensionDiscoveryInstruction,
  type HarnessEngineMcpStatusClient,
  type HarnessExtensionConnectState,
} from "./harness-extensions-preview-steering.js";

type CloudHealth = NonNullable<HarnessExtensionConnectState["cloudHealth"]>;
type CloudFailure = NonNullable<CloudHealth["firstFailure"]>;

const originalServerUrl = process.env.HARNESS_SERVER_URL;
const originalServerToken = process.env.HARNESS_SERVER_TOKEN;

const EXTENSION_DISCOVERY_PREFIX =
  "If the user asks for something you cannot do with obvious built-in tools, check Harness extensions before saying the capability is unavailable. Use harness_query with id extension.actions to inspect available extension actions, then harness_execute with id extension.call for the matching action. Do not use another route to bypass a failed connection; follow its connection guidance.";

beforeEach(() => {
  resetHarnessExtensionDiscoveryInstructionCacheForTests();
});

afterEach(() => {
  resetHarnessExtensionDiscoveryInstructionCacheForTests();
  if (originalServerUrl === undefined) delete process.env.HARNESS_SERVER_URL;
  else process.env.HARNESS_SERVER_URL = originalServerUrl;
  if (originalServerToken === undefined) delete process.env.HARNESS_SERVER_TOKEN;
  else process.env.HARNESS_SERVER_TOKEN = originalServerToken;
});

function health(overrides: Partial<NonNullable<HarnessExtensionConnectState["cloudHealth"]>> = {}): NonNullable<HarnessExtensionConnectState["cloudHealth"]> {
  return {
    usable: true,
    usableByCurrentModel: true,
    phase: "ready",
    workspace: { id: "ws_1", directory: "/tmp/ws_1" },
    desired: { present: true, revision: "rev_ready" },
    firstFailure: null,
    ...overrides,
  };
}

function failure(code: string, overrides: Partial<CloudFailure> = {}): CloudFailure {
  return {
    code,
    stage: overrides.stage ?? "test",
    recommendedAction: overrides.recommendedAction ?? "Check Settings → Connect.",
    message: overrides.message ?? "test failure",
  };
}

function expectNoDegradedSteering(instruction: string): void {
  expect(instruction).not.toMatch(/not ready/i);
  expect(instruction).not.toContain("Repair and test");
  expect(instruction).not.toContain("Do not use Harness documentation tools");
  expect(instruction).not.toContain("Do not substitute docs");
  expect(instruction).not.toContain("as a substitute for performing an action against a connected service");
  expect(instruction).not.toMatch(/do NOT use (?:tools|Harness Cloud)/i);
  expect(instruction).not.toMatch(/Do not try/);
}

function state(cloudHealth: HarnessExtensionConnectState["cloudHealth"]): HarnessExtensionConnectState {
  return {
    connectEnabled: true,
    connectCatalogEnabled: true,
    cloudMcpPresent: cloudHealth?.usable === true,
    cloudHealth,
    workspace: { resolution: "resolved", id: "ws_1", directory: "/tmp/ws_1" },
  };
}

function engineMcpClient(result: unknown, requests: unknown[] = []): HarnessEngineMcpStatusClient {
  return {
    mcp: {
      status: async (request) => {
        requests.push(request);
        return result;
      },
    },
  };
}

describe("composeSteeringFromEngineMcpStatus", () => {
  test("maps engine MCP statuses to steering instructions", () => {
    expect(composeSteeringFromEngineMcpStatus("connected")).toBe(HARNESS_CLOUD_CONNECTION_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("disabled")).toBe(HARNESS_CONNECT_DISABLED_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("needs_auth")).toBe(HARNESS_CONNECT_SIGN_IN_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("needs_client_registration")).toBe(HARNESS_CONNECT_SIGN_IN_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("failed")).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus("starting")).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeSteeringFromEngineMcpStatus(undefined)).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
  });
});

describe("composeHarnessExtensionDiscoveryInstruction", () => {
  test("retains generic extension discovery when state is unavailable or discovery is gated", () => {
    expect(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION.startsWith(EXTENSION_DISCOVERY_PREFIX)).toBe(true);
    expect(composeHarnessExtensionDiscoveryInstruction(null)).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(composeHarnessExtensionDiscoveryInstruction({ ...state(null), connectCatalogEnabled: false })).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("requires Cloud sign-in when no Cloud health is available", () => {
    expect(composeHarnessExtensionDiscoveryInstruction(state(null))).toBe(HARNESS_CONNECT_SIGN_IN_INSTRUCTION);
  });

  test("steers ready Connect users to verified harness-cloud capabilities first", () => {
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).toContain("verified ready for this exact workspace/model");
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).toContain("Discover the native Gmail draft schema");
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).toContain("host file transport");
    expect(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION).toContain("Do not use another route to bypass a failed connection");
    // Tool mechanics and the "only name what search returns" rule live once in
    // the base agent prompt; ready steering adds shared Google guidance to the signal.
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).not.toContain("harness-cloud_search_capabilities with");
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).not.toContain("available_skills");
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).not.toContain("A successful search proves");
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).not.toContain("Skill creation:");
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).not.toContain("image generation");
    // The detailed Connect contract ships as the harness-cloud server's MCP
    // initialize instructions, present exactly when this steering is chosen.
    // Ready steering defers to it instead of restating it on every request.
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).toContain("server instructions in this prompt are authoritative for search-first discovery, MCP Apps, connection_status results, schema guidance, and retry rules");
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).not.toContain("relay connectionStatus.action exactly");
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION).not.toContain("results are live, not cached");
    expect(HARNESS_CLOUD_CONNECTION_INSTRUCTION.replace(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION, "").length).toBeLessThan(600);
    expect(composeHarnessExtensionDiscoveryInstruction(state(health()))).toBe(HARNESS_CLOUD_CONNECTION_INSTRUCTION);
    expect(composeHarnessExtensionDiscoveryInstruction({ ...state(health()), connectCatalogEnabled: false })).toBe(HARNESS_CLOUD_CONNECTION_INSTRUCTION);
  });

  test("shares Cloud-only Google guidance and host discovery in every readiness mode", () => {
    for (const instruction of [
      HARNESS_CLOUD_CONNECTION_INSTRUCTION,
      HARNESS_EXTENSION_DISCOVERY_INSTRUCTION,
      HARNESS_CONNECT_SIGN_IN_INSTRUCTION,
      HARNESS_CONNECT_DISABLED_INSTRUCTION,
    ]) {
      expect(instruction.split(HARNESS_GOOGLE_CONNECTION_INSTRUCTION)).toHaveLength(2);
      expect(instruction).toContain("Google Workspace uses Harness Cloud Connect only");
      expect(instruction).toContain("Do not set up local Google OAuth, request Google tokens, or offer a legacy Google extension or another provider stack");
      expect(instruction).toContain("Harness Cloud readiness alone does not establish Google connection readiness");
      expect(instruction).toContain("follow the exact live Cloud connection status action returned for that connection");
      expect(instruction).toContain("Never invent a connection status, connection id, or setup action");
      expect(instruction).toContain("if no live status action is available, report that limitation");
      expect(instruction).toContain("Cloud search results alone do not establish that upload is unavailable");
      expect(instruction).toContain("when Harness host tools are exposed, first query extension.actions with extensionId harness-cloud-uploads");
      expect(instruction).toContain("Discover the native Gmail draft schema");
      expect(instruction).toContain("host file transport, preserving the selected connection");
      expect(instruction).toContain("including the selected connectionId");
      expect(instruction).toContain("sending is a separate, permissioned operation");
      expect(instruction).toContain("Do not retry or switch routes after an uncertain result");
      expect(instruction).toContain("Only if drive_upload_file is returned and the user authorizes the upload");
      expect(instruction).toContain("execute that exact action through harness_execute id extension.call with extensionId harness-cloud-uploads and args containing path and optional folderId");
      expect(instruction).toContain("up to 4 MiB under authorized roots");
      expect(instruction).toContain("preserves bytes outside model context");
      expect(instruction).toContain("only if gmail_create_draft_with_attachments is returned and the user authorizes draft creation");
      expect(instruction).toContain("authorized paths and draft fields from its returned input schema");
      expect(instruction).toContain("creates a reviewable draft, does not send email");
      expect(instruction).toContain("up to 10 files totaling 4 MiB");
      expect(instruction).toContain("Cloud backend member connection, not local Google credentials");
      expect(instruction).toContain("Drive uses the member's default Google connection and cannot select another named connection");
      expect(instruction).toContain("unless it is confirmed to be the default");
      expect(instruction).toContain("Never load file bytes into model context or tool arguments, extract tokens, or use shell uploads as a fallback");
      expect(instruction).toContain("If host tools or the action are absent, including in external MCP-only clients, report that limitation");
    }
  });

  test("selects one compact skill-authoring prompt from verified Cloud access", () => {
    expect(composeSkillAuthoringInstruction(HARNESS_CLOUD_CONNECTION_INSTRUCTION)).toEqual({
      mode: "cloud",
      prompt: HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION,
    });
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("Skill creation: Cloud");
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("retrieve and follow the listed create-skill remote skill");
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("harness-cloud_execute_capability");
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("exact <capability>");
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("Harness Cloud as a private plugin");
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("use share-plugin when the user wants a specific person or team to use a skill");
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("add-to-marketplace");
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("add-user-to-marketplace");
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("workspace-local skill");
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).toContain("Do not create both copies");
    expect(HARNESS_CLOUD_SKILL_AUTHORING_INSTRUCTION).not.toContain("Skill creation: Local");

    for (const instruction of [
      HARNESS_EXTENSION_DISCOVERY_INSTRUCTION,
      HARNESS_CONNECT_SIGN_IN_INSTRUCTION,
      HARNESS_CONNECT_DISABLED_INSTRUCTION,
    ]) {
      expect(composeSkillAuthoringInstruction(instruction)).toEqual({
        mode: "local",
        prompt: HARNESS_LOCAL_SKILL_AUTHORING_INSTRUCTION,
      });
    }
    expect(HARNESS_LOCAL_SKILL_AUTHORING_INSTRUCTION).toContain("Skill creation: Local");
    expect(HARNESS_LOCAL_SKILL_AUTHORING_INSTRUCTION).toContain("only when the user requests one");
    expect(HARNESS_LOCAL_SKILL_AUTHORING_INSTRUCTION).toContain(".opencode/skills/<skill-name>/SKILL.md");
    expect(HARNESS_LOCAL_SKILL_AUTHORING_INSTRUCTION).not.toContain("Skill creation: Cloud");
  });

  test("keeps neutral steering when provider projection is missing", () => {
    const instruction = composeHarnessExtensionDiscoveryInstruction(state(health({
      usable: true,
      usableByCurrentModel: false,
      phase: "provider_projection_missing",
      firstFailure: {
        code: "provider_tool_projection_missing",
        stage: "provider_projection",
        recommendedAction: "Update Harness",
        message: "missing",
      },
    })));

    expect(instruction).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("uses neutral, signed-out, and disabled branches", () => {
    const neutral = composeHarnessExtensionDiscoveryInstruction({ ...state(health({
      usable: false,
      phase: "cloud_tools_missing",
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })), connectCatalogEnabled: false });
    expect(neutral).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);

    expect(composeHarnessExtensionDiscoveryInstruction({ ...state(health({
      usable: false,
      phase: "missing_desired",
      desired: { present: false, revision: null },
      firstFailure: {
        code: "cloud_mcp_missing",
        stage: "desired_config",
        recommendedAction: "Connect Harness Cloud",
        message: "missing",
      },
    })), connectCatalogEnabled: false })).toBe(HARNESS_CONNECT_SIGN_IN_INSTRUCTION);

    expect(composeHarnessExtensionDiscoveryInstruction({ ...state(health({
      usable: false,
      phase: "engine_disabled",
      firstFailure: {
        code: "cloud_mcp_disabled",
        stage: "engine_delivery",
        recommendedAction: "Enable",
        message: "disabled",
      },
    })), connectCatalogEnabled: false })).toBe(HARNESS_CONNECT_DISABLED_INSTRUCTION);
  });

  test("keeps neutral steering for probe-side server failures", () => {
    expect(composeHarnessExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "ready",
      engine: { status: "connected" },
      firstFailure: {
        code: "probe_unreachable",
        stage: "tool_registration",
        recommendedAction: "Check network",
        message: "probe failed",
      },
    })))).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);

    expect(composeHarnessExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "cloud_tools_missing",
      engine: { status: "connected" },
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })))).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("keeps neutral steering for cloud_tools_missing regardless of server engine health", () => {
    const withoutEngine = composeHarnessExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "cloud_tools_missing",
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })));
    const failedEngine = composeHarnessExtensionDiscoveryInstruction(state(health({
      usable: false,
      phase: "cloud_tools_missing",
      engine: { status: "failed" },
      firstFailure: {
        code: "cloud_tools_missing",
        stage: "tool_registration",
        recommendedAction: "Run reconcile",
        message: "missing",
      },
    })));

    expect(withoutEngine).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(failedEngine).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("treats unknown workspace as neutral instead of borrowing another workspace", () => {
    const instruction = composeHarnessExtensionDiscoveryInstruction({
      ...state(null),
      workspace: { resolution: "unknown", id: null, directory: "/tmp/unknown", reason: "No workspace has this exact OpenCode directory" },
    });
    expect(instruction).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
  });

  test("never emits degraded wording or no-tool-use guidance", () => {
    const engineStatuses: Array<string | undefined> = [
      "connected",
      "disabled",
      "needs_auth",
      "needs_client_registration",
      "failed",
      "starting",
      undefined,
    ];
    for (const status of engineStatuses) {
      expectNoDegradedSteering(composeSteeringFromEngineMcpStatus(status));
    }

    const fallbackStates: HarnessExtensionConnectState[] = [
      state(health()),
      state(health({ usableByCurrentModel: null })),
      state(health({
        usableByCurrentModel: false,
        phase: "provider_projection_missing",
        firstFailure: failure("provider_tool_projection_missing"),
      })),
      state(health({
        usable: false,
        phase: "engine_disabled",
        firstFailure: failure("cloud_mcp_disabled"),
      })),
      state(health({
        usable: false,
        phase: "missing_desired",
        desired: { present: false, revision: null },
        firstFailure: failure("cloud_desired_missing"),
      })),
      state(health({
        usable: false,
        phase: "missing_mcp",
        firstFailure: failure("cloud_mcp_missing"),
      })),
      state(health({
        usable: false,
        phase: "probe_unreachable",
        firstFailure: failure("probe_unreachable"),
      })),
      state(health({
        usable: false,
        phase: "cloud_tools_missing",
        firstFailure: failure("cloud_tools_missing"),
      })),
      { ...state(null), workspace: { resolution: "unknown", id: null, directory: "/tmp/unknown" } },
      { ...state(null), connectCatalogEnabled: false },
      state(null),
    ];
    for (const fallbackState of fallbackStates) {
      expectNoDegradedSteering(composeHarnessExtensionDiscoveryInstruction(fallbackState));
    }
  });
});

describe("resolveHarnessExtensionDiscoveryInstruction", () => {
  test("uses engine connected status without fetching server connect state", async () => {
    const requests: unknown[] = [];
    const client = engineMcpClient({ data: { "harness-cloud": { status: "connected" } } }, requests);
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    const instruction = await resolveHarnessExtensionDiscoveryInstruction(
      { context: { directory: "/tmp/ws_1" } },
      serverFetch,
      { client, directory: "/tmp/factory" },
    );

    expect(instruction).toBe(HARNESS_CLOUD_CONNECTION_INSTRUCTION);
    expect(requests).toEqual([{ query: { directory: "/tmp/ws_1" } }]);
    expect(serverFetchCalls).toBe(0);
  });

  test("uses engine auth-needed status without fetching server connect state", async () => {
    const client = engineMcpClient({ data: { "harness-cloud": { status: "needs_auth" } } });
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    expect(await resolveHarnessExtensionDiscoveryInstruction({}, serverFetch, { client })).toBe(HARNESS_CONNECT_SIGN_IN_INSTRUCTION);
    expect(serverFetchCalls).toBe(0);
  });

  test("fails open without server fetch when engine status lookup errors", async () => {
    const client: HarnessEngineMcpStatusClient = {
      mcp: {
        status: async () => {
          throw new Error("engine unavailable");
        },
      },
    };
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    expect(await resolveHarnessExtensionDiscoveryInstruction({}, serverFetch, { client })).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(serverFetchCalls).toBe(0);
  });

  test("fails open without server fetch when engine has an unknown harness-cloud status", async () => {
    const client = engineMcpClient({ data: { "harness-cloud": { status: "starting" } } });
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({ message: "unexpected" }, { status: 500 });
    };

    expect(await resolveHarnessExtensionDiscoveryInstruction({}, serverFetch, { client })).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(serverFetchCalls).toBe(0);
  });

  test("reads Cloud-only server connect state when engine has no harness-cloud entry", async () => {
    process.env.HARNESS_SERVER_URL = "http://harness.test";
    process.env.HARNESS_SERVER_TOKEN = "test-token";
    const client = engineMcpClient({ data: { other: { status: "connected" } } });
    let serverFetchCalls = 0;
    const serverFetch = async (): Promise<Response> => {
      serverFetchCalls += 1;
      return Response.json({
        ok: true,
        schemaVersion: 1,
        connectEnabled: true,
        connectCatalogEnabled: true,
        cloudMcpPresent: true,
        cloudHealth: health(),
        workspace: { resolution: "resolved", id: "ws_1", directory: "/tmp/ws_1" },
      });
    };

    expect(await resolveHarnessExtensionDiscoveryInstruction({ context: { directory: "/tmp/ws_1" } }, serverFetch, { client })).toBe(HARNESS_CLOUD_CONNECTION_INSTRUCTION);
    expect(serverFetchCalls).toBe(1);
  });

  test("fetches verified health for the current directory/model without caching stale failures", async () => {
    process.env.HARNESS_SERVER_URL = "http://harness.test/";
    process.env.HARNESS_SERVER_TOKEN = "test-token";
    const urls: string[] = [];
    const authorizations: Array<string | null> = [];
    let calls = 0;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      calls += 1;
      urls.push(url);
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json({
        ok: true,
        schemaVersion: 1,
        connectEnabled: true,
        connectCatalogEnabled: true,
        cloudMcpPresent: calls > 1,
        cloudHealth: calls > 1 ? health() : health({
          usable: false,
          phase: "cloud_tools_missing",
          firstFailure: {
            code: "cloud_tools_missing",
            stage: "tool_registration",
            recommendedAction: "Run reconcile",
            message: "missing",
          },
        }),
        workspace: { resolution: "resolved", id: "ws_1", directory: "/tmp/ws_1" },
      });
    };

    const input = {
      context: { directory: "/tmp/ws_1" },
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    };
    expect(await resolveHarnessExtensionDiscoveryInstruction(input, fakeFetch)).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(await resolveHarnessExtensionDiscoveryInstruction(input, fakeFetch)).toBe(HARNESS_CLOUD_CONNECTION_INSTRUCTION);
    expect(calls).toBe(2);
    expect(urls).toEqual([
      "http://harness.test/experimental/connect/state?directory=%2Ftmp%2Fws_1&provider=anthropic&model=claude-sonnet-4",
      "http://harness.test/experimental/connect/state?directory=%2Ftmp%2Fws_1&provider=anthropic&model=claude-sonnet-4",
    ]);
    expect(authorizations).toEqual(["Bearer test-token", "Bearer test-token"]);
  });

  test("passes workspace id and worktree from plugin context", async () => {
    process.env.HARNESS_SERVER_URL = "http://harness.test";
    process.env.HARNESS_SERVER_TOKEN = "test-token";
    let requested = "";
    const fakeFetch = async (url: string): Promise<Response> => {
      requested = url;
      return Response.json({
        ok: true,
        schemaVersion: 1,
        connectEnabled: true,
        connectCatalogEnabled: true,
        cloudMcpPresent: true,
        cloudHealth: health(),
        workspace: { resolution: "resolved", id: "ws_2", directory: "/tmp/worktree" },
      });
    };

    await resolveHarnessExtensionDiscoveryInstruction({ context: { workspaceId: "ws_2", worktree: "/tmp/worktree" } }, fakeFetch);
    expect(requested).toBe("http://harness.test/experimental/connect/state?workspaceId=ws_2&directory=%2Ftmp%2Fworktree");
  });

  test("fails open when connect state fetching or parsing fails", async () => {
    process.env.HARNESS_SERVER_URL = "http://harness.test";
    process.env.HARNESS_SERVER_TOKEN = "test-token";
    const failingFetch = async (): Promise<Response> => {
      throw new Error("network unavailable");
    };
    const invalidFetch = async (): Promise<Response> => Response.json({ ok: true });

    expect(await resolveHarnessExtensionDiscoveryInstruction({}, failingFetch)).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(await resolveHarnessExtensionDiscoveryInstruction({}, invalidFetch)).toBe(HARNESS_EXTENSION_DISCOVERY_INSTRUCTION);
  });
});
