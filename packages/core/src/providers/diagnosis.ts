import { z } from "zod";

/**
 * The result of a host-supplied diagnostic.
 *
 * Structured, never prose. The rules that produce it live in the host's own
 * code so that every branch is a unit test with no model in the loop; the model
 * only turns this into a sentence. See DESIGN.md section 7B.1.
 */
export const diagnosisSchema = z.object({
  /** Stable machine code, e.g. "STOPPED_EV_DISCONNECTED". */
  code: z.string(),
  confidence: z.enum(["certain", "likely", "unknown"]),
  /** One line, written for the human agent rather than the end user. */
  summary: z.string(),
  evidence: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      at: z.string().datetime().optional(),
    }),
  ),
  resolution: z.enum([
    "self_serve",
    "retry",
    "contact_site",
    "escalate",
    "refund_due",
  ]),
  /** Optional phrasing constraint, for regulated or legally reviewed wording. */
  userFacingHint: z.string().optional(),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;

/** Read tools run immediately; act tools need explicit approval. */
export type ToolAccess = "read" | "act";

export interface ToolContext {
  tenantId: string;
  conversationId: string;
  /**
   * Injected by the framework from the authenticated widget identity. The model
   * never supplies this: a tool schema that accepts a user identifier is
   * rejected at registration time, because it would let any visitor read another
   * user's data by asking nicely. See DESIGN.md section 7B.2.
   */
  endUser: {
    id: string;
    externalId: string | null;
    isAnonymous: boolean;
  };
}

export interface RegisteredTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  access: ToolAccess;
  /** Human-readable summary shown in the confirmation prompt for act tools. */
  confirmationPrompt?: (input: TInput) => string;
  handler(input: TInput, ctx: ToolContext): Promise<TOutput>;
}
