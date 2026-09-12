import type { Diagnosis } from "@gagandeep023/support-chat-core";

export interface DiagnosticRule<TFacts> {
  code: string;
  /** First match wins, so order is the priority. */
  when(facts: TFacts): boolean;
  confidence?: Diagnosis["confidence"];
  resolution?: Diagnosis["resolution"];
  /** One line for the human agent who picks this up. */
  summary(facts: TFacts): string;
  evidence?(facts: TFacts): Diagnosis["evidence"];
  userFacingHint?: string;
}

export interface DiagnosticDefinition<TFacts> {
  /** Gather whatever the rules need. The only place that touches the host's systems. */
  gather(): Promise<TFacts>;
  rules: DiagnosticRule<TFacts>[];
  /** Used when no rule matches. Must route to a human. */
  fallback?: Partial<Pick<Diagnosis, "code" | "summary">>;
}

/**
 * Run an ordered set of checks against facts gathered from the host's systems.
 *
 * The rules live in code, not in a prompt, and that is the central decision of
 * this whole feature. Diagnosing a stopped session is deterministic: an OCPP
 * `StopTransaction` with reason `EVDisconnected` means the cable was unplugged,
 * `PowerLoss` means the site lost supply. That is a lookup table, and putting it
 * in a prompt turns a testable mapping into a probabilistic one that fails
 * silently and unreproducibly. A wrong diagnosis on a billing dispute costs a
 * refund and a trust problem.
 *
 * The model's job is the other half: understanding a vague complaint, choosing
 * which diagnostic to run, and turning this verdict into a sentence in the
 * customer's own words.
 */
export async function runDiagnostic<TFacts>(
  definition: DiagnosticDefinition<TFacts>,
): Promise<Diagnosis> {
  const facts = await definition.gather();

  for (const rule of definition.rules) {
    if (!rule.when(facts)) continue;
    return {
      code: rule.code,
      confidence: rule.confidence ?? "certain",
      summary: rule.summary(facts),
      evidence: rule.evidence?.(facts) ?? [],
      resolution: rule.resolution ?? "self_serve",
      ...(rule.userFacingHint ? { userFacingHint: rule.userFacingHint } : {}),
    };
  }

  // No rule matched. Unknown routes to a human rather than letting the model
  // improvise a cause, because a speculative "your charger probably had a
  // network issue" is a factual claim about the customer's infrastructure, made
  // to their user, in a conversation that may end up attached to a dispute.
  return {
    code: definition.fallback?.code ?? "UNKNOWN",
    confidence: "unknown",
    summary:
      definition.fallback?.summary ??
      "No rule matched. A person needs to look at this one.",
    evidence: [],
    resolution: "escalate",
  };
}

/**
 * Render a verdict for the model.
 *
 * Deliberately explicit about what the model may and may not say. Without the
 * constraint it fills gaps with plausible-sounding causes, and a diagnosis is
 * exactly the place where that is most expensive.
 */
export function renderDiagnosis(diagnosis: Diagnosis): string {
  const lines = [
    `Diagnosis: ${diagnosis.code}`,
    `Confidence: ${diagnosis.confidence}`,
    `Summary: ${diagnosis.summary}`,
  ];
  if (diagnosis.evidence.length > 0) {
    lines.push("Evidence:");
    for (const item of diagnosis.evidence) {
      lines.push(`- ${item.label}: ${item.value}${item.at ? ` (at ${item.at})` : ""}`);
    }
  }
  if (diagnosis.userFacingHint) lines.push(`Required phrasing: ${diagnosis.userFacingHint}`);
  lines.push(
    "",
    "State only what this diagnosis says. Do not offer any other possible cause, and do " +
      "not speculate about the customer's equipment, network, or account. If the " +
      "confidence is unknown, say you are not sure and that a colleague is taking over.",
  );
  return lines.join("\n");
}
