import type { DenExternalMcpPreset } from "../../../app/lib/den";
import { resolveExtensionIconUrl } from "../../design-system/extension-icon-src";

export type LibraryConnectorCue = {
  id: string;
  name: string;
  iconSrc?: string;
  serviceUrl?: string;
};

const MAX_CONNECTOR_CUES = 5;
const FEATURED_PRESET_IDS = ["notion", "slack"] as const;
/** Connector icons bundled with the app; others show the generic glyph. */
const PRESET_ICONS: Record<string, string> = {
  notion: "/ext-notion.svg",
  slack: "/ext-slack.svg",
  linear: "/ext-linear.svg",
  stripe: "/ext-stripe.svg",
  sentry: "/ext-sentry.svg",
};

const HOSTED_SUITE_CUES: LibraryConnectorCue[] = [
  {
    id: "google-workspace",
    name: "Google Workspace",
    iconSrc: "/ext-google-workspace.svg",
  },
  {
    id: "microsoft-365",
    name: "Microsoft 365",
  },
];

export function libraryConnectorIconUrls(cue: LibraryConnectorCue): string[] {
  const icon = resolveExtensionIconUrl(cue);
  return icon ? [icon] : [];
}

function cueForPreset(preset: DenExternalMcpPreset): LibraryConnectorCue {
  return {
    id: preset.presetId,
    name: preset.displayName,
    iconSrc: PRESET_ICONS[preset.presetId],
    serviceUrl: preset.url,
  };
}

export function libraryConnectorCues(
  presets: DenExternalMcpPreset[],
): LibraryConnectorCue[] {
  const uniquePresets = new Map(
    presets.map((preset) => [preset.presetId, preset] as const),
  );
  const featured = FEATURED_PRESET_IDS.flatMap((presetId) => {
    const preset = uniquePresets.get(presetId);
    if (!preset) return [];
    uniquePresets.delete(presetId);
    return [cueForPreset(preset)];
  });
  const additionalPresets = [...uniquePresets.values()].map(cueForPreset);

  return [...featured, ...HOSTED_SUITE_CUES, ...additionalPresets]
    .slice(0, MAX_CONNECTOR_CUES);
}
