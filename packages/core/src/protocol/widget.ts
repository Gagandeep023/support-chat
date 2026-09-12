import { z } from "zod";
import { frame } from "./envelope.js";
import { conversationSchema, conversationStatusSchema } from "../domain/conversation.js";
import { messageSchema } from "../domain/message.js";
import { agentPublicSchema } from "../domain/actor.js";
import { wireErrorSchema } from "../errors.js";

/* ------------------------------------------------------------------ *
 * Widget -> server
 * ------------------------------------------------------------------ */

export const widgetToServerSchema = z.discriminatedUnion("type", [
  frame(
    "session.start",
    z.object({
      /** Reopen an existing conversation, or omit to create one. */
      conversationId: z.string().optional(),
      locale: z.string().max(35).optional(),
    }),
  ),
  /**
   * Reconnect. The client sends the highest seq it has rendered and the server
   * replays the gap. This is the whole reason no session state lives in the
   * socket process: a pod can die at any moment and lose nothing.
   */
  frame(
    "session.resume",
    z.object({
      conversationId: z.string(),
      lastSeq: z.number().int().nonnegative(),
    }),
  ),
  frame(
    "message.send",
    z.object({
      conversationId: z.string(),
      /** Unique per conversation. Makes retries after a reconnect idempotent. */
      clientMessageId: z.string().min(1).max(64),
      body: z.string().min(1).max(8000),
    }),
  ),
  frame("typing.set", z.object({ conversationId: z.string(), typing: z.boolean() })),
  frame(
    "handoff.request",
    z.object({ conversationId: z.string(), reason: z.string().max(500).optional() }),
  ),
  frame(
    "tool.decision",
    z.object({
      conversationId: z.string(),
      toolCallId: z.string(),
      approved: z.boolean(),
    }),
  ),
]);
export type WidgetToServer = z.infer<typeof widgetToServerSchema>;

/* ------------------------------------------------------------------ *
 * Server -> widget
 * ------------------------------------------------------------------ */

export const serverToWidgetSchema = z.discriminatedUnion("type", [
  frame(
    "session.ready",
    z.object({
      conversation: conversationSchema,
      /**
       * The replay gap only. Empty when the client was already current, which
       * is the common case on reconnect and keeps a reconnect storm cheap.
       */
      messages: z.array(messageSchema),
      agent: agentPublicSchema.nullable(),
      resumed: z.boolean(),
    }),
  ),
  frame(
    "message.ack",
    z.object({
      clientMessageId: z.string(),
      messageId: z.string(),
      seq: z.number().int().positive(),
    }),
  ),
  frame(
    "message.delta",
    z.object({ messageId: z.string(), text: z.string() }),
  ),
  frame("message.complete", z.object({ message: messageSchema })),
  frame("message.new", z.object({ message: messageSchema })),
  frame(
    "conversation.status",
    z.object({
      conversationId: z.string(),
      status: conversationStatusSchema,
      agent: agentPublicSchema.nullable(),
      /** Position in the handoff queue, when queued. */
      queuePosition: z.number().int().positive().nullable(),
    }),
  ),
  frame(
    "typing",
    z.object({
      conversationId: z.string(),
      actor: z.enum(["ai", "agent"]),
      typing: z.boolean(),
    }),
  ),
  frame(
    "tool.decision.request",
    z.object({
      conversationId: z.string(),
      toolCallId: z.string(),
      name: z.string(),
      /** Shown to the user, e.g. "Stop charging at Bay 3?" */
      prompt: z.string(),
      expiresAt: z.string().datetime(),
    }),
  ),
  /**
   * Graceful shutdown notice.
   *
   * Sent before a pod stops accepting work during a deploy. The client waits
   * `reconnectAfterMs` (already jittered per client by the server) and then
   * reconnects. Without this every client reconnects the instant the socket
   * drops, and a rolling deploy turns into a self-inflicted denial of service.
   */
  frame(
    "server.draining",
    z.object({
      reconnectAfterMs: z.number().int().nonnegative(),
      reason: z.enum(["deploy", "shutdown", "rebalance"]),
    }),
  ),
  frame("error", wireErrorSchema),
]);
export type ServerToWidget = z.infer<typeof serverToWidgetSchema>;
