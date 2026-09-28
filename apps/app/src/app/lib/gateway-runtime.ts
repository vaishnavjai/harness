// Gateway runtime detection primitives. Leaf module by design: keep it import-free
// so low-level clients can choose same-origin gateway behavior without cycles.
export type HarnessGatewayMarker = {
  version?: number;
  build?: string;
};

declare global {
  interface Window {
    __HARNESS_GATEWAY__?: HarnessGatewayMarker;
  }
}

const DEN_AUTH_TOKEN_STORAGE_KEY = "harness.den.authToken";

export function isHarnessGatewayRuntime() {
  return typeof window !== "undefined" && window.__HARNESS_GATEWAY__?.version === 1;
}

export function getHarnessGatewayBuild(): string | null {
  if (!isHarnessGatewayRuntime()) return null;
  const build = window.__HARNESS_GATEWAY__?.build?.trim() ?? "";
  return build || null;
}

export function getHarnessGatewayOrigin() {
  if (!isHarnessGatewayRuntime()) return null;
  const origin = window.location.origin.trim();
  return origin || null;
}

export function readHarnessGatewayDenToken() {
  if (!isHarnessGatewayRuntime()) return "";
  try {
    return window.localStorage.getItem(DEN_AUTH_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}
