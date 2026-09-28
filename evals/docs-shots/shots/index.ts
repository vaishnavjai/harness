import type { Shot } from "./shot.ts";
import { denHarnessWeb, denPluginDetail, denSkillEditor } from "./den-web.ts";
import {
  desktopTeamPromptCards,
  libraryAddMcpModal,
  libraryAdvancedSettings,
  libraryCreateSkillModal,
  librarySkills,
} from "./desktop.ts";
import {
  denLegacyProviderCatalogForm,
  denLegacyProviderCustomForm,
  denLegacyProviderDetail,
  denLegacyProviders,
  desktopCloudProviders,
} from "./providers.ts";
import { harnessWebTab } from "./web-tab.ts";

export const shots: Shot[] = [
  desktopTeamPromptCards,
  librarySkills,
  libraryCreateSkillModal,
  libraryAdvancedSettings,
  libraryAddMcpModal,
  denPluginDetail,
  denSkillEditor,
  denHarnessWeb,
  harnessWebTab,
  denLegacyProviders,
  denLegacyProviderCatalogForm,
  denLegacyProviderCustomForm,
  denLegacyProviderDetail,
  desktopCloudProviders,
];
