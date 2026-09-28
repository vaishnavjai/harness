/** @jsxImportSource react */
import { useCallback, useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";

import { t } from "../../i18n";
import {
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceCreateRemote,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type WorkspaceInfo,
  type WorkspaceList,
} from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";
import { canCreateWorkspaces } from "../../app/lib/workspace-creation-policy";
import { createClient, unwrap } from "../../app/lib/opencode";
import { useLocal } from "../kernel/local-provider";
import { usePlatform } from "../kernel/platform";
import { WelcomePage } from "../domains/onboarding/welcome-page";
import { ProviderSelectionStep } from "../domains/onboarding/provider-selection-step";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";
import type { CreateWorkspaceOptions } from "../domains/workspace/types";
import {
  getHarnessModelsActionUrl,
  hideHarnessModelsPromo,
  useHarnessModelsPromoEligibility,
  markHarnessModelsStartupPromoShown,
} from "../domains/cloud/harness-models-promo";
import { useDenAuth } from "../domains/cloud/den-auth-provider";
import { JoinOrganizationDialog } from "../domains/cloud/join-organization-dialog";
import { resolveHarnessConnection } from "./harness-connection";
import { buildHarnessWorkspaceBaseUrl, createHarnessServerClient } from "../../app/lib/harness-server";
import { buildDenAuthUrl, DEFAULT_DEN_BASE_URL, readDenSettings } from "../../app/lib/den";
import { markDesktopSignInInitiated } from "../../app/lib/den-sign-in-intent";
import { denSettingsChangedEvent } from "../../app/lib/den-session-events";
import { writeActiveWorkspaceId, writeLastSessionFor, writeWorkspaceProjectDimension } from "./session-memory";
import { workspaceSessionRoute } from "./workspace-routes";
import { ensureDesktopLocalHarnessConnection } from "./desktop-local-harness";
import { shouldHoldWelcomeForDenSession } from "./welcome-den-session";

function subscribeToDenSettings(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(denSettingsChangedEvent, onStoreChange);
  return () => window.removeEventListener(denSettingsChangedEvent, onStoreChange);
}

function readDenAuthTokenSnapshot() {
  return readDenSettings().authToken?.trim() ?? "";
}

function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

function focusPromptSoon() {
  if (typeof window === "undefined") return;
  const focus = () => window.dispatchEvent(new Event("harness:focusPrompt"));
  [0, 80, 240, 600].forEach((delay) => window.setTimeout(focus, delay));
}

type WelcomeState = {
  modalOpen: boolean;
  createBusy: boolean;
  createError: string | null;
  remoteBusy: boolean;
  remoteError: string | null;
  providerStep: boolean;
  pendingWorkspaceId: string | null;
  pendingSessionId: string | null;
};

type WelcomeAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "create:start" }
  | { type: "create:error"; error: string }
  | { type: "create:finish" }
  | { type: "remote:start" }
  | { type: "remote:error"; error: string }
  | { type: "remote:finish" }
  | { type: "provider-step"; workspaceId: string; sessionId: string | null };

const initialWelcomeState: WelcomeState = {
  modalOpen: false,
  createBusy: false,
  createError: null,
  remoteBusy: false,
  remoteError: null,
  providerStep: false,
  pendingWorkspaceId: null,
  pendingSessionId: null,
};

function welcomeReducer(state: WelcomeState, action: WelcomeAction): WelcomeState {
  switch (action.type) {
    case "open":
      return { ...state, modalOpen: true };
    case "close":
      return { ...state, modalOpen: false, createError: null, remoteError: null };
    case "create:start":
      return { ...state, createBusy: true, createError: null };
    case "create:error":
      return { ...state, createError: action.error };
    case "create:finish":
      return { ...state, createBusy: false };
    case "remote:start":
      return { ...state, remoteBusy: true, remoteError: null };
    case "remote:error":
      return { ...state, remoteError: action.error };
    case "remote:finish":
      return { ...state, remoteBusy: false };
    case "provider-step":
      return { ...state, providerStep: true, pendingWorkspaceId: action.workspaceId, pendingSessionId: action.sessionId };
  }
}

