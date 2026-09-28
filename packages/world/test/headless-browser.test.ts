import assert from "node:assert/strict";
import test from "node:test";
import { headlessBrowserEnvironment } from "../src/headless-browser.ts";
import { parseAppWebOptions } from "../../../worlds/lib/app-web-options.ts";
import { assertDevHeadlessPlacement } from "../../../worlds/dev-headless.ts";

test("headless browser transport is opt-in and leaves loopback defaults unchanged", () => {
  assert.deepEqual(headlessBrowserEnvironment({ harnessUrl: "http://127.0.0.1:8778" }), {});
  assert.deepEqual(headlessBrowserEnvironment({ browserHostSuffix: ".example.test", harnessUrl: "http://127.0.0.1:8778" }), {
    HARNESS_DEV_BROWSER_HOST_SUFFIX: ".example.test", HARNESS_DEV_HARNESS_PROXY_TARGET: "http://127.0.0.1:8778",
    VITE_HARNESS_URL: "/api/harness", VITE_HARNESS_PORT: "443",
    VITE_HARNESS_FORCE_MANUAL_AUTH: "1",
  });
});

test("headless browser transport rejects origins, malformed suffixes and nonloopback targets", () => {
  for (const browserHostSuffix of ["https://example.test", ".example.test/path", ".example.test?token=secret", "example.test", "invalid"]) {
    assert.throws(() => headlessBrowserEnvironment({ browserHostSuffix, harnessUrl: "http://127.0.0.1:8778" }));
  }
  assert.throws(() => headlessBrowserEnvironment({ browserHostSuffix: ".example.test", harnessUrl: "https://api.example.test" }), /loopback/);
});

test("app-web requires exact Daytona source and rejects cloud/reuse flags", () => {
  const ref = "a".repeat(40);
  assert.deepEqual(parseAppWebOptions([], {}), { place: "local", ref: undefined, lifetimeMinutes: 120 });
  assert.deepEqual(parseAppWebOptions(["--ref", ref], { HARNESS_WORLD_PLACE: "daytona" }), { place: "daytona", ref, lifetimeMinutes: 120 });
  assert.equal(parseAppWebOptions(["--lifetime", "30"], {}).lifetimeMinutes, 30);
  for (const value of ["0", "1", "9", "1431", "1441", "-1", "NaN"]) assert.throws(() => parseAppWebOptions(["--lifetime", value], {}));
  for (const args of [[], ["--ref", "main"], ["--cloud"], ["--ref", ref, "--reuse", "other"]]) {
    assert.throws(() => parseAppWebOptions(args, { HARNESS_WORLD_PLACE: "daytona" }));
  }
  assert.throws(() => parseAppWebOptions(["--ref", ref], {}));
  assert.throws(() => parseAppWebOptions([], { HARNESS_WORLD_PLACE: "elsewhere" }));
});

test("dev-headless explicitly rejects nonlocal placement without changing its local default", () => {
  assert.doesNotThrow(() => assertDevHeadlessPlacement({}));
  assert.doesNotThrow(() => assertDevHeadlessPlacement({ HARNESS_WORLD_PLACE: "local" }));
  assert.throws(() => assertDevHeadlessPlacement({ HARNESS_WORLD_PLACE: "daytona" }), /only --place local/);
});
