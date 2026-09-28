/** @jsxImportSource react */
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toContain: (expected: string) => void;
  toEqual: (expected: unknown) => void;
};

import { renderToStaticMarkup } from "react-dom/server";

import { ProviderIcon } from "./provider-icon";
import { providerLogoCandidates } from "./provider-logo-src";

describe("provider logo candidates", () => {
  test("uses logos bundled with the app", () => {
    expect(providerLogoCandidates({ providerId: "openai" })).toEqual(["/ext-openai.svg"]);
    expect(providerLogoCandidates({ providerId: "Ollama" })).toEqual(["/ext-ollama.svg"]);
  });

  test("never asks an icon CDN or favicon service about a provider", () => {
    for (const providerId of ["anthropic", "google", "groq", "bedrock", "302.ai", "my-gateway"]) {
      const candidates = providerLogoCandidates({ providerId, baseUrl: "https://api.together.xyz/v1" });
      expect(candidates).toEqual([]);
    }
  });

  test("returns nothing without a provider id", () => {
    expect(providerLogoCandidates({ providerId: "" })).toEqual([]);
  });
});

describe("ProviderIcon", () => {
  test("renders the bundled brand mark for Anthropic without a network request", () => {
    const markup = renderToStaticMarkup(<ProviderIcon providerId="anthropic" size={20} />);
    expect(markup).toContain("<svg");
    expect(markup).toContain('role="img"');
  });

  test("renders a bundled logo without any remote image lookup", () => {
    const markup = renderToStaticMarkup(<ProviderIcon providerId="ollama" size={20} />);
    expect(markup).toContain("ext-ollama.svg");
    expect(markup.includes("https://")).toBe(false);
  });

  test("keeps the monogram only for providers with no resolvable logo", () => {
    const markup = renderToStaticMarkup(<ProviderIcon providerId="" size={20} />);
    expect(markup).toContain("AI");
    expect(markup).toContain("<div");
  });
});