/**
 * WelcomeRoute: full-screen welcome page shown on first launch when
 * the user has no workspaces and has not completed onboarding.
 *
 * Clicking "Get started" opens the CreateWorkspaceModal. Once a
 * workspace is created, provider onboarding runs before
 * hasCompletedOnboarding is set and the user is redirected to /session.
 */
export function WelcomeRoute() {
  const navigate = useNavigate();
  const local = useLocal();
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const [state, dispatch] = useReducer(welcomeReducer, initialWelcomeState);
  const [manualFolder, setManualFolder] = useState("");
  const [joinOrganizationOpen, setJoinOrganizationOpen] = useState(false);
  const showHarnessModelsPromo = useHarnessModelsPromoEligibility();
  const denAuthTokenSnapshot = useSyncExternalStore(
    subscribeToDenSettings,
    readDenAuthTokenSnapshot,
    readDenAuthTokenSnapshot,
  );
  const holdSignedOutSurface = shouldHoldWelcomeForDenSession({
    authStatus: denAuth.status,
    hasStoredAuthToken: Boolean(denAuthTokenSnapshot),
    isSignedIn: denAuth.isSignedIn,
  });

  // If user already completed onboarding, redirect away immediately.
  useEffect(() => {
    if (local.prefs.hasCompletedOnboarding) {
      navigate("/session", { replace: true });
    }
  }, [local.prefs.hasCompletedOnboarding, navigate]);

  useEffect(() => {
    if (denAuth.isSignedIn) {
      navigate("/onboarding", { replace: true });
    }
  }, [denAuth.isSignedIn, navigate]);

  const markOnboardingComplete = useCallback(() => {
    local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
  }, [local]);

  const handleCreateWorkspace = useCallback(
    async (_preset: string, folder: string | null, options?: CreateWorkspaceOptions) => {
      if (!folder) return;
      const projectLabel = options?.projectLabel?.trim() ?? "";
      dispatch({ type: "create:start" });
      try {
        const workspaceName = folderNameFromPath(folder);
        let list: WorkspaceList | null = null;
        let sessionBaseUrl = "";
        let sessionToken = "";
        try {
          const { normalizedBaseUrl, resolvedToken, resolvedHostToken } =
            await resolveHarnessConnection();
          if (normalizedBaseUrl && (resolvedToken || resolvedHostToken)) {
            const harnessClient = createHarnessServerClient({
              baseUrl: normalizedBaseUrl,
              token: resolvedToken || undefined,
              hostToken: resolvedHostToken || undefined,
            });
            list = await harnessClient.createLocalWorkspace({
              folderPath: folder,
              name: workspaceName,
              preset: "starter",
            });
            sessionBaseUrl = normalizedBaseUrl;
            sessionToken = resolvedToken;
          }
        } catch {
          list = null;
        }
        if (!list) {
          throw new Error("Harness server is unavailable. Start or reconnect the server before creating a workspace.");
        }
        const createdId =
          resolveWorkspaceListSelectedId(list) ||
          list.workspaces[list.workspaces.length - 1]?.id ||
          "";
        let targetWorkspaceId = createdId;
        let targetWorkspace = list.workspaces.find((workspace: WorkspaceInfo) => workspace.id === createdId) ?? null;
        let targetSessionId: string | null = null;
        if (createdId) {
          await workspaceSetSelected(createdId).catch(() => undefined);
          await workspaceSetRuntimeActive(createdId).catch(() => undefined);
          writeActiveWorkspaceId(createdId);
        }
        if (targetWorkspace) {
          await ensureDesktopLocalHarnessConnection({
            route: "session",
            workspace: targetWorkspace,
            allWorkspaces: list.workspaces,
          }).catch(() => undefined);
          const fresh = await resolveHarnessConnection().catch(() => null);
          if (fresh?.normalizedBaseUrl && fresh.resolvedToken) {
            sessionBaseUrl = fresh.normalizedBaseUrl;
            sessionToken = fresh.resolvedToken;
          }
        }
        if (targetWorkspaceId && sessionBaseUrl && sessionToken) {
          try {
            const workspacePath = targetWorkspace?.path?.trim() || folder;
            const session = unwrap(await createClient(
              `${(buildHarnessWorkspaceBaseUrl(sessionBaseUrl, targetWorkspaceId) ?? sessionBaseUrl).replace(/\/+$/, "")}/opencode`,
              workspacePath || undefined,
              { token: sessionToken, mode: "harness" },
            ).session.create({ directory: workspacePath || undefined }));
            targetSessionId = session.id;
          } catch {
            // Best-effort first task creation.
          }
        }
        if (targetWorkspaceId) {
          writeActiveWorkspaceId(targetWorkspaceId);
          if (projectLabel) {
            writeWorkspaceProjectDimension(targetWorkspaceId, {
              label: projectLabel,
            });
          }
          if (targetSessionId) writeLastSessionFor(targetWorkspaceId, targetSessionId);
        }
        dispatch({ type: "close" });
        // Show the provider selection step before navigating to the session.
        dispatch({ type: "provider-step", workspaceId: targetWorkspaceId, sessionId: targetSessionId });

      } catch (error) {
        dispatch({
          type: "create:error",
          error: error instanceof Error ? error.message : "Failed to create workspace.",
        });
      } finally {
        dispatch({ type: "create:finish" });
      }
    },
    [],
  );

  const handleCreateRemote = useCallback(
    async (input: {
      harnessHostUrl?: string | null;
      harnessToken?: string | null;
      directory?: string | null;
      displayName?: string | null;
    }) => {
      const baseUrlValue = input.harnessHostUrl?.trim() ?? "";
      if (!baseUrlValue) return false;
      dispatch({ type: "remote:start" });
      try {
        const remoteType: "harness" = "harness";
        const payload = {
          baseUrl: baseUrlValue,
          harnessHostUrl: baseUrlValue,
          harnessToken: input.harnessToken?.trim() || null,
          displayName: input.displayName?.trim() || null,
          directory: input.directory?.trim() || null,
          remoteType,
        };
        let list: WorkspaceList | null = null;
        if (isDesktopRuntime()) {
          list = await workspaceCreateRemote(payload);
        } else {
          try {
            const { normalizedBaseUrl, resolvedToken, resolvedHostToken } =
              await resolveHarnessConnection();
            if (normalizedBaseUrl && (resolvedToken || resolvedHostToken)) {
              list = await createHarnessServerClient({
                baseUrl: normalizedBaseUrl,
                token: resolvedToken || undefined,
                hostToken: resolvedHostToken || undefined,
              }).createRemoteWorkspace(payload);
            }
          } catch {
            list = null;
          }
        }
        if (!list) {
          throw new Error("Harness server is unavailable. Start or reconnect the server before connecting a remote workspace.");
        }
        const createdId =
          resolveWorkspaceListSelectedId(list) ||
          list.workspaces[list.workspaces.length - 1]?.id ||
          "";
        if (createdId) {
          await workspaceSetSelected(createdId).catch(() => undefined);
          await workspaceSetRuntimeActive(createdId).catch(() => undefined);
          writeActiveWorkspaceId(createdId);
        }
        markOnboardingComplete();
        dispatch({ type: "close" });
        navigate(createdId ? workspaceSessionRoute(createdId) : "/session", { replace: true });
        return true;
      } catch (error) {
        dispatch({
          type: "remote:error",
          error: error instanceof Error ? error.message : "Connection failed.",
        });
        return false;
      } finally {
        dispatch({ type: "remote:finish" });
      }
    },
    [markOnboardingComplete, navigate],
  );

  const handleGetStarted = useCallback(async () => {
    if (!isDesktopRuntime()) {
      if (!canCreateWorkspaces()) return;
      // Non-desktop: fall back to the modal for remote workspace creation.
      dispatch({ type: "open" });
      return;
    }
    const picked = await pickDirectory({ title: t("onboarding.authorize_folder") });
    const folder = typeof picked === "string" ? picked : null;
    if (!folder) return;
    await handleCreateWorkspace("starter", folder);
  }, [handleCreateWorkspace]);

  const handleUseManualFolder = useCallback(async () => {
    const folder = manualFolder.trim();
    if (!folder) return;
    await handleCreateWorkspace("starter", folder);
  }, [handleCreateWorkspace, manualFolder]);

  const handleTeamSignIn = useCallback(() => {
    markOnboardingComplete();
    const settings = readDenSettings();
    markDesktopSignInInitiated();
    platform.openLink(buildDenAuthUrl(settings.baseUrl || DEFAULT_DEN_BASE_URL, "sign-in"));
  }, [markOnboardingComplete, platform]);

  const finishOnboarding = useCallback((route: string) => {
    markOnboardingComplete();
    navigate(route, { replace: true });
    if (state.pendingSessionId) focusPromptSoon();
  }, [markOnboardingComplete, navigate, state.pendingSessionId]);

  if (holdSignedOutSurface) {
    return null;
  }

  return (
    <>
      <WelcomePage
        onGetStarted={handleGetStarted}
        busy={state.createBusy}
        error={state.createError}
        manualFolder={manualFolder}
        onManualFolderChange={setManualFolder}
        onUseManualFolder={handleUseManualFolder}
        showManualFolder={import.meta.env.DEV && isDesktopRuntime()}
        onTeamSignIn={handleTeamSignIn}
        onJoinOrganization={() => setJoinOrganizationOpen(true)}
      />
      <JoinOrganizationDialog
        open={joinOrganizationOpen}
        onOpenChange={setJoinOrganizationOpen}
        onConnected={() => {
          markOnboardingComplete();
          setJoinOrganizationOpen(false);
        }}
      />
      <CreateWorkspaceModal
        open={state.modalOpen}
        onClose={() => dispatch({ type: "close" })}
        onConfirm={handleCreateWorkspace}
        onConfirmRemote={handleCreateRemote}
        onPickFolder={() =>
          pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<
            string | null
          >
        }
        submitting={state.createBusy}
        localError={state.createError}
        remoteSubmitting={state.remoteBusy}
        remoteError={state.remoteError}
        localDisabled={!isDesktopRuntime()}
        localDisabledReason={
          isDesktopRuntime()
            ? undefined
            : t("app.local_disabled_reason")
        }
      />
      {state.providerStep ? (
        <ProviderSelectionStep
          showHarnessModels={showHarnessModelsPromo}
          onHarnessModels={() => {
            // Land on the Harness Models value-prop page when already
            // signed in to Den; otherwise start sign-up. Previously this
            // always opened a bare sign-up page — payment before value.
            platform.openLink(getHarnessModelsActionUrl(denAuth.isSignedIn, "sign-up"));
            const route = state.pendingWorkspaceId
              ? workspaceSessionRoute(state.pendingWorkspaceId, state.pendingSessionId)
              : "/session";
            finishOnboarding(route);
          }}
          onBringYourOwn={() => {
            markHarnessModelsStartupPromoShown();
            hideHarnessModelsPromo();
            const route = state.pendingWorkspaceId
              ? workspaceSessionRoute(state.pendingWorkspaceId, state.pendingSessionId)
              : "/session";
            finishOnboarding(`${route}?onboarding=1`);
          }}
          onSkip={() => {
            const route = state.pendingWorkspaceId
              ? workspaceSessionRoute(state.pendingWorkspaceId, state.pendingSessionId)
              : "/session";
            finishOnboarding(route);
          }}
        />
      ) : null}
    </>
  );
}
