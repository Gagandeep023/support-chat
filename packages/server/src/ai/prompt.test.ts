import { describe, expect, it } from "vitest";
import type { Message, RetrievedChunk } from "@gagandeep023/support-chat-core";
import { assemblePrompt, buildSystemPrompt, renderContext } from "./prompt.js";
import { buildAnthropicRequest } from "../providers/anthropic-chat-provider.js";

const SECRET_TEXT = "Refunds are issued within 14 working days.";

const chunk = (text: string): RetrievedChunk => ({
  id: "chk_1",
  documentId: "doc_1",
  tenantId: "ten_1",
  ordinal: 0,
  text,
  headingPath: ["Billing", "Refunds"],
  embeddingModel: "test",
  tokenCount: 10,
  score: 0.9,
  documentTitle: "Billing",
  documentUrl: "https://docs.example.com/billing",
});

const message = (senderType: Message["senderType"], body: string): Message => ({
  id: `msg_${body}`,
  conversationId: "cnv_1",
  tenantId: "ten_1",
  seq: 1,
  senderType,
  senderId: null,
  body,
  bodyEncrypted: null,
  contentType: "text/plain",
  clientMessageId: null,
  metadata: {},
  createdAt: new Date().toISOString(),
});

describe("prompt assembly", () => {
  it("keeps retrieved chunks out of the system prompt", () => {
    // The rule that pays for itself on every request: the system prefix is
    // identical across requests and therefore cacheable, and retrieved chunks
    // are not. Folding them in changes the prefix every turn, and since caching
    // is a prefix match, nothing is ever read back.
    const prompt = assemblePrompt({
      history: [],
      question: "when do I get my refund?",
      context: [chunk(SECRET_TEXT)],
    });
    expect(prompt.system).not.toContain(SECRET_TEXT);
    expect(prompt.context).toHaveLength(1);
  });

  it("produces an identical system prefix regardless of what was retrieved", () => {
    const a = assemblePrompt({ history: [], question: "q1", context: [chunk("alpha")] });
    const b = assemblePrompt({ history: [], question: "q2", context: [] });
    expect(a.system).toBe(b.system);
  });

  it("instructs the model to refuse when nothing was retrieved", () => {
    expect(renderContext([])).toContain("none found");
    expect(buildSystemPrompt()).toMatch(/do not know/i);
  });

  it("keeps the most recent history within the budget", () => {
    const history = [
      message("user", "oldest"),
      message("ai", "middle"),
      message("user", "newest"),
    ];
    const prompt = assemblePrompt({
      history,
      question: "now what",
      context: [],
      options: { historyBudgetChars: 12 },
    });
    const contents = prompt.messages.map((m) => m.content);
    expect(contents).toContain("newest");
    expect(contents).not.toContain("oldest");
  });

  it("maps sender types to chat roles", () => {
    const prompt = assemblePrompt({
      history: [message("user", "hi"), message("ai", "hello"), message("agent", "here")],
      question: "q",
      context: [],
    });
    expect(prompt.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
  });
});

describe("anthropic request shape", () => {
  const request = {
    ...assemblePrompt({
      history: [],
      question: "when do I get my refund?",
      context: [chunk(SECRET_TEXT)],
    }),
    maxOutputTokens: 1024,
    quality: "fast" as const,
  };

  it("places the cache breakpoint on the system block", () => {
    const body = buildAnthropicRequest(request, {
      model: "claude-sonnet-5",
      maxOutputTokens: 1024,
    });
    expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("renders context into the user turn, after the breakpoint", () => {
    // Automatic caching would put the breakpoint after this volatile tail, so
    // every request would pay the cache-write premium on bytes never read back.
    const body = buildAnthropicRequest(request, {
      model: "claude-sonnet-5",
      maxOutputTokens: 1024,
    });
    expect(body.system[0]?.text).not.toContain(SECRET_TEXT);
    expect(body.messages.at(-1)?.content).toContain(SECRET_TEXT);
    expect(body.messages.at(-1)?.content).toContain("when do I get my refund?");
  });

  it("leaves thinking on at low effort for chat", () => {
    const body = buildAnthropicRequest(request, {
      model: "claude-sonnet-5",
      maxOutputTokens: 1024,
    });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config.effort).toBe("low");
  });
});
