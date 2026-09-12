import { describe, expect, it, vi } from "vitest";
import type {
  ChatProvider,
  CompletionDelta,
  CompletionRequest,
  Conversation,
  ProviderCapabilities,
} from "@gagandeep023/support-chat-core";
import { MemoryCacheStore } from "../adapters/memory-cache-store.js";
import { MemoryDataStore } from "../adapters/memory-data-store.js";
import { ConversationService } from "../services/conversation-service.js";
import { EscalationDetector } from "../ai/escalation-detector.js";
import { Responder, type ResponseSink } from "../ai/responder.js";
import { Retriever } from "../ai/retriever.js";
import { KeywordIndex } from "../ai/keyword-index.js";
import { ToolRegistry } from "./registry.js";
import { ToolExecutor } from "./executor.js";
import { runDiagnostic } from "./diagnostics.js";

/** A model that calls one tool, then answers from its result. */
class ToolCallingProvider implements ChatProvider {
  readonly id = "tool-calling";
  readonly model = "test";
  readonly capabilities: ProviderCapabilities = {
    toolCalling: "native",
    explicitCaching: false,
    systemRole: true,
    streaming: true,
    maxContextTokens: 100_000,
    maxOutputTokens: 4096,
  };
  readonly requests: CompletionRequest[] = [];
  private round = 0;

  constructor(private readonly toolName: string) {}

  async *complete(request: CompletionRequest): AsyncIterable<CompletionDelta> {
    this.requests.push(request);
    // The escalation detector shares this provider; it offers no tools.
    if (!request.tools?.length) {
      yield { type: "text", text: '{"escalate": false, "reason": "answered"}' };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }
    if (this.round++ === 0) {
      yield { type: "tool_call", id: "tc_1", name: this.toolName, input: { sessionId: "s1" } };
      yield { type: "done", stopReason: "tool_use" };
      return;
    }
    const toolTurn = request.messages.find((m) => m.role === "tool");
    const sawDiagnosis =
      toolTurn && "content" in toolTurn && toolTurn.content.includes("STOPPED_EV_DISCONNECTED");
    yield {
      type: "text",
      text: sawDiagnosis
        ? "It looks like the cable came loose at the car. Plug it back in and start again."
        : "I could not find out what happened.",
    };
    yield { type: "done", stopReason: "end_turn" };
  }
}

class RecordingSink implements ResponseSink {
  deltas: string[] = [];
  completed: string[] = [];
  statuses: string[] = [];
  delta(_c: string, _m: string, text: string) {
    this.deltas.push(text);
  }
  complete(_c: string, message: { body: string | null }) {
    this.completed.push(message.body ?? "");
  }
  typing() {}
  status(conversation: Conversation) {
    this.statuses.push(conversation.status);
  }
}

async function scenario(stopReason: string) {
  const data = new MemoryDataStore();
  const cache = new MemoryCacheStore();
  const tenant = data.seedTenant({
    id: "ten_1", name: "Acme", publishableKey: "pk", settings: {},
    createdAt: new Date().toISOString(),
  });
  const user = await data.upsertEndUser({ tenantId: tenant.id, externalId: "ext-42" });
  const conversation = await data.createConversation({
    tenantId: tenant.id, endUserId: user.id, channel: "web",
  });
  const message = await data.appendMessage({
    conversationId: conversation.id, tenantId: tenant.id,
    senderType: "user", senderId: user.id, body: "my charging stopped and I was still charged",
  });

  const registry = new ToolRegistry();
  const gather = vi.fn(async () => ({ stopReason }));
  registry.register({
    name: "diagnose_charging_session",
    description: "Find out what happened to a charging session.",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, additionalProperties: false },
    access: "read",
    handler: async () =>
      runDiagnostic({
        gather,
        rules: [
          {
            code: "STOPPED_EV_DISCONNECTED",
            when: (f: { stopReason: string }) => f.stopReason === "EVDisconnected",
            summary: () => "The cable was unplugged at the vehicle end.",
            evidence: (f) => [{ label: "Stop reason", value: f.stopReason }],
            resolution: "self_serve",
          },
        ],
      }),
  });

  const provider = new ToolCallingProvider("diagnose_charging_session");
  const sink = new RecordingSink();
  const conversations = new ConversationService(data, cache);
  const responder = new Responder({
    data,
    conversations,
    chat: provider,
    retriever: new Retriever(null, new KeywordIndex(), null),
    detector: new EscalationDetector(provider),
    sink,
    tools: registry,
    executor: new ToolExecutor({
      registry, data, confirmations: { request: () => undefined },
    }),
  });

  await responder.respond({
    tenantId: tenant.id, conversationId: conversation.id, messageId: message.id,
  });
  return { data, conversation, sink, provider };
}

describe("diagnostics end to end", () => {
  it("calls the diagnostic, then answers from its verdict", async () => {
    const { sink, provider } = await scenario("EVDisconnected");
    expect(provider.requests[0]?.tools?.[0]?.name).toBe("diagnose_charging_session");
    expect(sink.completed[0]).toContain("cable came loose");
  });

  it("records the diagnosis for audit", async () => {
    const { data, conversation } = await scenario("EVDisconnected");
    const events = await data.listEvents(conversation.id);
    expect(events.map((e) => e.type)).toContain("diagnosis.produced");
    const produced = events.find((e) => e.type === "diagnosis.produced");
    expect(produced?.payload).toMatchObject({ code: "STOPPED_EV_DISCONNECTED" });
  });

  it("audits the tool call itself", async () => {
    const { data, conversation } = await scenario("EVDisconnected");
    const called = (await data.listEvents(conversation.id)).find((e) => e.type === "tool.called");
    expect(called?.payload).toMatchObject({ name: "diagnose_charging_session", access: "read" });
  });

  it("escalates when no rule matches, overriding the classifier", async () => {
    // The classifier in this fake always says do not escalate. A deterministic
    // unknown has to win, or an undiagnosable problem quietly stays with the bot.
    const { data, conversation, sink } = await scenario("SomethingNobodyMapped");
    const stored = await data.getConversation("ten_1", conversation.id);
    expect(stored?.status).toBe("queued");
    expect(sink.statuses).toContain("queued");

    const escalation = (await data.listEvents(conversation.id)).find(
      (e) => e.type === "escalation.triggered",
    );
    // The offer the agent receives carries the verdict, so they open already
    // knowing what the bot checked.
    expect(escalation?.payload).toMatchObject({ trigger: "rule" });
    expect((escalation?.payload as { diagnosis?: { code: string } }).diagnosis?.code).toBe("UNKNOWN");
  });
});
