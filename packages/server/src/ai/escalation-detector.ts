import type {
  ChatProvider,
  EscalationVerdict,
} from "@gagandeep023/support-chat-core";

export interface DetectorOptions {
  /** Consecutive ungrounded turns before escalating without asking a model. */
  ungroundedTurnsBeforeEscalation?: number;
  keywords?: string[];
}

const DEFAULT_KEYWORDS = [
  "speak to a human",
  "talk to a human",
  "real person",
  "customer service",
  "speak to an agent",
  "talk to someone",
  "this is useless",
];

const CLASSIFIER_SYSTEM = `You decide whether a customer support conversation needs a human.

Answer with a single JSON object and nothing else:
{"escalate": boolean, "reason": string, "summary": string, "urgency": "low"|"normal"|"high"}

Escalate when: the user asks for a person, the assistant could not answer, the request
needs an account change or an action the assistant cannot take, the user is angry, or
money is in dispute. Do not escalate a question that was answered.

"summary" is read by the human who picks this up. Write what they need to know.`;

/**
 * Escalation as a separate step, not a tool the model calls mid-answer.
 *
 * Two reasons. Tool calling is the least portable capability across models, and
 * this system is meant to run on whichever one the customer picks. And a missed
 * tool call fails silently: the turn succeeds, handoff never fires, and the user
 * keeps talking to a bot that should have handed off. A separate step has a real
 * implementation at every capability tier and is independently testable.
 */
export class EscalationDetector {
  private readonly threshold: number;
  private readonly keywords: string[];

  constructor(
    private readonly chat: ChatProvider,
    options: DetectorOptions = {},
  ) {
    this.threshold = options.ungroundedTurnsBeforeEscalation ?? 2;
    this.keywords = options.keywords ?? DEFAULT_KEYWORDS;
  }

  async detect(input: {
    question: string;
    answer: string;
    grounded: boolean;
    consecutiveUngrounded: number;
  }): Promise<EscalationVerdict> {
    // Deterministic checks first, and never overridden by the model. When
    // someone asks for a person, they get queued for a person.
    const lowered = input.question.toLowerCase();
    const matched = this.keywords.find((keyword) => lowered.includes(keyword));
    if (matched) {
      return {
        escalate: true,
        trigger: "rule",
        reason: `Matched phrase "${matched}".`,
        summary: `The customer asked for a person. Their question: ${input.question}`,
        urgency: "normal",
      };
    }

    if (!input.grounded && input.consecutiveUngrounded >= this.threshold) {
      return {
        escalate: true,
        trigger: "low_confidence",
        reason: `${input.consecutiveUngrounded} consecutive turns with no supporting material.`,
        summary: `The assistant could not find anything relevant. Latest question: ${input.question}`,
        urgency: "normal",
      };
    }

    return this.classify(input.question, input.answer);
  }

  private async classify(question: string, answer: string): Promise<EscalationVerdict> {
    const noEscalation: EscalationVerdict = {
      escalate: false,
      trigger: "detector",
      reason: "No escalation signal.",
      summary: "",
      urgency: "low",
    };

    if (this.chat.capabilities.toolCalling === "none" && !this.chat.capabilities.streaming) {
      return noEscalation;
    }

    let raw = "";
    try {
      for await (const delta of this.chat.complete({
        system: CLASSIFIER_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Customer: ${question}\n\nAssistant replied: ${answer}`,
          },
        ],
        context: [],
        maxOutputTokens: 256,
        quality: "fast",
      })) {
        if (delta.type === "text") raw += delta.text;
      }
    } catch {
      // A classifier failure must not swallow the conversation. Failing closed
      // here would mean a provider blip silently disables handoff.
      return noEscalation;
    }

    return parseVerdict(raw) ?? noEscalation;
  }
}

export function parseVerdict(raw: string): EscalationVerdict | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.escalate !== "boolean") return null;
    const urgency = parsed.urgency;
    return {
      escalate: parsed.escalate,
      trigger: "detector",
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      urgency:
        urgency === "low" || urgency === "normal" || urgency === "high"
          ? urgency
          : "normal",
    };
  } catch {
    return null;
  }
}
