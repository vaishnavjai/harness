declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { DEFAULT_DEN_BASE_URL, HOSTED_DEFAULT_DEN_BASE_URL, setDenBootstrapConfig } from "../../../app/lib/den";
import {
  hasHarnessModelsAvailable,
  isHarnessModelsPromoEligible,
  isHarnessModelsPromoEligibleForDenBaseUrl,
  shouldShowHarnessModelsPromo,
  shouldShowHarnessModelsSyncing,
  wasHarnessModelsStartupPromoShown,
} from "./harness-models-promo";

afterEach(async () => {
  await setDenBootstrapConfig({ baseUrl: DEFAULT_DEN_BASE_URL, requireSignin: false });
});

describe("Harness Models promo eligibility", () => {
  test("never promotes a hosted model offering, even on the build-default Den URL", () => {
    expect(isHarnessModelsPromoEligibleForDenBaseUrl(`${HOSTED_DEFAULT_DEN_BASE_URL}/api/den/`)).toBe(false);
    expect(isHarnessModelsPromoEligible()).toBe(false);
    expect(shouldShowHarnessModelsPromo()).toBe(false);
  });

  test("suppresses promotions for custom configured Den URLs", async () => {
    await setDenBootstrapConfig({ baseUrl: "https://custom-den.example.com", requireSignin: false });

    expect(isHarnessModelsPromoEligible()).toBe(false);
    expect(shouldShowHarnessModelsPromo()).toBe(false);
    expect(wasHarnessModelsStartupPromoShown()).toBe(true);
  });
});

describe("hasHarnessModelsAvailable", () => {
  test("requires a connected harness provider with at least one model", () => {
    expect(
      hasHarnessModelsAvailable({
        providerConnectedIds: ["harness"],
        providers: [{ id: "harness", models: {} }],
      }),
    ).toBe(false);
    expect(
      hasHarnessModelsAvailable({
        providerConnectedIds: ["harness"],
        providers: [{ id: "harness", models: { "gpt-5": {} } }],
      }),
    ).toBe(true);
  });
});

describe("shouldShowHarnessModelsSyncing", () => {
  test("only reports a real pending workspace reload", () => {
    expect(shouldShowHarnessModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: false,
      reloadPending: true,
    })).toBe(false);
    expect(shouldShowHarnessModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: false,
    })).toBe(false);
    expect(shouldShowHarnessModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: true,
    })).toBe(true);
  });
});
