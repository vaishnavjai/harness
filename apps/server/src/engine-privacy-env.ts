/**
 * Set on every managed OpenCode engine so it makes no request of its own:
 * no self-update check, no npm install of OpenCode's default auth plugins, and
 * no language-server downloads, no session sharing. Model traffic goes only to providers the
 * person configured; the model catalog is handled by
 * `resolveOpencodeModelCatalogEnv`.
 *
 * `DO_NOT_TRACK` matters because OpenCode is a Bun binary, and Bun uploads
 * crash reports to bun.report by default on macOS and Windows. Tools the
 * agent runs inherit both opt-outs too.
 *
 * Applied last, so neither the ambient nor a caller's environment can undo it.
 */
export const ENGINE_PRIVACY_ENV: Readonly<Record<string, string>> = Object.freeze({
  ENABLE_TELEMETRY: "false",
  DO_NOT_TRACK: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_SHARE: "1",
});
