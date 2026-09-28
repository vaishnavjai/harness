import assert from "node:assert/strict";
import test from "node:test";
import { headlessBrowserEnvironment } from "../src/headless-browser.ts";
import { appWebEnvironment, parseAppWebOptions } from "../../../worlds/lib/app-web-options.ts";
import { assertDevHeadlessPlacement } from "../../../worlds/dev-headless.ts";

const selection = { HARNESS_WORLD_SELECTED_ENV_KEYS: '["HARNESS_DEV_HEADLESS_WEB_DEN_PROXY","HARNESS_DEV_DEN_PROXY_TARGET"]' };

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

test("app-web selects only explicit nonsecret app environment, without Cloud opt-in by default", () => {
  assert.deepEqual(appWebEnvironment({ HARNESS_TOKEN: "secret", HARNESS_HOST_TOKEN: "secret", OPENAI_API_KEY: "secret", HOME: "/personal" }), {});
  assert.deepEqual(appWebEnvironment({ ...selection, HARNESS_DEV_HEADLESS_WEB_DEN_PROXY: "1", HARNESS_DEV_DEN_PROXY_TARGET: "https://den.example.test/", OTHER: "secret" }), {
    HARNESS_DEV_HEADLESS_WEB_DEN_PROXY: "1", HARNESS_DEV_DEN_PROXY_TARGET: "https://den.example.test", VITE_DISABLE_HARNESS_MODELS: "0",
  });
  for (const target of ["https://user:secret@example.test", "https://example.test?key=secret", "file:///tmp/data", "https://example.test/path"]) {
    assert.throws(() => appWebEnvironment({ ...selection, HARNESS_DEV_HEADLESS_WEB_DEN_PROXY: "1", HARNESS_DEV_DEN_PROXY_TARGET: target }));
  }
  assert.throws(() => appWebEnvironment({ ...selection, HARNESS_DEV_HEADLESS_WEB_DEN_PROXY: "maybe" }));
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

test("app-web consumes only CLI-selected settings and rejects secret or unknown selections", () => {
  const ambient = { HARNESS_DEV_HEADLESS_WEB_DEN_PROXY: "1", HARNESS_DEV_DEN_PROXY_TARGET: "https://den.example.test" };
  assert.deepEqual(appWebEnvironment({ ...ambient, HARNESS_WORLD_SELECTED_ENV_KEYS: "[]" }), {});
  assert.deepEqual(appWebEnvironment(ambient), {});
  for (const marker of ['["HARNESS_DEV_HEADLESS_WEB_DEN_PROXY"]', '["HARNESS_DEV_DEN_PROXY_TARGET"]']) {
    assert.throws(() => appWebEnvironment({ ...ambient, HARNESS_WORLD_SELECTED_ENV_KEYS: marker }), /together/);
  }
  assert.throws(() => appWebEnvironment({ ...ambient, ...selection, HARNESS_DEV_HEADLESS_WEB_DEN_PROXY: "0" }), /together/);
  for (const marker of ['["HARNESS_TOKEN"]', '["HOME"]', '[1]', '{}', 'invalid']) {
    assert.throws(() => appWebEnvironment({ ...ambient, HARNESS_WORLD_SELECTED_ENV_KEYS: marker }));
  }
});

test("dev-headless explicitly rejects nonlocal placement without changing its local default", () => {
  assert.doesNotThrow(() => assertDevHeadlessPlacement({}));
  assert.doesNotThrow(() => assertDevHeadlessPlacement({ HARNESS_WORLD_PLACE: "local" }));
  assert.throws(() => assertDevHeadlessPlacement({ HARNESS_WORLD_PLACE: "daytona" }), /only --place local/);
});
