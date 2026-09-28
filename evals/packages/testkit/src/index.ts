export { browserScript } from "@harness/cdp";
export { control, evalIn, quitDesktop } from "@harness/behaviors";
export { attachSurface, evaluateOnSurface } from "@harness/cdp";
// checkpointCapability and its types come from @harness/env (re-exported below).
export { screenshot } from "@harness/test-evidence";
export type { BrowserEvaluation, BrowserScript } from "@harness/cdp";
export { desktop as relaunchDesktop, electronProfilePaths } from "@harness/hosts";
export type { DesktopHandle } from "@harness/hosts";
export type { Surface } from "@harness/cdp";
export type { Target } from "@harness/cdp";
export { browserConversation } from "@harness/behaviors";
export type { BrowserTaskInput, BrowserTaskReply } from "@harness/behaviors";
export { renderPrMarkdown } from "@harness/test-artifacts";
export type { TestRunRecord } from "@harness/test-artifacts";
export type { StepRecord, TestOutcome, TraceEntry } from "@harness/test-evidence";
export { test, CHECKPOINTS_TAG } from "./fixture.ts";
export * from "@harness/env";
export * from "./brief.ts";
export * from "./daytona-witness.ts";
export * from "./app-web-preview-witness.ts";
export * from "./eventually.ts";
export * from "./spec/index.ts";
export * from "./state.ts";

export { observeTranscript, readTranscriptMessages } from "./transcript-observer.ts";
export { readSidebarOverflow } from "@harness/behaviors";
export * from "./verification.ts";
export * from "./verification-jev.ts";
