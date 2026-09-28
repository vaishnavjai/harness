declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import {
  HARNESS_EXTENSION_CATALOG,
  filterHarnessExtensionCatalogForPlatform,
  resolveHarnessExtensionCatalogPlatform,
} from "./constants";

function filteredIds(platform: "darwin" | "linux" | "windows" | "web") {
  return filterHarnessExtensionCatalogForPlatform(HARNESS_EXTENSION_CATALOG, platform)
    .flatMap((entry) => entry.id ? [entry.id] : []);
}

describe("Harness extension catalog platform filter", () => {
  test("resolves browser runtime to web and desktop runtime to OS", () => {
    expect(resolveHarnessExtensionCatalogPlatform("web", "macos")).toEqual("web");
    expect(resolveHarnessExtensionCatalogPlatform("desktop", "macos")).toEqual("darwin");
    expect(resolveHarnessExtensionCatalogPlatform("desktop", "windows")).toEqual("windows");
    expect(resolveHarnessExtensionCatalogPlatform("desktop", "linux")).toEqual("linux");
  });

  test("hides desktop-only extensions in web", () => {
    expect(filteredIds("web")).toEqual(["ollama"]);
  });

  test("keeps Harness Browser desktop-only and Computer Use mac-only", () => {
    expect(filteredIds("darwin")).toEqual(["harness-browser", "computer-use", "ollama"]);
    expect(filteredIds("linux")).toEqual(["harness-browser", "ollama"]);
  });
});
