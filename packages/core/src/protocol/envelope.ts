import { z } from "zod";

/**
 * Wire protocol version.
 *
 * Every frame carries this. Versioning is a field rather than a transport
 * concern so that a breaking protocol change is a negotiation at connect time
 * instead of a migration, and so the same frames survive moving off socket.io
 * to SSE, plain WebSocket, or HTTP long-poll without touching the client.
 */
export const PROTOCOL_VERSION = 1;

export interface Envelope<TType extends string = string, TPayload = unknown> {
  /** Protocol version. */
  v: number;
  /** Discriminator. One zod schema validates every inbound frame from this. */
  type: TType;
  /** Sender-generated frame id, used for correlating errors and acks. */
  id: string;
  /** Sender clock, epoch milliseconds. Advisory only; never trusted for ordering. */
  ts: number;
  payload: TPayload;
}

/** Build the envelope schema for one frame type. */
export function frame<TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) {
  return z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal(type),
    id: z.string().min(1).max(64),
    ts: z.number().int().nonnegative(),
    payload,
  });
}

export function envelope<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  id: string,
): Envelope<TType, TPayload> {
  return { v: PROTOCOL_VERSION, type, id, ts: Date.now(), payload };
}

export type DecodeResult<T> =
  | { ok: true; frame: T }
  | { ok: false; code: "unsupported_protocol_version" | "malformed_frame"; message: string; frameId: string | null };

/**
 * Parse an untrusted inbound frame.
 *
 * Returns a result rather than throwing. Frames arrive from browsers we do not
 * control, so a malformed one is an expected condition to answer with an error
 * frame, not an exception to unwind the connection handler.
 */
export function decodeFrame<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): DecodeResult<T> {
  const frameId =
    typeof raw === "object" && raw !== null && typeof (raw as { id?: unknown }).id === "string"
      ? ((raw as { id: string }).id)
      : null;

  // Version is checked before shape so that a future client gets a useful
  // answer instead of a wall of schema errors about fields it did not send.
  if (typeof raw === "object" && raw !== null) {
    const version = (raw as { v?: unknown }).v;
    if (typeof version === "number" && version !== PROTOCOL_VERSION) {
      return {
        ok: false,
        code: "unsupported_protocol_version",
        message: `Protocol version ${version} is not supported; this server speaks ${PROTOCOL_VERSION}.`,
        frameId,
      };
    }
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "malformed_frame",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
      frameId,
    };
  }
  return { ok: true, frame: parsed.data };
}
