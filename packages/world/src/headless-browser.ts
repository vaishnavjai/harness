export function headlessBrowserEnvironment(input: {
  browserHostSuffix?: string;
  harnessUrl: string;
}): Record<string, string> {
  if (input.browserHostSuffix === undefined) return {};
  if (!/^\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(input.browserHostSuffix)) {
    throw new Error("Invalid headless browser host suffix.");
  }
  const target = new URL(input.harnessUrl);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port) {
    throw new Error("Headless browser proxy must target the loopback runtime.");
  }
  return {
    HARNESS_DEV_BROWSER_HOST_SUFFIX: input.browserHostSuffix,
    HARNESS_DEV_HARNESS_PROXY_TARGET: target.origin,
    VITE_HARNESS_URL: "/api/harness",
    VITE_HARNESS_PORT: "443",
    VITE_HARNESS_FORCE_MANUAL_AUTH: "1",
  };
}
