import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

function resourcesPathFromAppAsarPath(path: string): string | null {
  const match = /[\\/]app\.asar(?:[\\/]|$)/.exec(path);
  return match ? path.slice(0, match.index) : null;
}

export function harnessPluginPath(name: string, here?: string): string {
  const pluginDir = process.env.HARNESS_EXTENSIONS_PLUGIN_DIR;
  if (pluginDir) {
    return join(pluginDir, `${name}.js`);
  }

  here = here ?? dirname(fileURLToPath(import.meta.url));
  const resourcesPath = resourcesPathFromAppAsarPath(here);
  if (resourcesPath) {
    const electronResourcesPath = process.resourcesPath?.includes("app.asar") ? resourcesPath : process.resourcesPath?.trim();
    return join(electronResourcesPath || resourcesPath, "opencode-plugins", `${name}.js`);
  }

  const extension = basename(here) === "dist" ? "js" : "ts";
  return join(here, "opencode-plugins", `${name}.${extension}`);
}

export const harnessExtensionsPreviewPluginPath = () => harnessPluginPath("harness-extensions-preview");
export const harnessChromeDevtoolsPluginPath = () => harnessPluginPath("harness-chrome-devtools");
export const harnessCapabilitiesKnowledgePluginPath = () => harnessPluginPath("harness-capabilities-knowledge");
export const harnessAnthropicAdaptiveThinkingPluginPath = () => harnessPluginPath("harness-anthropic-adaptive-thinking");
export const harnessAnthropicToolSchemaPluginPath = () => harnessPluginPath("harness-anthropic-tool-schema");
export const harnessOfficeAttachmentsPluginPath = () => harnessPluginPath("harness-office-attachments");
export const harnessSpreadsheetsPluginPath = () => harnessPluginPath("harness-spreadsheets");
export const harnessPdfAttachmentsPluginPath = () => harnessPluginPath("harness-pdf-attachments");
export const harnessTitleRecoveryPluginPath = () => harnessPluginPath("harness-title-recovery");
export const harnessGatewayQuotaPluginPath = () => harnessPluginPath("harness-gateway-quota");
export const harnessGatewayQuotaV2PluginPath = () => harnessPluginPath("harness-gateway-quota-v2");
export const harnessContextV2PluginPath = () => harnessPluginPath("harness-context-v2");
export const harnessProviderFiltersV2PluginPath = () => harnessPluginPath("harness-provider-filters-v2");
