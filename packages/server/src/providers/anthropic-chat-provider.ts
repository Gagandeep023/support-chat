import type {
  ChatProvider,
  CompletionDelta,
  CompletionRequest,
  ProviderCapabilities,
} from "@gagandeep023/support-chat-core";
import { renderContext } from "../ai/prompt.js";

export interface AnthropicOptions {
  apiKey?: string;
  model?: string;
  /**
   * Default is `claude-sonnet-5` rather than the cheapest model. Tokens are not
   * the dominant cost in a support system: one unnecessary escalation consumes
   * roughly ten minutes of an agent's time, which dwarfs the per-turn
   * difference. See DESIGN.md 5.4.1.
   */
  maxOutputTokens?: number;
}

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export interface AnthropicRequestShape {
  model: string;
  max_tokens: number;
  system: AnthropicSystemBlock[];
  messages: AnthropicMessage[];
  thinking: { type: "adaptive" };
  output_config: { effort: "low" | "medium" | "high" };
  tools?: AnthropicToolDefinition[];
}

/**
 * Build the wire request.
 *
 * Extracted as a pure function so the caching layout can be asserted without a
 * network call. Two rules are load-bearing and easy to break by accident:
 *
 * 1. Retrieved chunks never enter `system`. They change on every request, and
 *    caching is a prefix match, so folding them into the prefix silently
 *    disables caching entirely.
 * 2. The breakpoint sits on the last system block, which caches tools and system
 *    together. Automatic top-level caching would place it after the volatile
 *    tail instead, paying the cache-write premium on bytes that are never read
 *    back: a pure surcharge.
 */
export function buildAnthropicRequest(
  request: CompletionRequest,
  options: { model: string; maxOutputTokens: number },
): AnthropicRequestShape {
  const messages: AnthropicMessage[] = request.messages.map((message) => {
    if (message.role === "tool") {
      // A tool result is a user turn carrying a tool_result block, which is how
      // the Messages API models it.
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
            ...(message.isError ? { is_error: true } : {}),
          },
        ],
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: "tool_use" as const,
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });

  // Context is rendered onto the last plain user turn. A tool result must stay a
  // bare tool_result block, so it is skipped.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.role === "user" && typeof candidate.content === "string") {
      candidate.content = `${renderContext(request.context)}\n\nQuestion: ${candidate.content}`;
      break;
    }
  }

  return {
    model: options.model,
    max_tokens: Math.min(request.maxOutputTokens, options.maxOutputTokens),
    system: [
      { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
    ],
    messages,
    // Thinking stays on rather than disabled. With it off a model can write a
    // tool call into visible text instead of emitting a tool_use block: the turn
    // succeeds, nothing errors, and the call never runs. Low effort keeps it
    // cheap and fast, which is the right trade for chat.
    thinking: { type: "adaptive" },
    output_config: { effort: request.quality === "fast" ? "low" : "high" },
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
            // Guarantees the arguments validate against the schema. Core
            // branches on those fields, so a malformed one is a routing bug.
            ...(tool.strict === false ? {} : { strict: true }),
          })),
        }
      : {}),
  };
}

interface AnthropicClientLike {
  messages: {
    stream(body: unknown): AsyncIterable<unknown> & {
      on?: unknown;
    };
  };
}

export class AnthropicChatProvider implements ChatProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly maxOutputTokens: number;
  private client: AnthropicClientLike | null = null;
  private readonly apiKey: string | undefined;

  constructor(options: AnthropicOptions = {}) {
    this.model = options.model ?? "claude-sonnet-5";
    this.maxOutputTokens = options.maxOutputTokens ?? 1024;
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.capabilities = {
      toolCalling: "native",
      explicitCaching: true,
      systemRole: true,
      streaming: true,
      maxContextTokens: this.model.includes("haiku") ? 200_000 : 1_000_000,
      maxOutputTokens: 64_000,
    };
  }

  private async getClient(): Promise<AnthropicClientLike> {
    if (this.client) return this.client;
    // Imported lazily and declared as an optional peer, so installing this
    // package does not pull the Anthropic SDK for someone running Kimi through
    // the OpenAI-compatible adapter.
    const module = (await import("@anthropic-ai/sdk")) as unknown as {
      default: new (config: { apiKey?: string }) => AnthropicClientLike;
    };
    this.client = new module.default(
      this.apiKey ? { apiKey: this.apiKey } : {},
    );
    return this.client;
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionDelta> {
    const client = await this.getClient();
    const body = buildAnthropicRequest(request, {
      model: this.model,
      maxOutputTokens: this.maxOutputTokens,
    });

    const stream = client.messages.stream(body);
    // Tool inputs arrive as a stream of JSON fragments and are only usable once
    // the block ends, so they are accumulated per block index.
    const pending = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: "end_turn" | "max_tokens" | "tool_use" | "refusal" = "end_turn";

    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
      if (event.type === "content_block_start") {
        const block = event.content_block as
          | { type?: string; id?: string; name?: string }
          | undefined;
        if (block?.type === "tool_use" && block.id && block.name) {
          pending.set(Number(event.index), { id: block.id, name: block.name, json: "" });
        }
        continue;
      }

      if (event.type === "content_block_delta") {
        const delta = event.delta as
          | { type?: string; text?: string; partial_json?: string }
          | undefined;
        // Thinking blocks are never forwarded: reasoning is not shown to end
        // users in a support widget.
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          yield { type: "text", text: delta.text };
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const entry = pending.get(Number(event.index));
          if (entry) entry.json += delta.partial_json;
        }
        continue;
      }

      if (event.type === "content_block_stop") {
        const entry = pending.get(Number(event.index));
        if (entry) {
          pending.delete(Number(event.index));
          let input: Record<string, unknown> = {};
          try {
            // Always parsed, never string-matched: models differ in how they
            // escape JSON in tool arguments.
            input = entry.json ? (JSON.parse(entry.json) as Record<string, unknown>) : {};
          } catch {
            input = {};
          }
          yield { type: "tool_call", id: entry.id, name: entry.name, input };
        }
        continue;
      }

      if (event.type === "message_delta") {
        const delta = event.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason === "tool_use") stopReason = "tool_use";
        else if (delta?.stop_reason === "max_tokens") stopReason = "max_tokens";
        else if (delta?.stop_reason === "refusal") stopReason = "refusal";
      }
    }
    yield { type: "done", stopReason };
  }
}
