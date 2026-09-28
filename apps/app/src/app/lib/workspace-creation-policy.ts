import { isHarnessGatewayRuntime } from "./gateway-runtime";

export function canCreateWorkspaces() {
  return !isHarnessGatewayRuntime();
}
