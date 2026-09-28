import { expect } from "vitest";
import { spec } from "@harness/testkit";
import { appDenTlsFaultWorld } from "../worlds/first-run.ts";

const test = spec.world(appDenTlsFaultWorld, {
  needs: { commands: ["bun"] },
  timeout: 180_000,
});

test("a desktop pointed at a TLS-intercepted Den never claims it is connected, and diagnostics name the interception", async ({ world, user, step }) => {
  await step("The welcome surface offers cloud sign-in without a crash", async () => {
    await user.see("Sign in to Harness Cloud");
    await user.notSee({ text: /Something went wrong/ });
    await user.click("Sign in to Harness Cloud");
    await user.looks([
      "A Harness screen offering to sign in to Harness Cloud is visible",
      "No error or 'Something went wrong' crash message is visible yet",
    ]);
  });

  for (const falseSuccess of ["Signed in as", "Synced", "Connected to Harness Cloud"]) {
    await user.notSee({ text: new RegExp(falseSuccess) });
  }

  const verdict = await world.diagnose();
  expect(verdict.available, verdict.text).toBe(true);
  expect(verdict.expectationMatched, verdict.text).toBe(true);
});
