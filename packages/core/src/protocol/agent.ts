import { z } from "zod";
import { frame } from "./envelope.js";
import { conversationSchema, urgencySchema } from "../domain/conversation.js";
import { messageSchema } from "../domain/message.js";
import { agentSchema, agentStatusSchema } from "../domain/actor.js";
import { diagnosisSchema } from "../providers/diagnosis.js";
import { wireErrorSchema } from "../errors.js";

/* ------------------------------------------------------------------ *
 * Agent console -> server
 * ------------------------------------------------------------------ */

export const agentToServerSchema = z.discriminatedUnion("type", [
  /** First frame after connecting with a host-signed JWT. */
  frame(
    "agent.hello",
    z.object({
      skills: z.array(z.string()).optional(),
      maxConcurrent: z.number().int().positive().max(50).optional(),
    }),
  ),
  /**
   * Liveness. Presence is a heartbeat with a TTL rather than "is the socket
   * connected", because agents leave laptops open on locked screens and socket
   * liveness would route conversations to them.
   */
  frame("agent.heartbeat", z.object({ status: agentStatusSchema })),
  frame(
    "agent.offer.respond",
    z.object({ conversationId: z.string(), accept: z.boolean() }),
  ),
  frame(
    "agent.message.send",
    z.object({
      conversationId: z.string(),
      clientMessageId: z.string().min(1).max(64),
      body: z.string().min(1).max(8000),
    }),
  ),
  frame(
    "agent.conversation.resolve",
    z.object({
      conversationId: z.string(),
      note: z.string().max(2000).optional(),
      /**
       * Promote this resolution into the knowledge base. Always a human
       * decision: ingesting every resolved conversation teaches the bot every
       * wrong answer an agent ever gave, permanently and confidently.
       *
       * Optional rather than defaulted, because a wire schema must validate and
       * never transform. A schema with a default makes the decoded frame a
       * different shape from the encoded one, so the two ends of the connection
       * quietly disagree about the protocol.
       */
      promoteToKnowledge: z.boolean().optional(),
    }),
  ),
  frame("agent.conversation.subscribe", z.object({ conversationId: z.string() })),
  frame("agent.conversation.release", z.object({ conversationId: z.string() })),
]);
export type AgentToServer = z.infer<typeof agentToServerSchema>;

/* ------------------------------------------------------------------ *
 * Server -> agent console
 * ------------------------------------------------------------------ */

export const serverToAgentSchema = z.discriminatedUnion("type", [
  frame(
    "agent.ready",
    z.object({
      agent: agentSchema,
      assigned: z.array(conversationSchema),
      queueDepth: z.number().int().nonnegative(),
    }),
  ),
  /**
   * A routed conversation, offered with a deadline. Without the deadline a
   * conversation rots on an agent who walked away while the user waits in a
   * queue of one.
   */
  frame(
    "agent.offer",
    z.object({
      conversationId: z.string(),
      summary: z.string(),
      urgency: urgencySchema,
      /** Present when a host diagnostic ran; the agent opens already knowing the cause. */
      diagnosis: diagnosisSchema.nullable(),
      waitingSince: z.string().datetime(),
      expiresAt: z.string().datetime(),
    }),
  ),
  frame(
    "agent.offer.revoked",
    z.object({
      conversationId: z.string(),
      reason: z.enum(["expired", "taken", "resolved", "cancelled"]),
    }),
  ),
  frame(
    "agent.conversation.assigned",
    z.object({
      conversation: conversationSchema,
      /** Full transcript including everything the bot already tried. */
      messages: z.array(messageSchema),
      diagnosis: diagnosisSchema.nullable(),
    }),
  ),
  frame("message.new", z.object({ message: messageSchema })),
  frame(
    "queue.update",
    z.object({
      depth: z.number().int().nonnegative(),
      oldestWaitingSince: z.string().datetime().nullable(),
    }),
  ),
  frame(
    "server.draining",
    z.object({
      reconnectAfterMs: z.number().int().nonnegative(),
      reason: z.enum(["deploy", "shutdown", "rebalance"]),
    }),
  ),
  frame("error", wireErrorSchema),
]);
export type ServerToAgent = z.infer<typeof serverToAgentSchema>;
