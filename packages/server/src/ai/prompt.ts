import type {
  CompletionMessage,
  Message,
  RetrievedChunk,
} from "@gagandeep023/support-chat-core";

export interface PromptOptions {
  /** Tenant persona and product instructions. Must be stable across requests. */
  tenantSystemPrompt?: string;
  /** Conversation memory budget, in characters. */
  historyBudgetChars?: number;
  maxHistoryMessages?: number;
}

export interface AssembledPrompt {
  system: string;
  messages: CompletionMessage[];
  /**
   * Retrieved context, deliberately NOT folded into `system`. Adapters render it
   * after the cache breakpoint.
   */
  context: RetrievedChunk[];
}

/**
 * Grounding rules.
 *
 * Phrased to cover both the grounded and ungrounded case in constant text. That
 * is not stylistic: making these instructions conditional on whether retrieval
 * succeeded would change the system prefix from request to request, and caching
 * is a prefix match, so the cache would never be read. Anything that varies per
 * turn has to live after the breakpoint.
 */
const GROUNDING_RULES = `You are a customer support assistant.

Rules you must follow:
- Answer only from the reference material provided in the user's message.
- If the reference material does not contain the answer, say plainly that you do not
  know and offer to bring in a human colleague. Never guess, and never fill a gap with
  a plausible-sounding policy, price, timeframe, or procedure.
- If no reference material is provided at all, you do not know. Say so.
- Cite the source title when you use one.
- Be brief. Two or three sentences is usually right.
- Never claim to have taken an action. You can only provide information.`;

const CONTEXT_HEADER = "Reference material:";
const NO_CONTEXT = "Reference material: (none found for this question)";

export function buildSystemPrompt(options: PromptOptions = {}): string {
  return options.tenantSystemPrompt
    ? `${GROUNDING_RULES}\n\nAbout this product:\n${options.tenantSystemPrompt}`
    : GROUNDING_RULES;
}

export function renderContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return NO_CONTEXT;
  const rendered = chunks
    .map((chunk, index) => {
      const source = chunk.documentUrl
        ? `${chunk.documentTitle} (${chunk.documentUrl})`
        : chunk.documentTitle;
      return `[${index + 1}] ${source}\n${chunk.text}`;
    })
    .join("\n\n");
  return `${CONTEXT_HEADER}\n${rendered}`;
}

export function assemblePrompt(input: {
  history: Message[];
  question: string;
  context: RetrievedChunk[];
  options?: PromptOptions;
}): AssembledPrompt {
  const options = input.options ?? {};
  const budget = options.historyBudgetChars ?? 6000;
  const maxMessages = options.maxHistoryMessages ?? 20;

  // Last N with a character budget, walked backwards so the most recent turns
  // survive. Support conversations are short; a rolling summary would add a
  // model call per turn to solve a problem this workload does not have.
  const history: CompletionMessage[] = [];
  let used = 0;
  for (const message of [...input.history].reverse()) {
    if (history.length >= maxMessages) break;
    const body = message.body;
    if (!body || message.senderType === "system") continue;
    if (used + body.length > budget) break;
    used += body.length;
    history.unshift({
      role: message.senderType === "user" ? "user" : "assistant",
      content: body,
    });
  }

  return {
    system: buildSystemPrompt(options),
    // The question only. Retrieved context is handed to the adapter separately
    // and rendered by it, because where it lands in the request is a
    // provider-specific caching decision, not a prompt-building one.
    messages: [...history, { role: "user", content: input.question }],
    context: input.context,
  };
}
