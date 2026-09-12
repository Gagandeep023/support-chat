import type { RetrievedChunk } from "../domain/knowledge.js";

/**
 * What a chat provider can actually do.
 *
 * Declared up front rather than discovered at runtime. Core resolves its
 * strategy once at startup from these flags and runs a real tested
 * implementation per tier, instead of scattering capability checks through the
 * code and silently degrading on weaker models.
 */
export interface ProviderCapabilities {
  /**
   * `native`    real tool_use blocks; required for host tools and diagnostics
   * `json-mode` structured output only; escalation works, diagnostics does not
   * `none`      text only; escalation falls back to a parsed text verdict
   */
  toolCalling: "native" | "json-mode" | "none";
  /** Explicit cache breakpoints (Anthropic). False means automatic prefix caching or none. */
  explicitCaching: boolean;
  /** Whether the model accepts a distinct system role. */
  systemRole: boolean;
  streaming: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * JSON Schema for the arguments.
   *
   * Must not contain any end-user identifier. The framework injects who is
   * asking; a schema that accepts it would let a visitor read another user's
   * data by claiming to be them, and registration rejects one that tries.
   */
  inputSchema: Record<string, unknown>;
  strict?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A turn in the conversation as the model sees it.
 *
 * Tool calls and their results are first-class rather than flattened into text,
 * because every provider encodes them differently and a string round-trip loses
 * the call id that pairs a result with its request.
 */
export type CompletionMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface CompletionRequest {
  system: string;
  messages: CompletionMessage[];
  /**
   * Retrieved context, kept separate from `system` on purpose. Adapters must
   * render it after the cache breakpoint: folding volatile chunks into the
   * system prefix changes the cached prefix on every request and silently
   * disables caching. See DESIGN.md section 5.4.2.
   */
  context: RetrievedChunk[];
  tools?: ToolDefinition[];
  maxOutputTokens: number;
  /** Quality tier. Adapters translate this to whatever their model accepts. */
  quality: "fast" | "balanced" | "thorough";
  signal?: AbortSignal;
}

export type CompletionDelta =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  | { type: "done"; stopReason: "end_turn" | "max_tokens" | "tool_use" | "refusal" };

export interface ChatProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: CompletionRequest): AsyncIterable<CompletionDelta>;
}
