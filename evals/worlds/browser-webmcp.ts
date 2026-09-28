import { browserScript, evaluate } from "@harness/cdp";
import type { Surface } from "@harness/cdp";
import { configureBrowserFixtureModel, startBrowserFixture } from "@harness/env";
import type { Seed } from "@harness/env";
import { builtinBrowserWorld } from "./browser-panel.ts";
import { selectModel } from "@harness/behaviors";

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** The body gets resources, never closures retaining the setup Seed. */
export async function browserBackgroundWorld(seed: Seed) {
  const base = await builtinBrowserWorld(seed);
  const fixture = await startBrowserFixture(base.app, { requireSignIn: false });
  return {
    ...base,
    origin: fixture.origin,
    /**
     * A command stamped with the conversation it comes from, exactly as the
     * server hands mailbox requests to the window. The HTTP mailbox itself
     * answers "did not answer within 5 seconds", so a command that must wait
     * for the user's approval is issued at the window boundary.
     */
    async commandFrom(sessionId: string, id: string, args: Record<string, unknown>): Promise<unknown> {
      return evaluate(base.app.client, browserScript((id, encodedArgs, sessionId) =>
        window.__harnessControl.command({ id, args: JSON.parse(encodedArgs), origin: { sessionId } }),
      [id, JSON.stringify(args), sessionId]), { awaitPromise: true, timeoutMs: 120_000 });
    },
    async [Symbol.asyncDispose]() { await fixture[Symbol.asyncDispose](); },
  };
}

export async function browserWebMcpWorld(seed: Seed) {
  const workspacePath = seed.tmpPath("browser-tools");
  const base = await builtinBrowserWorld(seed, { workspacePath });
  const stack = new AsyncDisposableStack();
  try {
    const fixture = stack.use(await startBrowserFixture(base.app));
    const origin = fixture.origin;
    await configureBrowserFixtureModel(base.app, workspacePath, origin);
    const enginePath = `/workspace/${base.workspace.workspaceId}/opencode`;
    await seed.evalIn(base.app, browserScript(async (disposePath) => {
      const info = await window.__HARNESS_ELECTRON__.invokeDesktop('harnessServerInfo');
      const response = await fetch(info.baseUrl + disposePath, {
        method: 'POST', headers: { Authorization: 'Bearer ' + info.clientToken },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error('Fixture model reload failed');
    }, [`${enginePath}/instance/dispose`]), { awaitPromise: true, timeoutMs: 35_000 });
    // Leave the browser unmounted: the discovery turn must request its first tab.
    return { ...base, origin, enginePath, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) { await stack.disposeAsync(); throw error; }
}

export async function browserConsentSummaryWorld(seed: Seed) {
  const world = await browserWebMcpWorld(seed);
  try {
    await selectModel(world.app, "fixture", { provider: "Browser fixture" });
    return world;
  } catch (error) {
    await world[Symbol.asyncDispose]();
    throw error;
  }
}

export async function setBrowserEnabled(seed: Seed, app: Surface, enabled: boolean) {
  await seed.evalIn(app, browserScript((enabled) => window.__HARNESS_ELECTRON__.browser.setControlEnabled(enabled), [enabled]), { awaitPromise: true });
}
