import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { harnessFeatureContributionSchema } from "@harness/types/harness-provider";
import { labelHarnessSessionModel, harnessCatalogModels, harnessModelSelectorSchema, resolveHarnessModel } from "@harness/types/harness-affordance";

import { buildHarnessProviderContributions, sessionAffordanceArgsSchemas } from "./harness-provider-adapters.js";

function stringMaxima(schema: unknown): number[] {
  if (schema instanceof z.ZodString) {
    return (schema._def.checks ?? []).flatMap((check) => {
      const def = check._zod.def;
      return def.check === "max_length" && "maximum" in def && typeof def.maximum === "number" ? [def.maximum] : [];
    });
  }
  if (schema instanceof z.ZodObject) return Object.values(schema.shape).flatMap(stringMaxima);
  if (schema instanceof z.ZodArray) return stringMaxima(schema.element);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) return stringMaxima(schema.unwrap());
  if (schema instanceof z.ZodPipe) return stringMaxima(schema.in);
  if (schema instanceof z.ZodUnion) return schema.options.flatMap(stringMaxima);
  return [];
}

describe("workspace model resolution", () => {
  const catalog = harnessCatalogModels({
    connected: ["managed", "local"],
    all: [
      { id: "managed", name: "Managed", models: { opaque: { name: "GPT-6 Luna" }, fallback: {} } },
      { id: "local", name: "Local", models: { other: { name: "GPT-6 Luna" } } },
      { id: "offline", name: "Offline", models: { hidden: { name: "Offline model" } } },
    ],
  });
  test("lists connected models using picker names and id fallback", () => {
    expect(catalog).toEqual([
      { providerId: "managed", modelId: "opaque", displayName: "GPT-6 Luna", providerName: "Managed" },
      { providerId: "managed", modelId: "fallback", displayName: "fallback", providerName: "Managed" },
      { providerId: "local", modelId: "other", displayName: "GPT-6 Luna", providerName: "Local" },
    ]);
  });
  test.each(["alias", "displayName"])("resolves %s case-insensitively with provider qualifier and preserves effort", (field) => {
    const selector = harnessModelSelectorSchema.parse({ [field]: " gPt-6 lUnA ", providerId: "MANAGED", variant: "high" });
    expect(resolveHarnessModel(selector, catalog)).toEqual({ ...catalog[0], variant: "high" });
  });
  test("exact ids select a duplicate label without ambiguity", () => {
    expect(resolveHarnessModel({ providerId: "local", modelId: "other", variant: "default" }, catalog)).toEqual({ ...catalog[2], variant: null });
  });
  test("binding ids override display decorations and availability does not leak into bindings", () => {
    const selector = harnessModelSelectorSchema.parse({ providerId: "local", modelId: "other", variant: "high", displayName: "Stale name", providerName: "Stale provider" });
    expect(resolveHarnessModel(selector, catalog.map((model) => ({ ...model, available: true })))).toEqual({ ...catalog[2], variant: "high" });
  });
  test.each(["GPT-6", "Luna", "Offline model", "opaque"])("does not fuzzily resolve %s or use model ids as names", (alias) => {
    expect(() => resolveHarnessModel({ alias }, catalog)).toThrow("Unavailable model");
  });
  test("rejects ambiguous labels and unavailable ids", () => {
    expect(() => resolveHarnessModel({ alias: "GPT-6 Luna" }, catalog)).toThrow("Ambiguous model");
    expect(() => resolveHarnessModel({ providerId: "managed", modelId: "absent" }, catalog)).toThrow("Unavailable model");
  });
  test.each([{}, { providerId: "managed" }, { modelId: "opaque" }, { alias: "" }, { alias: "GPT-6 Luna", displayName: "GPT-6 Luna" }, { alias: "GPT-6 Luna", modelId: "opaque", providerId: "managed" }])("rejects malformed selectors %j", (value) => {
    expect(harnessModelSelectorSchema.safeParse(value).success).toBe(false);
  });
  test("labels known models without replacing bound ids, effort or unbound state", () => {
    const model = { providerId: "managed", modelId: "opaque", variant: "low" };
    expect(labelHarnessSessionModel(model, catalog)).toEqual({ ...catalog[0], variant: "low" });
    expect(labelHarnessSessionModel(model, [])).toEqual(model);
    expect(labelHarnessSessionModel(null, catalog)).toBeNull();
  });
});

