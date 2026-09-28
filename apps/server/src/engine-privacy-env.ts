/**
 * Set on every managed OpenCode engine so it makes no request of its own:
 * no self-update check, no npm install of OpenCode's default auth plugins, and
 * no language-server downloads, no session sharing. Model traffic goes only to providers the
 * person configured; the model catalog is handled by
 * `resolveOpencodeModelCatalogEnv`.
 */
export const ENGINE_PRIVACY_ENV: Readonly<Record<string, string>> = Object.freeze({
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_SHARE: "1",
});
