import {
  newMessageId,
  type ChatProvider,
  type CompletionMessage,
  type Conversation,
  type Diagnosis,
  type EscalationVerdict,
  type Message,
  type ToolCall,
} from "@gagandeep023/support-chat-core";
import { renderDiagnosis } from "../tools/diagnostics.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { DataStore } from "../stores/data-store.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { Retriever } from "./retriever.js";
import type { EscalationDetector } from "./escalation-detector.js";
import { assemblePrompt, type PromptOptions } from "./prompt.js";

/**
 * Where streamed output goes.
 *
 * An interface rather than a direct socket dependency so the pipeline can be
 * driven and asserted without a network, and so the same responder works behind
 * SSE or a batch harness.
 */
export interface ResponseSink {
  delta(conversationId: string, messageId: string, text: string): void;
  complete(conversationId: string, message: Message): void;
  typing(conversationId: string, typing: boolean): void;
  status(conversation: Conversation, queuePosition: number | null): void;
}

export interface ResponderOptions extends PromptOptions {
  maxOutputTokens?: number;
  historyLimit?: number;
  /** Cap on tool round trips in one turn, so a loop cannot run away. */
  maxToolRounds?: number;
}

export class Responder {
  private readonly maxOutputTokens: number;
  private readonly historyLimit: number;
  private readonly maxToolRounds: number;
  /** Per conversation. Resets the moment anything is retrieved. */
  private readonly ungroundedStreak = new Map<string, number>();

  constructor(
    private readonly deps: {
      data: DataStore;
      conversations: ConversationService;
      chat: ChatProvider;
      retriever: Retriever;
      detector: EscalationDetector;
      sink: ResponseSink;
      tools?: ToolRegistry;
      executor?: ToolExecutor;
      /** Called after a conversation is queued, so routing can place it at once. */
      onEscalated?: (tenantId: string) => void;
    },
    private readonly options: ResponderOptions = {},
  ) {
    this.maxOutputTokens = options.maxOutputTokens ?? 1024;
    this.historyLimit = options.historyLimit ?? 20;
    this.maxToolRounds = options.maxToolRounds ?? 3;
  }

  /**
   * Whether host tools are offered on this turn.
   *
   * Gated on native tool calling. Escalation deliberately does not depend on
   * that capability so any model can run the core product; diagnostics does,
   * and offering tools to a model that cannot emit a tool_use block produces a
   * turn where the call is written into visible text and silently never runs.
   */
  private toolsAvailable(): boolean {
    return (
      this.deps.chat.capabilities.toolCalling === "native" &&
      (this.deps.tools?.size ?? 0) > 0 &&
      this.deps.executor !== undefined
    );
  }

