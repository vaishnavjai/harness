export function resolveExtensionIconSrc(iconSrc: string): string {
  if (!iconSrc.startsWith("/")) {
    return iconSrc;
  }

  const base = import.meta.env.BASE_URL || "/";
  return `${base.replace(/\/?$/, "/")}${iconSrc.replace(/^\/+/, "")}`;
}

/**
 * Only icons bundled with the app are shown. Harness does not ask icon CDNs
 * or favicon services about the connectors and sites a person uses; without
 * a bundled icon, callers fall back to their generic glyph.
 */
export function resolveExtensionIconUrl(input: {
  iconSrc?: string;
  iconSlug?: string;
  serviceUrl?: string;
}): string | undefined {
  return input.iconSrc ? resolveExtensionIconSrc(input.iconSrc) : undefined;
}
