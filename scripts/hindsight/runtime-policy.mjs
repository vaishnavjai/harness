// What the bundled memory runtime must not contain, shared by the runtime
// build (prepare-runtime.mjs) and the package verification (package.mjs).

/**
 * Harness ships no telemetry or crash reporting. The lock still pulls one SDK
 * in transitively: sentry-sdk arrives only through fastapi[standard] ->
 * fastapi-cli -> fastapi-cloud-cli, the `fastapi cloud` deploy command, which
 * no Harness code path runs. The vendored pyproject stays an unmodified
 * upstream copy, so both are uninstalled after the locked install instead.
 */
export const REMOVED_RUNTIME_PACKAGES = Object.freeze(["sentry-sdk", "fastapi-cloud-cli"]);

/** Import names that must not resolve in the finished runtime. */
export const FORBIDDEN_RUNTIME_MODULES = Object.freeze(["sentry_sdk", "fastapi_cloud_cli"]);

/** Python source that prints each forbidden module still importable, one per line. */
export const FORBIDDEN_MODULE_PROBE = [
  "import importlib.util",
  `for name in ${JSON.stringify(FORBIDDEN_RUNTIME_MODULES)}:`,
  "    if importlib.util.find_spec(name) is not None: print(name)",
].join("\n");
