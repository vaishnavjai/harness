/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";

import { isWebDeployment } from "@/app/lib/harness-deployment";
import { hydrateHarnessServerSettingsFromEnv } from "@/app/lib/harness-server";
import { isDesktopRuntime } from "@/app/utils";
import { ConnectLinkProvider } from "@/react-app/domains/cloud/connect-link-provider";
import { DenAuthProvider } from "@/react-app/domains/cloud/den-auth-provider";
import { AutomationRunnerBridge } from "@/react-app/domains/automations/automation-runner-bridge";
import { GlobalQueueDrainerBridge } from "@/react-app/domains/session/sync/global-queue-drainer-bridge";
import { BrandThemeProvider } from "@/react-app/domains/cloud/brand-theme";
import { DesktopConfigProvider } from "@/react-app/domains/cloud/desktop-config-provider";
import { BrowserLoginSyncAccessBridge } from "@/react-app/domains/browser-logins/browser-login-sync-access-bridge";
import { RestrictionNoticeProvider } from "@/react-app/domains/cloud/restriction-notice-provider";
import { LocalProvider } from "@/react-app/kernel/local-provider";
import { ServerProvider } from "@/react-app/kernel/server-provider";
import { ArchitectureMismatchGate } from "./architecture-mismatch-gate";
import { BootStateProvider } from "./boot-state";
import { DesktopRuntimeBoot } from "./desktop-runtime-boot";
import { startDebugLogger, stopDebugLogger } from "./debug-logger";
import { resolveHarnessConnection } from "./harness-connection";
import { ReloadCoordinatorProvider } from "./reload-coordinator";
import { LinkOpenDialog } from "./link-open-dialog";

export function resolveDefaultServerUrl(): string {
  if (isDesktopRuntime()) return "http://127.0.0.1:4096";

  const harnessUrl =
    typeof import.meta.env?.VITE_HARNESS_URL === "string"
      ? import.meta.env.VITE_HARNESS_URL.trim()
      : "";
  if (harnessUrl) {
    const baseUrl = harnessUrl === "/api/harness" && typeof window !== "undefined"
      ? new URL(harnessUrl, window.location.origin).href
      : harnessUrl;
    return `${baseUrl.replace(/\/+$/, "")}/opencode`;
  }

  if (isWebDeployment() && import.meta.env.PROD && typeof window !== "undefined") {
    return `${window.location.origin}/opencode`;
  }

  const envUrl =
    typeof import.meta.env?.VITE_OPENCODE_URL === "string"
      ? import.meta.env.VITE_OPENCODE_URL.trim()
      : "";
  return envUrl || "http://127.0.0.1:4096";
}

type AppProvidersProps = {
  children: ReactNode;
};

// One provider tree for every activation state. The runtime bridges below
// (DesktopRuntimeBoot, BrowserLoginSyncAccessBridge, AutomationRunnerBridge,
// GlobalQueueDrainerBridge) each render nothing until enterprise activation
// completes, so AppRoot-level consumers such as DesktopUpdaterProvider always
// find the same contexts and nothing privileged starts before activation.
export function EnterpriseAwareAppProviders({ children }: AppProvidersProps) {
  return (
    <>
      <DesktopRuntimeBoot />
      <ConnectLinkProvider>
        <DesktopConfigProvider>
          <BrowserLoginSyncAccessBridge />
          <BrandThemeProvider>
            <RestrictionNoticeProvider>
              <LocalProvider>
                <AutomationRunnerBridge />
                <GlobalQueueDrainerBridge />
                <ReloadCoordinatorProvider>{children}</ReloadCoordinatorProvider>
                <LinkOpenDialog />
                <Toaster />
              </LocalProvider>
            </RestrictionNoticeProvider>
          </BrandThemeProvider>
        </DesktopConfigProvider>
      </ConnectLinkProvider>
    </>
  );
}

export function AppProviders({ children }: AppProvidersProps) {
  hydrateHarnessServerSettingsFromEnv();

  useEffect(() => {
    // Start the dev observability forwarder. Reads the current harness-server
    // URL on every flush so reconnects after port changes still work. In prod
    // builds `startDebugLogger` is a no-op.
    startDebugLogger({
      serverUrl: async () => (await resolveHarnessConnection()).normalizedBaseUrl,
    });
    return () => {
      stopDebugLogger();
    };
  }, []);

  const defaultUrl = resolveDefaultServerUrl();
  return (
    <BootStateProvider>
      <ServerProvider defaultUrl={defaultUrl}>
        <ArchitectureMismatchGate>
          <DenAuthProvider>
            <EnterpriseAwareAppProviders>{children}</EnterpriseAwareAppProviders>
          </DenAuthProvider>
        </ArchitectureMismatchGate>
      </ServerProvider>
    </BootStateProvider>
  );
}
