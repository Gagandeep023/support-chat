import type {
  ChatProvider,
  CompletionDelta,
  CompletionRequest,
  ProviderCapabilities,
} from "@gagandeep023/support-chat-core";

export interface FakeScript {
  /** Reply text, streamed a few characters at a time. */
  reply: string;
  /** Throw instead of replying, to exercise the provider-failure path. */
  fail?: boolean;
}

/**
 * Scripted provider for tests and for `support-chat dev` before a key is set.
 *
 * Records every request it receives so assertions can be made about prompt
 * layout, which is the only way the caching rules in DESIGN.md 5.4.2 stay true
 * as the code changes.
 */
export class FakeChatProvider implements ChatProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  readonly capabilities: ProviderCapabilities = {
    toolCalling: "json-mode",
    explicitCaching: false,
    systemRole: true,
    streaming: true,
    maxContextTokens: 100_000,
    maxOutputTokens: 4096,
  };

  readonly requests: CompletionRequest[] = [];
  private readonly script: FakeScript[];
  private index = 0;

  constructor(script: FakeScript[] = [{ reply: "Here is what I found." }]) {
    this.script = script;
  }

  async *complete(request: CompletionRequest): AsyncIterable<CompletionDelta> {
    this.requests.push(request);
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (!step || step.fail) throw new Error("fake provider failure");

    for (let i = 0; i < step.reply.length; i += 8) {
      yield { type: "text", text: step.reply.slice(i, i + 8) };
    }
    yield { type: "done", stopReason: "end_turn" };
  }
}
