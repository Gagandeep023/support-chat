import { z } from "zod";
import { urgencySchema } from "./conversation.js";

/**
 * Audit trail. Every status transition and every tool call writes one of these.
 *
 * This is what makes escalation thresholds tunable against real data instead of
 * by guesswork, and what lets a customer show, during a billing dispute, exactly
 * what the bot looked at and what it said.
 */
export const conversationEventTypeSchema = z.enum([
  "conversation.created",
  "escalation.triggered",
  "handoff.queued",
  "handoff.offered",
  "handoff.offer_expired",
  "handoff.assigned",
  "handoff.no_agents",
  "conversation.resolved",
  "tool.called",
  "tool.denied",
  "diagnosis.produced",
  "encryption.skipped",
]);
export type ConversationEventType = z.infer<typeof conversationEventTypeSchema>;

export const escalationTriggerSchema = z.enum([
  "user_request",
  "detector",
  "low_confidence",
  "rule",
  "agent_manual",
]);
export type EscalationTrigger = z.infer<typeof escalationTriggerSchema>;

export const conversationEventSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  tenantId: z.string(),
  type: conversationEventTypeSchema,
  actor: z.object({
    type: z.enum(["user", "ai", "agent", "system"]),
    id: z.string().nullable(),
  }),
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type ConversationEvent = z.infer<typeof conversationEventSchema>;

/**
 * Verdict from the escalation detector.
 *
 * Deliberately a separate step rather than a tool the model calls mid-answer:
 * tool calling is the least portable capability across models, and a missed tool
 * call fails silently, leaving the user talking to a bot that should have handed
 * off. See DESIGN.md section 8.
 */
export const escalationVerdictSchema = z.object({
  escalate: z.boolean(),
  trigger: escalationTriggerSchema,
  reason: z.string(),
  /** Handed to the receiving human agent verbatim. */
  summary: z.string(),
  urgency: urgencySchema,
});
export type EscalationVerdict = z.infer<typeof escalationVerdictSchema>;
