import { browserScript } from "@harness/cdp";
import { readActiveWorkspaceId } from "@harness/cdp";
import type { Surface } from "@harness/cdp";
import { clickButton, control, currentHash, evalIn, go, waitFor, waitForText, waitUntilInteractive } from "./desktop.ts";
import { createLocalWorkspaceViaUi } from "./onboarding.ts";



export interface SelectedWorkspaceFacts {
  workspaceId: string;
  route: string;
}



function workspaceIdFromRoute(route: string): string {
  return /\/workspace\/([^/?#]+)/.exec(route)?.[1] ?? "";
}

async function waitForTaskUi(app: Surface, workspaceId: string): Promise<string> {
  await go(app, `/workspace/${workspaceId}/session`);
  await waitFor(app, browserScript((workspaceId) => {
    const match = /^#?\/workspace\/([^/?#]+)\/session\/?$/.exec(window.location.hash);
    const routeReady = match?.[1] === workspaceId;
    const text = document.body.innerText;
    const runTask = [...document.querySelectorAll("button")]
      .some((button) => (button.textContent ?? "").trim() === "Run task");
    return routeReady && (text.includes("What do you need done?") || runTask);
  }, [workspaceId]), { timeoutMs: 120_000, label: `workspace ${workspaceId} task UI` });
  return currentHash(app);
}

/** The active workspace id from the product's own state, with the route as fallback. */
async function resolveWorkspaceId(app: Surface): Promise<string> {
  const fromState = await readActiveWorkspaceId(app.client, { timeoutMs: 30_000 }).catch(() => null);
  if (fromState) return fromState;
  return workspaceIdFromRoute(await currentHash(app));
}

/** The folder the product reports for a workspace, or null when it is not listed yet. */
async function workspacePath(app: Surface, workspaceId: string): Promise<string | null> {
  const value = await evalIn(app, browserScript((id) => (
    window.__harness?.slice?.("route")?.workspaces?.find((workspace) => workspace.id === id)?.path ?? null
  ), [workspaceId]));
  return typeof value === "string" ? value : null;
}

/**
 * THE arrangement path for a workspace: the product's own onboarding, driven
 * the way a person drives it. A previous API seed (POST /workspaces/local +
 * activate) produced a state the product itself never produces — a workspace
 * with no engine and no model catalog — and specs failed on that arrangement,
 * not on their subject. If a spec needs a workspace, it goes through here.
 */
export async function createAndSelectWorkspace(
  app: Surface,
  input: { path: string; create?: boolean },
): Promise<SelectedWorkspaceFacts> {
  let workspaceId = "";
  const route = await currentHash(app);
  if (route.includes("/welcome")) {
    const workspace = await createLocalWorkspaceViaUi(app, input);
    await clickButton(app, "Skip and use the free model", { timeoutMs: 90_000 });
    await waitForText(app, "How did you hear about Harness?", { timeoutMs: 90_000 });
    await clickButton(app, "Skip", { timeoutMs: 15_000 });
    // Only now is the workspace actually selected: resolving before the
    // onboarding steps finish reads an id the app has not adopted yet.
    workspaceId = workspace.id;
    if (!workspaceId) {
      await waitFor(app, () => (Boolean(localStorage.getItem("harness.react.activeWorkspace"))
        || /\/workspace\/[^/?#]+/.test(window.location.hash)), {
        timeoutMs: 180_000,
        label: "workspace selected after onboarding",
      });
      workspaceId = await resolveWorkspaceId(app);
    }
  } else {
    workspaceId = await resolveWorkspaceId(app);
    // First launch selects a bootstrap "Harness Chat" workspace by itself, so a
    // selected workspace only satisfies the caller when it sits at the requested folder.
    const selectedPath = workspaceId ? await workspacePath(app, workspaceId) : null;
    if (!workspaceId || input.create || selectedPath !== input.path) {
      await waitFor(app, () => (window.__harnessControl.listActions()
        .some((action) => action.id === "workspace.create" && !action.disabled)), {
        timeoutMs: 60_000,
        label: "workspace.create enabled",
      });
      // Cold first action: engine spawn + Vite compile can exceed the default
      // evaluate bound, and this proved flaky at 8s (passed on rerun).
      await control(app, "workspace.create", { path: input.path }, { timeoutMs: 60_000 });
      // The app does not always put a new workspace in the hash, so wait for its
      // own active-workspace state to settle instead of matching a route shape.
      await waitFor(app, browserScript((workspaceId) => {
        const selected = localStorage.getItem("harness.react.activeWorkspace")
          || window.location.hash.match(/\/workspace\/([^/?#]+)/)?.[1];
        return Boolean(selected) && selected !== workspaceId;
      }, [workspaceId]), {
        timeoutMs: 120_000,
        label: "created workspace selected",
      });
      workspaceId = await resolveWorkspaceId(app);
    }
  }
  if (!workspaceId) throw new Error("Workspace creation did not produce a workspace ID.");
  const taskRoute = await waitForTaskUi(app, workspaceId);
  // The task UI can be mounted while the panel still renders placeholders, so
  // hand back only once the app is actually interactive.
  await waitUntilInteractive(app);
  return { workspaceId, route: taskRoute };
}
