import { z } from "zod";

export const errorCodeSchema = z.enum([
  "unsupported_protocol_version",
  "malformed_frame",
  "unauthenticated",
  "forbidden",
  "identity_signature_invalid",
  "conversation_not_found",
  "conversation_closed",
  "rate_limited",
  "tool_not_found",
  "tool_denied",
  "tool_failed",
  "provider_unavailable",
  "provider_incapable",
  "internal",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const wireErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  /** Whether the sender should retry the same frame. */
  retryable: z.boolean(),
  /** The frame this error responds to, when it was parseable enough to tell. */
  frameId: z.string().nullable(),
});
export type WireError = z.infer<typeof wireErrorSchema>;

export class SupportChatError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "SupportChatError";
    this.code = code;
    this.retryable = retryable;
  }

  toWire(frameId: string | null = null): WireError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      frameId,
    };
  }
}
