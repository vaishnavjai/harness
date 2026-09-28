import type { DenHarnessWebAccessSource } from "../../../app/lib/den";

export type HarnessWebAccessCheck = {
  scope: string;
  state: "granted" | "denied" | "error";
  accessSource: DenHarnessWebAccessSource;
};

export type HarnessWebAccessGateState = "inactive" | "checking" | "granted" | "denied" | "error";

export function resolveHarnessWebAccessGateState(input: {
  gatewayMode: boolean;
  authStatus: "checking" | "signed_in" | "unavailable" | "signed_out";
  authToken: string;
  organizationId: string;
  verifiedIdentity: { principalId: string; organizationId: string } | null;
  expectedScope: string | null;
  check: HarnessWebAccessCheck | null;
}): HarnessWebAccessGateState {
  if (!input.gatewayMode || !input.authToken || !input.organizationId) return "inactive";
  if (input.authStatus === "unavailable") return "error";
  if (input.authStatus !== "signed_in") return "checking";
  if (
    !input.verifiedIdentity
    || input.verifiedIdentity.organizationId !== input.organizationId
    || !input.expectedScope
  ) {
    return "checking";
  }
  if (!input.check || input.check.scope !== input.expectedScope) return "checking";
  return input.check.state;
}
