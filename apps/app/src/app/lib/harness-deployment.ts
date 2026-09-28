export const HARNESS_DEPLOYMENT_ENV_VAR = "VITE_HARNESS_DEPLOYMENT";

export type HarnessDeployment = "desktop" | "web";

function normalizeDeployment(value: string | undefined): HarnessDeployment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "web" ? "web" : "desktop";
}

export function getHarnessDeployment(): HarnessDeployment {
  const envValue =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_HARNESS_DEPLOYMENT === "string"
      ? import.meta.env.VITE_HARNESS_DEPLOYMENT
      : undefined;

  return normalizeDeployment(envValue);
}

export function isWebDeployment(): boolean {
  return getHarnessDeployment() === "web";
}

export function isDesktopDeployment(): boolean {
  return getHarnessDeployment() === "desktop";
}
