import { z } from "zod";

/**
 * Conversation lifecycle.
 *
 * `ai`       the bot is answering
 * `queued`   escalation fired, waiting for an agent to accept
 * `assigned` a human owns it; the bot is muted
 * `resolved` closed
 */
export const conversationStatusSchema = z.enum([
  "ai",
  "queued",
  "assigned",
  "resolved",
]);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const urgencySchema = z.enum(["low", "normal", "high"]);
export type Urgency = z.infer<typeof urgencySchema>;

export const conversationSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  endUserId: z.string(),
  status: conversationStatusSchema,
  assignedAgentId: z.string().nullable(),
  channel: z.enum(["web", "mobile", "api"]),
  subject: z.string().nullable(),
  tags: z.array(z.string()),
  /** Highest message seq issued for this conversation. Drives resume. */
  lastSeq: z.number().int().nonnegative(),
  lastMessageAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;
