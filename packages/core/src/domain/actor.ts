import { z } from "zod";

export const tenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  publishableKey: z.string(),
  settings: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type Tenant = z.infer<typeof tenantSchema>;

export const endUserSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  /** The host app's own user id. Null for anonymous visitors. */
  externalId: z.string().nullable(),
  isAnonymous: z.boolean(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  attributes: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type EndUser = z.infer<typeof endUserSchema>;

export const agentStatusSchema = z.enum(["online", "away", "offline"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/**
 * A projection of the host application's user record, created on first
 * authenticated connect. This system is never the source of truth for agents.
 */
export const agentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  externalId: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  skills: z.array(z.string()),
  maxConcurrent: z.number().int().positive(),
  role: z.enum(["agent", "admin"]),
  createdAt: z.string().datetime(),
});
export type AgentRecord = z.infer<typeof agentSchema>;

/** Public shape of an agent, safe to send to an end user. */
export const agentPublicSchema = agentSchema.pick({
  id: true,
  displayName: true,
  avatarUrl: true,
});
export type AgentPublic = z.infer<typeof agentPublicSchema>;
