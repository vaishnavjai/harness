import { z } from "zod"

import {
  harnessAffordanceDescriptorSchema,
  harnessProviderRefSchema,
} from "./harness-affordance.js"

export const harnessGuidanceDescriptorSchema = z.object({
  ref: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: harnessProviderRefSchema,
  loading: z.enum(["eager", "catalog", "on-demand"]),
})
export type HarnessGuidanceDescriptor = z.infer<typeof harnessGuidanceDescriptorSchema>

export const harnessFeatureContributionSchema = z.object({
  featureId: z.string().trim().min(1),
  provider: harnessProviderRefSchema,
  affordances: z.array(harnessAffordanceDescriptorSchema),
  guidance: z.array(harnessGuidanceDescriptorSchema),
})
export type HarnessFeatureContribution = z.infer<typeof harnessFeatureContributionSchema>

export const harnessProviderCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  contributions: z.array(harnessFeatureContributionSchema),
})
export type HarnessProviderCatalog = z.infer<typeof harnessProviderCatalogSchema>

export const harnessCapabilityResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    data: z.unknown(),
    additionalContext: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal("guidance"),
    instructions: z.array(z.string()),
  }),
  z.object({
    status: z.literal("requires-user-action"),
    message: z.string(),
    action: z.string().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    retryable: z.boolean(),
  }),
])
export type HarnessCapabilityResult = z.infer<typeof harnessCapabilityResultSchema>
