/**
 * Branded id types.
 *
 * These are strings at runtime. The brand exists so that passing a
 * ConversationId where a MessageId is expected is a compile error, which is a
 * mistake that is otherwise silent and very hard to spot in a system where
 * nearly every function takes three ids.
 */
declare const brand: unique symbol;

type Branded<T extends string> = string & { readonly [brand]: T };

export type TenantId = Branded<"tenant">;
export type EndUserId = Branded<"end_user">;
export type AgentId = Branded<"agent">;
export type ConversationId = Branded<"conversation">;
export type MessageId = Branded<"message">;
export type EventId = Branded<"event">;
export type DocumentId = Branded<"document">;
export type ChunkId = Branded<"chunk">;
export type AttachmentId = Branded<"attachment">;
export type OutboxId = Branded<"outbox">;
export type FrameId = Branded<"frame">;
export type ToolCallId = Branded<"tool_call">;

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

let lastTime = 0;
let counter = 0;

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/**
 * Time-sortable id: base36 millisecond timestamp, a per-millisecond counter,
 * then randomness.
 *
 * Lexicographic order matches creation order, which is what makes these usable
 * directly as pagination cursors and as a stable tiebreak for messages created
 * inside the same millisecond.
 */
export function newId<T extends string>(prefix: T): string {
  const now = Date.now();
  if (now === lastTime) {
    counter += 1;
  } else {
    lastTime = now;
    counter = 0;
  }
  const time = now.toString(36).padStart(9, "0");
  const seq = counter.toString(36).padStart(3, "0");
  return `${prefix}_${time}${seq}${randomSuffix(8)}`;
}

export const newTenantId = () => newId("ten") as TenantId;
export const newEndUserId = () => newId("usr") as EndUserId;
export const newAgentId = () => newId("agt") as AgentId;
export const newConversationId = () => newId("cnv") as ConversationId;
export const newMessageId = () => newId("msg") as MessageId;
export const newEventId = () => newId("evt") as EventId;
export const newDocumentId = () => newId("doc") as DocumentId;
export const newChunkId = () => newId("chk") as ChunkId;
export const newAttachmentId = () => newId("att") as AttachmentId;
export const newOutboxId = () => newId("obx") as OutboxId;
export const newFrameId = () => newId("frm") as FrameId;
export const newToolCallId = () => newId("tlc") as ToolCallId;

/** Cast a trusted string (from the database, or a validated frame) to a branded id. */
export function asId<T extends string>(value: string): Branded<T> {
  return value as Branded<T>;
}
