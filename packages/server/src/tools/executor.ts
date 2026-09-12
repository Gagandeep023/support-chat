import {
  SupportChatError,
  newToolCallId,
  type ToolCall,
  type ToolContext,
} from "@gagandeep023/support-chat-core";
import type { DataStore } from "../stores/data-store.js";
import type { HostTool, ToolRegistry } from "./registry.js";

export interface PendingConfirmation {
  toolCallId: string;
  conversationId: string;
  name: string;
  prompt: string;
  expiresAt: string;
  resolve(approved: boolean): void;
}

export interface ToolExecutionResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

export interface ExecutorOptions {
  /** How long a user has to approve an acting tool. */
  confirmationWindowMs?: number;
  now?: () => number;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface ConfirmationSink {
  request(input: {
    conversationId: string;
    toolCallId: string;
    name: string;
    prompt: string;
    expiresAt: string;
  }): void;
}

/**
 * Runs tool calls on the host's behalf.
 *
 * Two rules are enforced here rather than asked for in a prompt, because a
 * prompt is a suggestion and this is a permission boundary.
 */
export class ToolExecutor {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly schedule: (handler: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(
    private readonly deps: {
      registry: ToolRegistry;
      data: DataStore;
      confirmations: ConfirmationSink;
    },
    options: ExecutorOptions = {},
  ) {
    this.windowMs = options.confirmationWindowMs ?? 120_000;
    this.now = options.now ?? Date.now;
    this.schedule = options.setTimeout ?? ((h, ms) => setTimeout(h, ms));
    this.cancel = options.clearTimeout ?? ((h) => clearTimeout(h as never));
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolExecutionResult> {
    const tool = this.deps.registry.get(call.name);
    if (!tool) {
      await this.audit(ctx, "tool.denied", { name: call.name, reason: "unknown_tool" });
      return this.error(call, `No tool named ${call.name} is available.`);
    }

    // The model never supplies whose data to read. Anything in the arguments
    // that looks like an identity is dropped before the handler sees it, so a
    // handler cannot accidentally trust one even if a schema changes later.
    const input = stripIdentityKeys(call.input);

    if (tool.access === "act") {
      const approved = await this.confirm(tool, input, ctx);
      if (!approved) {
        await this.audit(ctx, "tool.denied", { name: call.name, reason: "not_approved" });
        return this.error(
          call,
          "The customer did not approve this action, so nothing was done.",
        );
      }
    }

    const started = this.now();
    try {
      const output = await tool.handler(input, ctx);
      await this.audit(ctx, "tool.called", {
        name: call.name,
        access: tool.access,
        input,
        durationMs: this.now() - started,
      });
      return {
        toolCallId: call.id,
        name: call.name,
        content: typeof output === "string" ? output : JSON.stringify(output),
        isError: false,
      };
    } catch (error) {
      await this.audit(ctx, "tool.called", {
        name: call.name,
        access: tool.access,
        input,
        durationMs: this.now() - started,
        error: error instanceof Error ? error.message : "failed",
      });
      // The message is deliberately generic. A host tool's exception can carry
      // stack traces, SQL, or internal identifiers, and this string is read back
      // to the customer by the model.
      return this.error(call, `The ${call.name} lookup failed. A colleague can check.`);
    }
  }

  /** A user answered a confirmation prompt. */
  resolveConfirmation(toolCallId: string, approved: boolean): void {
    this.pending.get(toolCallId)?.resolve(approved);
  }

  private confirm(
    tool: HostTool,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<boolean> {
    const toolCallId = newToolCallId();
    const expiresAt = new Date(this.now() + this.windowMs).toISOString();

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        this.cancel(timer);
        this.pending.delete(toolCallId);
        resolve(approved);
      };
      // Times out as a refusal, never as an approval. An unanswered prompt means
      // nobody said yes.
      const timer = this.schedule(() => finish(false), this.windowMs);

      this.pending.set(toolCallId, {
        toolCallId,
        conversationId: ctx.conversationId,
        name: tool.name,
        prompt: tool.confirmationPrompt?.(input) ?? `Run ${tool.name}?`,
        expiresAt,
        resolve: finish,
      });

      this.deps.confirmations.request({
        conversationId: ctx.conversationId,
        toolCallId,
        name: tool.name,
        prompt: tool.confirmationPrompt?.(input) ?? `Run ${tool.name}?`,
        expiresAt,
      });
    });
  }

  private error(call: ToolCall, message: string): ToolExecutionResult {
    return { toolCallId: call.id, name: call.name, content: message, isError: true };
  }

  /**
   * Every call is recorded, successful or not.
   *
   * For a billing dispute the customer needs to be able to show what the bot
   * looked at and what it said.
   */
  private async audit(
    ctx: ToolContext,
    type: "tool.called" | "tool.denied",
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.data
      .appendEvent({
        conversationId: ctx.conversationId,
        tenantId: ctx.tenantId,
        type,
        actor: { type: "ai", id: null },
        payload,
      })
      .catch(() => undefined);
  }
}

/** Defence in depth behind the registration check. */
export function stripIdentityKeys(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isIdentityKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function isIdentityKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z]/g, "");
  return (
    normalised === "userid" ||
    normalised === "customerid" ||
    normalised === "accountid" ||
    normalised === "enduserid" ||
    normalised === "externalid" ||
    normalised === "tenantid" ||
    normalised === "email" ||
    normalised === "uid"
  );
}

export { SupportChatError };
