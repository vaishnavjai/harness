export const LOCAL_PREFERENCES_KEY = "harness.preferences";

export type LinkOpenDestination = "harness" | "external";

export function isLinkOpenDestination(value: unknown): value is LinkOpenDestination {
  return value === "harness" || value === "external";
}