describe("Harness provider adapters", () => {
  test("every session affordance advertises exactly the arguments its schema accepts", () => {
    const sessions = buildHarnessProviderContributions([]).find((contribution) => contribution.featureId === "sessions");
    const affordances = sessions?.affordances ?? [];

    // A schema key the descriptor omits is invisible to agents (they cannot
    // know it exists); an advertised argument the schema drops is silently
    // ignored. Both are drift, so the sets must be equal in both directions.
    expect(affordances.map((affordance) => affordance.id).sort()).toEqual(Object.keys(sessionAffordanceArgsSchemas).sort());
    for (const [id, schema] of Object.entries(sessionAffordanceArgsSchemas)) {
      const advertised = affordances.find((affordance) => affordance.id === id)?.arguments.map((argument) => argument.name).sort();
      expect({ id, advertised }).toEqual({ id, advertised: Object.keys(schema.shape).sort() });
      for (const [name, field] of Object.entries(schema.shape)) {
        const description = affordances.find((affordance) => affordance.id === id)?.arguments.find((argument) => argument.name === name)?.description;
        for (const maximum of stringMaxima(field)) expect(description).toContain(String(maximum));
      }
    }
  });

  test("the bound walker reaches nested and optional strings, including transformed inputs", () => {
    expect(stringMaxima(sessionAffordanceArgsSchemas["session.create"].shape.sessions)).toEqual([100_000, 60]);
    expect(stringMaxima(z.object({ entries: z.array(z.object({ label: z.string().max(17).transform((value) => value).optional() })) }))).toEqual([17]);
    const create = buildHarnessProviderContributions([]).flatMap((entry) => entry.affordances).find((entry) => entry.id === "session.create");
    expect(create?.arguments.find((argument) => argument.name === "sessions")?.description).toContain("title (≤120 chars, longer is clipped)");
  });

  test("normalizes sessions and extensions into semantic contributions", () => {
    const contributions = buildHarnessProviderContributions([]);

    expect(contributions.map((contribution) => contribution.featureId)).toEqual([
      "sessions",
      "automations",
      "extensions",
    ]);
    expect(
      contributions.flatMap((contribution) => contribution.affordances)
        .find((affordance) => affordance.id === "session.read"),
    ).toMatchObject({
      kind: "query",
      effects: { data: "read", ui: "none", external: false },
      executor: { kind: "harness" },
    });
    // Talking to a session is a server command addressed by id: it declares
    // no UI effect, so agents never need session.open + composer.* for it.
    const send = contributions.flatMap((contribution) => contribution.affordances)
      .find((affordance) => affordance.id === "session.send");
    expect(send).toMatchObject({
      kind: "command",
      provider: { id: "harness-server", kind: "builtin" },
      effects: { data: "write", ui: "none", external: false },
      executor: { kind: "harness" },
    });
    expect(send?.arguments.map((argument) => [argument.name, argument.required])).toEqual([
      ["sessionId", true],
      ["text", true],
      ["workspaceId", false],
      ["reveal", false],
    ]);
    for (const contribution of contributions) {
      expect(harnessFeatureContributionSchema.safeParse(contribution).success).toBe(true);
    }
  });

  test("tells agents that sessions carry a model and that session.create takes one", () => {
    const affordances = buildHarnessProviderContributions([]).flatMap((contribution) => contribution.affordances);
    const read = affordances.find((affordance) => affordance.id === "session.read");
    const create = affordances.find((affordance) => affordance.id === "session.create");

    // harness_context is the only place an agent learns the result shape.
    expect(read?.description).toContain("`model`");
    expect(read?.description).toContain("variant");
    expect(read?.description).toContain("`lastError`");
    expect(read?.description).toContain("fetched newest `count` messages");
    expect(read?.description).toContain("start/summary inspect the whole transcript");
    expect(read?.description).toContain("event-only failures");
    expect(create?.arguments.map((argument) => [argument.name, argument.type, argument.required])).toEqual([
      ["sessions", "array", true],
      ["workspaceId", "string", false],
      ["model", "object", false],
    ]);
    expect(create?.arguments.find((argument) => argument.name === "model")?.description).toContain("variant");
    expect(create?.description).toContain("existing renderer host");
    expect(affordances.find((entry) => entry.id === "models.list")?.description).toContain("including headless callers");
  });

  test("keeps known Connect skills direct and search available for unknown capabilities", () => {
    const contributions = buildHarnessProviderContributions([{
      name: "customer-briefing",
      title: "Customer briefing",
      description: "Prepare a customer briefing from connected sources.",
      capability: "skill:skl_customer_briefing",
    }]);
    const connect = contributions.find((contribution) => contribution.featureId === "connect");

    expect(connect?.guidance).toEqual([{
      ref: "skill:skl_customer_briefing",
      title: "Customer briefing",
      description: "Prepare a customer briefing from connected sources.",
      provider: { id: "harness-cloud", kind: "connect" },
      loading: "catalog",
    }]);
    expect(connect?.affordances.map((affordance) => ({
      id: affordance.id,
      executor: affordance.executor,
    }))).toEqual([
      {
        id: "connect.capabilities.search",
        executor: { kind: "tool", tool: "harness-cloud_search_capabilities" },
      },
      {
        id: "connect.capability.execute",
        executor: { kind: "tool", tool: "harness-cloud_execute_capability" },
      },
    ]);
    expect(
      connect?.affordances.find((affordance) => affordance.id === "connect.capability.execute")
        ?.arguments.map((argument) => argument.name),
    ).toEqual(["name", "schemaDigest", "path", "query", "body"]);
  });

  test("includes only MCP providers observed from the engine", () => {
    const contributions = buildHarnessProviderContributions([], [
      { name: "notion", status: "connected" },
      { name: "harness-cloud", status: "connected" },
    ]);

    expect(contributions.map((contribution) => contribution.featureId)).toEqual([
      "sessions",
      "automations",
      "extensions",
      "mcp:notion",
      "connect",
    ]);
    expect(contributions[3]).toMatchObject({
      provider: { id: "notion", kind: "mcp" },
      affordances: [],
    });
    expect(contributions[4]?.affordances.map((affordance) => affordance.id)).toEqual([
      "connect.capabilities.search",
      "connect.capability.execute",
    ]);
  });

  test("exposes an Automations proposal affordance that writes nothing", () => {
    const proposal = buildHarnessProviderContributions([])
      .flatMap((contribution) => contribution.affordances)
      .find((affordance) => affordance.id === "automation.propose");

    expect(proposal).toMatchObject({
      kind: "command",
      // No data effect: a proposal is rendered for a person, never persisted.
      effects: { data: "none", ui: "none", external: false },
      executor: { kind: "harness" },
    });
    expect(proposal?.arguments.map((argument) => argument.name)).toEqual([
      "name",
      "instructions",
      "schedule",
      "model",
    ]);
    expect(proposal?.arguments.find((argument) => argument.name === "model")?.required).toBe(false);
  });
});
