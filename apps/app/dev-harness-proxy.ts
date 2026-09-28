interface DevHarnessProxyOptions {
  target: string;
  changeOrigin: boolean;
  ws: boolean;
  rewrite: (path: string) => string;
}

export function devHarnessProxy(env: NodeJS.ProcessEnv): Record<string, DevHarnessProxyOptions> {
  if (env.HARNESS_DEV_MODE !== "1" || !env.HARNESS_DEV_HARNESS_PROXY_TARGET) return {};
  const target = new URL(env.HARNESS_DEV_HARNESS_PROXY_TARGET);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port
    || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("Invalid development-only Harness proxy configuration.");
  }
  return {
    "/api/harness": {
      target: target.origin,
      changeOrigin: true,
      ws: true,
      rewrite: (path: string) => path.replace(/^\/api\/harness(?=\/|\?|$)/, "") || "/",
    },
  };
}