  async respond(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
  }): Promise<void> {
    const conversation = await this.deps.data.getConversation(
      input.tenantId,
      input.conversationId,
    );
    if (!conversation) return;

    // A human owns this conversation. The bot stays quiet rather than talking
    // over the agent.
    if (conversation.status !== "ai") return;

    const history = await this.deps.data.listMessages(conversation.id, {
      limit: this.historyLimit,
    });
    const question = history.find((m) => m.id === input.messageId)?.body;
    if (!question) return;

    const retrieval = await this.deps.retriever.retrieve(input.tenantId, question);
    const streak = retrieval.grounded
      ? 0
      : (this.ungroundedStreak.get(conversation.id) ?? 0) + 1;
    this.ungroundedStreak.set(conversation.id, streak);

    const prompt = assemblePrompt({
      history: history.filter((m) => m.id !== input.messageId),
      question,
      context: retrieval.chunks,
      options: this.options,
    });

    // A provisional id so the widget can open a bubble and stream into it before
    // the message exists in the database.
    const streamId = newMessageId();
    this.deps.sink.typing(conversation.id, true);

    const useTools = this.toolsAvailable();
    const messages: CompletionMessage[] = [...prompt.messages];
    let answer = "";
    let diagnosis: Diagnosis | null = null;

    try {
      for (let round = 0; round <= this.maxToolRounds; round += 1) {
        const calls: ToolCall[] = [];
        let roundText = "";

        for await (const delta of this.deps.chat.complete({
          system: prompt.system,
          messages,
          context: prompt.context,
          maxOutputTokens: this.maxOutputTokens,
          quality: "fast",
          ...(useTools ? { tools: this.deps.tools?.definitions() ?? [] } : {}),
        })) {
          if (delta.type === "text" && delta.text) {
            roundText += delta.text;
            answer += delta.text;
            this.deps.sink.delta(conversation.id, streamId, delta.text);
          } else if (delta.type === "tool_call") {
            calls.push({ id: delta.id, name: delta.name, input: delta.input });
          }
        }

        if (calls.length === 0 || !useTools) break;

        // The final round offers no tools, so the model has to answer rather
        // than asking for another lookup and leaving the turn without a reply.
        messages.push({ role: "assistant", content: roundText, toolCalls: calls });

        for (const call of calls) {
          const result = await this.deps.executor!.execute(call, {
            tenantId: conversation.tenantId,
            conversationId: conversation.id,
            endUser: {
              id: conversation.endUserId,
              externalId: null,
              isAnonymous: true,
            },
          });
          const parsed = asDiagnosis(result.content);
          if (parsed) diagnosis = parsed;
          messages.push({
            role: "tool",
            toolCallId: result.toolCallId,
            name: result.name,
            // A diagnosis is rendered with its constraints attached, so the
            // model is told what it may and may not say in the same breath as
            // the verdict.
            content: parsed ? renderDiagnosis(parsed) : result.content,
            ...(result.isError ? { isError: true } : {}),
          });
        }

        if (round === this.maxToolRounds) break;
      }
    } catch {
      answer =
        "Sorry, I could not reach my assistant just now. Let me get a colleague to help.";
      await this.persistAndEscalate(
        conversation,
        question,
        answer,
        {
          escalate: true,
          trigger: "detector",
          reason: "The model provider was unavailable.",
          summary: `The assistant failed to respond. Customer asked: ${question}`,
          urgency: "normal",
        },
        streamId,
      );
      return;
    } finally {
      this.deps.sink.typing(conversation.id, false);
    }

    if (diagnosis) {
      await this.deps.data.appendEvent({
        conversationId: conversation.id,
        tenantId: conversation.tenantId,
        type: "diagnosis.produced",
        actor: { type: "ai", id: null },
        payload: { ...diagnosis },
      });
    }

    const verdict = await this.deps.detector.detect({
      question,
      answer,
      grounded: retrieval.grounded,
      consecutiveUngrounded: streak,
    });

    // A diagnosis that asks for a human overrides the detector. The rules are
    // deterministic and the classifier is not, so the deterministic one wins.
    const effective: EscalationVerdict =
      diagnosis && (diagnosis.resolution === "escalate" || diagnosis.resolution === "refund_due")
        ? {
            escalate: true,
            trigger: "rule",
            reason: `Diagnosis ${diagnosis.code} (${diagnosis.confidence}).`,
            summary: diagnosis.summary,
            urgency: diagnosis.resolution === "refund_due" ? "high" : "normal",
          }
        : verdict;

    await this.persistAndEscalate(conversation, question, answer, effective, streamId, diagnosis);
  }

  private async persistAndEscalate(
    conversation: Conversation,
    question: string,
    answer: string,
    verdict: EscalationVerdict,
    streamId?: string,
    diagnosis: Diagnosis | null = null,
  ): Promise<void> {
    const message = await this.deps.data.appendMessage({
      ...(streamId ? { id: streamId } : {}),
      conversationId: conversation.id,
      tenantId: conversation.tenantId,
      senderType: "ai",
      senderId: null,
      body: answer,
      metadata: { grounded: verdict.trigger !== "low_confidence" },
    });
    this.deps.sink.complete(conversation.id, message);

    if (!verdict.escalate) return;

    await this.deps.data.appendEvent({
      conversationId: conversation.id,
      tenantId: conversation.tenantId,
      type: "escalation.triggered",
      actor: { type: "ai", id: null },
      // The diagnosis rides along, so the offer the agent receives carries the
      // session id, the stop reason and the timeline rather than making the
      // customer repeat everything.
      payload: { ...verdict, question, ...(diagnosis ? { diagnosis } : {}) },
    });
    const queued = await this.deps.conversations.requestHandoff({
      tenantId: conversation.tenantId,
      conversationId: conversation.id,
      endUserId: conversation.endUserId,
      reason: verdict.reason,
    });
    const position = await this.deps.conversations.queuePosition(
      conversation.tenantId,
      conversation.id,
    );
    this.deps.sink.status(queued, position);
    this.ungroundedStreak.delete(conversation.id);
    this.deps.onEscalated?.(conversation.tenantId);
  }
}

/** A tool whose JSON output is a Diagnosis is treated as one. */
function asDiagnosis(content: string): Diagnosis | null {
  try {
    const parsed = JSON.parse(content) as Partial<Diagnosis>;
    if (
      typeof parsed.code === "string" &&
      typeof parsed.summary === "string" &&
      typeof parsed.confidence === "string" &&
      Array.isArray(parsed.evidence)
    ) {
      return parsed as Diagnosis;
    }
  } catch {
    // Not a diagnosis, just a tool result.
  }
  return null;
}
