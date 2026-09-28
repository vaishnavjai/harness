import { mkdir } from "node:fs/promises";
import type { Seed } from "@harness/env";
import {
  createPlacement,
  SkipError,
} from "@harness/env";
import type { Place } from "@harness/env";
import { app } from "@harness/env";
import { daytonaSandbox, desktop } from "@harness/hosts";
import { bootRemoteSession } from "../../worlds/remote-session.ts";

export async function emptyInfraWorld(_seed: Seed) {
  return {};
}

export async function twoDaytonaDesktopsWorld(seed: Seed) {
  const requestedA = process.env.HARNESS_EVAL_DAYTONA_SANDBOX_A?.trim();
  const requestedB = process.env.HARNESS_EVAL_DAYTONA_SANDBOX_B?.trim();
  if (Boolean(requestedA) !== Boolean(requestedB)) throw new Error("Set both Daytona sandbox ids or neither.");
  if (requestedA && requestedA === requestedB) throw new Error("The two Daytona sandbox ids must differ.");
  const appA = requestedA
    ? await desktop({ host: daytonaSandbox(requestedA), name: "a" })
    : await seed.desktop({ name: "a" });
  // The pooled lane hands every surface the worker's prepared sandbox; this
  // journey is about two sandboxes, so the second desktop must own its own.
  const appB = requestedB
    ? await desktop({ host: daytonaSandbox(requestedB), name: "b" })
    : await seed.desktop({ name: "b", ownSandbox: true });
  const sandboxA = appA.handle.sandboxId;
  const sandboxB = appB.handle.sandboxId;
  if (!sandboxA || !sandboxB) throw new Error("Both desktops must run in Daytona sandboxes.");
  if (sandboxA === sandboxB) throw new Error("The two Daytona sandbox ids must differ.");
  const stamp = Date.now();
  const [workspaceA, workspaceB] = await Promise.all([
    seed.workspace(appA, `/tmp/harness-two-sandboxes-a-${stamp}`),
    seed.workspace(appB, `/tmp/harness-two-sandboxes-b-${stamp}`),
  ]);
  return {
    appA,
    appB,
    sandboxA,
    sandboxB,
    workspaceA,
    workspaceB,
    async [Symbol.asyncDispose]() {
      await Promise.all([appA[Symbol.asyncDispose](), appB[Symbol.asyncDispose]()]);
    },
  };
}
export {  } from "@harness/behaviors";
export { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths, stopHeadlessRuntime } from "@harness/world";
export { createDesktopAutomationRunner } from "../../apps/desktop/electron/automation-runner.mjs";
export { bootDevHeadless } from "../../worlds/dev-headless.ts";
