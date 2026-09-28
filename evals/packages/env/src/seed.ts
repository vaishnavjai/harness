import type { BrowserEvaluation, EvaluateOptions } from "@harness/cdp";
import type { Surface } from "@harness/cdp";
import type { StartMockMcpOptions } from "@harness/labs";
import type { DesktopHandle } from "@harness/hosts";
import type { App } from "./desktop-app.ts";
import type { AppWeb, SeedAppWebOptions } from "./app-web.ts";
import type { MockBoot } from "./mock.ts";

export interface SeedDesktopOptions {
  model?: string;
  workspacePath?: string;
  profileDir?: string;
  name?: string;
  /** Extra environment for this isolated Electron process. */
  env?: Record<string, string>;
  /** Refuse the pooled lane's shared sandbox; this desktop gets one of its own. */
  ownSandbox?: boolean;
}

/** Framework-free arrangement contract implemented by the testkit world fixture. */
export interface Seed {
  desktop(options?: SeedDesktopOptions): Promise<App | DesktopHandle>;
  appWeb(options: SeedAppWebOptions): Promise<AppWeb>;
  /**
   * Ensure the workspace at `path` is selected, creating it unless the selected
   * workspace already sits there (a first launch selects its own default folder,
   * which must never satisfy a declared path); create:true forces creation.
   */
  workspace(app: Surface, path?: string, options?: { create?: boolean }): Promise<{ workspaceId: string; route: string }>;
  session(app: Surface, options?: { title?: string }): Promise<{ sessionId: string; title: string }>;
  sessions(app: Surface, titles: readonly string[]): Promise<{ sessionId: string; title: string }[]>;
  mock(options?: StartMockMcpOptions): MockBoot;
  tmpPath(label: string): string;
  composerText(app: Surface, text: string): Promise<void>;
  /** Deliver a fixture-owned link at the renderer ingress; does not exercise OS protocol registration. */
  deepLink(app: Surface, url: string): Promise<void>;
  browserFixtureDiscovery(app: Surface, origin: string, action: "hold" | "release"): Promise<void>;
  /** Migration-only raw write escape hatch. New specs must not use it. */
  evalIn<T>(surface: Surface, expression: BrowserEvaluation<T>, options?: EvaluateOptions): Promise<Awaited<T>>;
}
