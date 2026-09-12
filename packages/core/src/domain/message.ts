import { z } from "zod";

export const senderTypeSchema = z.enum(["user", "ai", "agent", "system"]);
export type SenderType = z.infer<typeof senderTypeSchema>;

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  tenantId: z.string(),
  /**
   * Monotonic per conversation, assigned by the server. The client stores the
   * highest seq it has seen and replays from it on reconnect, which is why no
   * session state has to live in the socket process.
   */
  seq: z.number().int().positive(),
  senderType: senderTypeSchema,
  senderId: z.string().nullable(),
  /**
   * Plaintext body. Null when the tenant has encryption enabled, in which case
   * the ciphertext lives in `bodyEncrypted` and is decrypted on read.
   */
  body: z.string().nullable(),
  bodyEncrypted: z.string().nullable(),
  contentType: z.enum(["text/plain", "text/markdown"]),
  /** Client-supplied, unique per conversation. Makes sends idempotent. */
  clientMessageId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof messageSchema>;
