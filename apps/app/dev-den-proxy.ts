interface DevDenProxyOptions {
  target: string;
  changeOrigin: boolean;
  rewrite?: (path: string) => string;
}

export function devDenProxy(env: NodeJS.ProcessEnv): Record<string, DevDenProxyOptions> {
  // A local Den API is a separate service from its web UI. Proxy to it
  // directly so a cross-origin redirect cannot strip the member's bearer.
  const apiTarget = env.HARNESS_DEV_HEADLESS_DEN_API_TARGET?.trim();
  const target = apiTarget || env.HARNESS_DEV_HEADLESS_DEN_TARGET?.trim();
  if (!target) return {};
  let hosted = false;
  try {
    const url = new URL(target);
    hosted = url.origin === "https://app.harness.invalid"
      && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch {}
  return {
    "/api/den": {
      target: hosted ? "https://api.harness.invalid" : target,
      changeOrigin: true,
      ...(hosted || apiTarget ? { rewrite: (path: string) => path.replace(/^\/api\/den(?=\/|\?|$)/, "") || "/" } : {}),
    },
  };
}
