import {
  SupportChatError,
  type ChatProvider,
  type CompletionDelta,
  type CompletionRequest,
  type ProviderCapabilities,
} from "@gagandeep023/support-chat-core";
import { renderContext } from "../ai/prompt.js";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxOutputTokens?: number;
  /**
   * Declared capabilities for this endpoint. Capability is a property of the
   * model behind the URL, not of the wire format, so it cannot be inferred here
   * and is not guessed.
   */
  capabilities?: Partial<ProviderCapabilities>;
  fetchImpl?: typeof fetch;
}

/**
 * One adapter for every OpenAI-compatible endpoint.
 *
 * Covers Moonshot (Kimi), Groq, Together, Fireworks, DeepInfra, OpenRouter,
 * vLLM, and Ollama in a single implementation, using fetch and no SDK. This is
 * what makes "run whatever model you like" true in practice rather than in
 * principle: the adapter count stays at two while the reachable model count is
 * effectively everything.
 */
export class OpenAICompatibleChatProvider implements ChatProvider {
  readonly id = "openai-compatible";
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.maxOutputTokens = options.maxOutputTokens ?? 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.capabilities = {
      toolCalling: "json-mode",
      // Most of these endpoints do automatic prefix caching with no control
      // surface, and some do none. Either way there is no breakpoint to place,
      // so the prompt is still assembled stable-prefix-first and benefits where
      // automatic caching exists.
      explicitCaching: false,
      systemRole: true,
      streaming: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 8192,
      ...options.capabilities,
    };
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionDelta> {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: request.system },
      ...request.messages.map((message) => {
        if (message.role === "tool") {
          return {
            role: "tool",
            tool_call_id: message.toolCallId,
            content: message.content,
          };
        }
        if (message.role === "assistant" && message.toolCalls?.length) {
          return {
            role: "assistant",
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          };
        }
        return { role: message.role, content: message.content };
      }),
    ];

    // Onto the last plain user turn, skipping tool results, which must stay bare.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate?.role === "user" && typeof candidate.content === "string") {
        candidate.content = `${renderContext(request.context)}\n\nQuestion: ${candidate.content}`;
        break;
      }
    }

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: Math.min(request.maxOutputTokens, this.maxOutputTokens),
        stream: true,
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }
          : {}),
      }),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!response.ok || !response.body) {
      throw new SupportChatError(
        "provider_unavailable",
        `Model provider returned ${response.status}.`,
        response.status >= 500,
      );
    }

    // Tool arguments stream as JSON fragments keyed by position, so they are
    // accumulated and only emitted once the stream ends.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let stopReason: "end_turn" | "max_tokens" | "tool_use" | "refusal" = "end_turn";

    for await (const data of sseLines(response.body)) {
      if (data === "[DONE]") break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = (
        parsed as {
          choices?: Array<{
            finish_reason?: string;
            delta?: {
              content?: unknown;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        }
      ).choices?.[0];

      const content = choice?.delta?.content;
      if (typeof content === "string" && content) {
        yield { type: "text", text: content };
      }

      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const entry = pending.get(index) ?? { id: "", name: "", args: "" };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name = call.function.name;
        if (call.function?.arguments) entry.args += call.function.arguments;
        pending.set(index, entry);
      }

      if (choice?.finish_reason === "tool_calls") stopReason = "tool_use";
      else if (choice?.finish_reason === "length") stopReason = "max_tokens";
    }

    for (const entry of pending.values()) {
      if (!entry.id || !entry.name) continue;
      let input: Record<string, unknown> = {};
      try {
        input = entry.args ? (JSON.parse(entry.args) as Record<string, unknown>) : {};
      } catch {
        input = {};
      }
      yield { type: "tool_call", id: entry.id, name: entry.name, input };
    }

    yield { type: "done", stopReason };
  }
}

/** Server-sent events framing: lines prefixed `data: `, records split by a blank line. */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
      index = buffer.indexOf("\n");
    }
  }
}
