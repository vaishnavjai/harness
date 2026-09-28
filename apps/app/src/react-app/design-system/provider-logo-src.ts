import { resolveExtensionIconSrc } from "./extension-icon-src";

/**
 * Brand logo candidates for an LLM provider, tried in order and advanced on
 * `img` onError, before the monogram in `ProviderIcon`.
 */

/**
 * Logos bundled with the app, by OpenCode provider id. Harness never asks an
 * icon CDN or favicon service about the providers a person uses, so a
 * provider without a bundled logo shows the ProviderIcon monogram.
 */
const BUNDLED_PROVIDER_LOGOS: Record<string, string> = {
  openai: "/ext-openai.svg",
  ollama: "/ext-ollama.svg",
  harness: "/harness-mark.svg",
};

/** Ordered logo URLs for a provider: at most one bundled asset. */
export function providerLogoCandidates(input: {
  providerId?: string | null;
  baseUrl?: string | null;
}): string[] {
  const id = input.providerId?.trim().toLowerCase() ?? "";
  const bundled = BUNDLED_PROVIDER_LOGOS[id];
  return bundled ? [resolveExtensionIconSrc(bundled)] : [];
}
