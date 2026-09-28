import { z } from "zod"

import {
  harnessAffordanceDescriptorSchema,
  harnessProviderRefSchema,
} from "./harness-affordance.js"
import { harnessFeatureContributionSchema } from "./harness-provider.js"

export const HARNESS_CONTEXT_SCHEMA_VERSION = 1

export const harnessSessionRefSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  title: z.string().optional(),
})
export type HarnessSessionRef = z.infer<typeof harnessSessionRefSchema>

export const harnessScreenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("conversation"),
    route: z.string(),
    workspaceId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("settings"),
    route: z.string(),
    workspaceId: z.string().optional(),
    panel: z.string(),
  }),
  z.object({
    kind: z.literal("other"),
    route: z.string(),
  }),
])
export type HarnessScreen = z.infer<typeof harnessScreenSchema>

export const harnessConversationLayoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("single"),
    sessionId: z.string(),
    workspaceId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("split"),
    primarySessionId: z.string(),
    primaryWorkspaceId: z.string().optional(),
    secondarySessionId: z.string(),
    secondaryWorkspaceId: z.string().optional(),
    focused: z.enum(["primary", "secondary"]),
  }),
])
export type HarnessConversationLayout = z.infer<typeof harnessConversationLayoutSchema>

export const harnessPanelTabSchema = z.object({
  id: z.string(),
  kind: z.enum(["browser", "artifact"]),
  label: z.string(),
  url: z.string().optional(),
  status: z.enum(["loading", "ready", "suspending", "suspended", "restoring"]).optional(),
})
export type HarnessPanelTab = z.infer<typeof harnessPanelTabSchema>

export const harnessResourceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  kind: z.enum(["workspace", "session", "screen", "side-panel", "settings"]),
  title: z.string(),
  provider: harnessProviderRefSchema,
  state: z.record(z.string(), z.unknown()),
})
export type HarnessResourceDescriptor = z.infer<typeof harnessResourceDescriptorSchema>

export const harnessContextSnapshotSchema = z.object({
  schemaVersion: z.literal(HARNESS_CONTEXT_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  capturedAt: z.string(),
  features: z.object({
    connectionQuestions: z.boolean().optional(),
  }).optional(),
  screen: harnessScreenSchema,
  conversations: z.object({
    tabs: z.array(harnessSessionRefSchema),
    layout: harnessConversationLayoutSchema,
    pinnedSessionIds: z.array(z.string()),
  }),
  chrome: z.object({
    sidebarOpen: z.boolean(),
    applicationMenuVisible: z.boolean(),
    rightSidebarExpanded: z.boolean(),
  }),
  execution: z.object({
    queries: z.literal("parallel"),
    commands: z.literal("serialized"),
    busyCommandId: z.string().nullable(),
    busyActor: z.string().nullable(),
  }),
  sidePanel: z.object({
    open: z.boolean(),
    ownerSessionId: z.string().nullable(),
    kind: z.enum(["panel", "extensions"]).nullable(),
    tabs: z.array(harnessPanelTabSchema),
    activeTabId: z.string().nullable(),
  }),
  resources: z.array(harnessResourceDescriptorSchema),
  availableAffordances: z.array(harnessAffordanceDescriptorSchema),
  contributions: z.array(harnessFeatureContributionSchema),
})
export type HarnessContextSnapshot = z.infer<typeof harnessContextSnapshotSchema>
