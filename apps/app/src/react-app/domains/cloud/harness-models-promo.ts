import { INFERENCE_MODEL_ALIASES } from "@harness/types/den/inference";

import {
  buildDenAuthUrl,
  getDenInferenceUrl,
  isSelfHostedControlPlane,
  HOSTED_DEFAULT_DEN_BASE_URL,
  readDenBootstrapConfig,
  readDenSettings,
} from "../../../app/lib/den";
import { isDefaultControlPlaneUrl } from "../settings/cloud/control-plane-url";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useSyncExternalStore } from "react";

export const HARNESS_MODELS_PROVIDER_ID = "harness";
export const HARNESS_MODELS_PROVIDER_NAME = "Harness Models";
export const HARNESS_MODELS_PROMO_HIDDEN_KEY = "harness.harnessModelsPromo.hidden";
export const HARNESS_MODELS_PROMO_LAST_SHOWN_KEY = "harness.harnessModelsPromo.lastShownAt";
export const HARNESS_MODELS_STARTUP_PROMO_SHOWN_KEY = "harness.harnessModelsPromo.startupShown";
export const harnessModelsPromoChangedEvent = "harness-harness-models-promo-changed";
export const HARNESS_MODELS_PROMO_SHOW_DELAY_MS = 4_000;
export const HARNESS_MODELS_PROMO_VISIBLE_MS = 14_000;
export const HARNESS_MODELS_PROMO_REPEAT_MS = 6 * 60 * 60 * 1000;

export function areHarnessModelsPromosDisabled() {
  if (/^(1|true|yes|on)$/i.test(String(import.meta.env.VITE_DISABLE_HARNESS_MODELS ?? "").trim())) {
    return true;
  }
  // Harness Models are a hosted Harness Cloud offering; self-hosted
  // deployments should never see the upsell surfaces.
  return isSelfHostedControlPlane();
}

export function isHarnessModelsPromoEligibleForDenBaseUrl(baseUrl: string) {
  return !areHarnessModelsPromosDisabled() && isDefaultControlPlaneUrl(baseUrl, HOSTED_DEFAULT_DEN_BASE_URL);
}

export function isHarnessModelsPromoEligible() {
  return isHarnessModelsPromoEligibleForDenBaseUrl(readDenSettings().baseUrl);
}

export function useHarnessModelsPromoEligibility() {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener(denSettingsChangedEvent, notify);
      return () => window.removeEventListener(denSettingsChangedEvent, notify);
    },
    isHarnessModelsPromoEligible,
    isHarnessModelsPromoEligible,
  );
}

export type HarnessModelPreview = {
  id: string;
  title: string;
  subtitle: string;
};

export const HARNESS_MODEL_PREVIEWS: HarnessModelPreview[] = Object.entries(
  INFERENCE_MODEL_ALIASES,
)
  .filter(([, model]) => model.enabled)
  .map(([id, model]) => ({
    id,
    title: model.displayName.replace(/^Harness:\s*/, ""),
    subtitle: "Harness hosted",
  }));

export function hasHarnessModelsProvider(providerIds: readonly string[]) {
  return providerIds.some((id) => id.trim().toLowerCase() === HARNESS_MODELS_PROVIDER_ID);
}

/** Local engine has Harness Models connected with at least one selectable model. */
export function hasHarnessModelsAvailable(input: {
  providerConnectedIds: readonly string[];
  providers: ReadonlyArray<{ id: string; models?: Record<string, unknown> | null }>;
}) {
  if (!hasHarnessModelsProvider(input.providerConnectedIds)) return false;
  const harness = input.providers.find(
    (provider) => provider.id.trim().toLowerCase() === HARNESS_MODELS_PROVIDER_ID,
  );
  return Object.keys(harness?.models ?? {}).length > 0;
}

export function shouldShowHarnessModelsSyncing(input: {
  entitled: boolean;
  available: boolean;
  workspaceReady: boolean;
  reloadPending: boolean;
}) {
  return input.entitled && !input.available && input.workspaceReady && input.reloadPending;
}

export function getHarnessModelsActionUrl(
  isSignedIn: boolean,
  authMode: "sign-in" | "sign-up" = "sign-in",
) {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl || readDenBootstrapConfig().baseUrl;
  // Signed-in users go straight to the Harness Models page — the value-prop
  // + subscribe surface — never to a bare auth or billing page.
  return isSignedIn ? getDenInferenceUrl(baseUrl) : buildDenAuthUrl(baseUrl, authMode);
}

export function isHarnessModelsPromoHidden() {
  if (areHarnessModelsPromosDisabled()) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(HARNESS_MODELS_PROMO_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function hideHarnessModelsPromo() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HARNESS_MODELS_PROMO_HIDDEN_KEY, "1");
    window.dispatchEvent(new Event(harnessModelsPromoChangedEvent));
  } catch {}
}

export function wasHarnessModelsStartupPromoShown() {
  if (!isHarnessModelsPromoEligible()) return true;
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(HARNESS_MODELS_STARTUP_PROMO_SHOWN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markHarnessModelsStartupPromoShown() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HARNESS_MODELS_STARTUP_PROMO_SHOWN_KEY, "1");
  } catch {}
}

export function shouldShowHarnessModelsPromo(now = Date.now()) {
  if (!isHarnessModelsPromoEligible() || typeof window === "undefined" || isHarnessModelsPromoHidden()) return false;
  try {
    const lastShown = Number(window.localStorage.getItem(HARNESS_MODELS_PROMO_LAST_SHOWN_KEY) ?? "0");
    return !Number.isFinite(lastShown) || now - lastShown >= HARNESS_MODELS_PROMO_REPEAT_MS;
  } catch {
    return true;
  }
}

export function markHarnessModelsPromoShown(now = Date.now()) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HARNESS_MODELS_PROMO_LAST_SHOWN_KEY, String(now));
  } catch {}
}
