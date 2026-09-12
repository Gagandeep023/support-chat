import { EscalationDetector } from "@gagandeep023/support-chat-server";
import type { ChatProvider } from "@gagandeep023/support-chat-core";
import { resolveChatProvider } from "../providers.js";
import { FAIL, PASS, WARN, dim, heading, line } from "../output.js";

export interface DoctorOptions {
  model?: string;
  /** Chunks retrieved per question, for the context budget check. */
  topK?: number;
}

interface Check {
  label: string;
  status: "pass" | "warn" | "fail";
  detail?: string;
}

/**
 * Preflight the configured model.
 *
 * "Use any model you like" is a liability without this. It hands the customer a
 * decision with no way to check the result, and the failures it catches are all
 * ones that would otherwise surface at two in the morning inside a real
 * customer conversation.
 */
export async function doctor(options: DoctorOptions = {}): Promise<number> {
  const { provider, description, simulated } = resolveChatProvider(
    options.model ? { model: options.model } : {},
  );
  const checks: Check[] = [];

  heading("support-chat doctor");
  console.log(dim(`  Checking ${description}\n`));

  checks.push(
    simulated
      ? {
          label: "Model configured",
          status: "warn",
          detail: "no key found; using a scripted stand-in",
        }
      : { label: "Model configured", status: "pass", detail: provider.model },
  );

  checks.push(await checkStreaming(provider));
  checks.push(await checkEscalationDetector(provider));
  checks.push(checkCapabilities(provider));
  checks.push(checkContextBudget(provider, options.topK ?? 8));

  for (const check of checks) {
    line(
      check.label,
      check.status === "pass" ? PASS : check.status === "warn" ? WARN : FAIL,
      check.detail,
    );
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  console.log(
    `\n  ${checks.length - failed - warned} passed, ${warned} warning${warned === 1 ? "" : "s"}, ${failed} failed\n`,
  );
  return failed > 0 ? 1 : 0;
}

async function checkStreaming(provider: ChatProvider): Promise<Check> {
  if (!provider.capabilities.streaming) {
    return {
      label: "Streams tokens",
      status: "fail",
      detail: "provider reports no streaming support",
    };
  }
  try {
    let text = "";
    let chunks = 0;
    for await (const delta of provider.complete({
      system: "Reply with exactly the word: ready",
      messages: [{ role: "user", content: "Say ready." }],
      context: [],
      maxOutputTokens: 16,
      quality: "fast",
    })) {
      if (delta.type === "text") {
        text += delta.text;
        chunks += 1;
      }
    }
    if (!text.trim()) {
      return { label: "Streams tokens", status: "fail", detail: "returned no text" };
    }
    return {
      label: "Streams tokens",
      status: "pass",
      detail: `${chunks} chunk${chunks === 1 ? "" : "s"}`,
    };
  } catch (error) {
    return {
      label: "Streams tokens",
      status: "fail",
      detail: error instanceof Error ? error.message : "request failed",
    };
  }
}

async function checkEscalationDetector(provider: ChatProvider): Promise<Check> {
  // The single most important capability check. If the detector cannot produce a
  // verdict this model can never hand off, and the failure is silent: the bot
  // simply keeps answering a customer who needed a person.
  try {
    const verdict = await new EscalationDetector(provider).detect({
      question: "you charged me twice and I want my money back",
      answer: "I am sorry about that.",
      grounded: true,
      consecutiveUngrounded: 0,
    });
    return {
      label: "Escalation detector returns a verdict",
      status: "pass",
      detail: verdict.escalate ? "would escalate" : "would not escalate",
    };
  } catch (error) {
    return {
      label: "Escalation detector returns a verdict",
      status: "fail",
      detail: error instanceof Error ? error.message : "failed",
    };
  }
}

function checkCapabilities(provider: ChatProvider): Check {
  const { toolCalling } = provider.capabilities;
  if (toolCalling === "native") {
    return { label: "Host tools and diagnostics", status: "pass", detail: "native tool calls" };
  }
  // Reported rather than failed. Escalation deliberately does not depend on tool
  // calling, so a model without it still runs the core product; only diagnostics
  // are unavailable.
  return {
    label: "Host tools and diagnostics",
    status: "warn",
    detail: `unavailable (tool calling: ${toolCalling})`,
  };
}

function checkContextBudget(provider: ChatProvider, topK: number): Check {
  // A rough budget: retrieved chunks plus history plus the system prompt.
  const estimated = topK * 500 + 2000;
  const window = provider.capabilities.maxContextTokens;
  if (estimated > window * 0.5) {
    return {
      label: "Context window fits retrieval",
      status: "fail",
      detail: `~${estimated} tokens against a ${window} window`,
    };
  }
  return {
    label: "Context window fits retrieval",
    status: "pass",
    detail: `~${estimated} of ${window} tokens`,
  };
}
