import {
  AnthropicChatProvider,
  FakeChatProvider,
  HashedEmbeddingProvider,
  LocalEmbeddingProvider,
  OpenAICompatibleChatProvider,
} from "@gagandeep023/support-chat-server";

const serverModule = { HashedEmbeddingProvider, LocalEmbeddingProvider };
import type { ChatProvider } from "@gagandeep023/support-chat-core";

export interface ResolvedProvider {
  provider: ChatProvider;
  description: string;
  /** True when nothing was configured and a scripted stand-in is in use. */
  simulated: boolean;
}

/**
 * Pick a chat provider from the environment.
 *
 * Falls back to a scripted provider rather than failing. The promise is that
 * evaluating this takes no infrastructure *and* no API key: someone should be
 * able to watch the whole loop work before deciding to spend anything on it.
 */
export function resolveChatProvider(options: { model?: string } = {}): ResolvedProvider {
  const baseUrl = process.env.SUPPORT_CHAT_BASE_URL;
  const model = options.model ?? process.env.SUPPORT_CHAT_MODEL;

  if (baseUrl && model) {
    return {
      provider: new OpenAICompatibleChatProvider({
        baseUrl,
        model,
        ...(process.env.SUPPORT_CHAT_API_KEY
          ? { apiKey: process.env.SUPPORT_CHAT_API_KEY }
          : {}),
      }),
      description: `${model} via ${baseUrl}`,
      simulated: false,
    };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const chosen = model ?? "claude-sonnet-5";
    return {
      provider: new AnthropicChatProvider({ model: chosen }),
      description: `${chosen} via the Anthropic API`,
      simulated: false,
    };
  }

  return {
    provider: new FakeChatProvider([
      {
        reply:
          "This is a simulated reply. Set ANTHROPIC_API_KEY, or SUPPORT_CHAT_BASE_URL " +
          "and SUPPORT_CHAT_MODEL, to answer with a real model.",
      },
      { reply: '{"escalate": false, "reason": "simulated"}' },
    ]),
    description: "a scripted stand-in (no model configured)",
    simulated: true,
  };
}

export interface ResolvedEmbeddings {
  embeddings: import("@gagandeep023/support-chat-core").EmbeddingProvider | null;
  description: string;
}

/**
 * Pick an embedding provider.
 *
 * The default is none, and retrieval then runs on keyword search alone. That is
 * the honest default rather than a limitation: BM25 already handles the error
 * codes, SKUs and exact feature names that support users actually paste, and
 * every alternative costs something real. Local embeddings need a ~300MB runtime
 * and a model download; a hosted endpoint needs a key and a per-token bill.
 * Neither belongs in a command whose promise is that it runs with nothing
 * installed.
 */
export function resolveEmbeddings(choice: string | undefined): ResolvedEmbeddings {
  switch (choice) {
    case undefined:
    case "none":
      return { embeddings: null, description: "none (keyword search only)" };
    case "hashed": {
      const { HashedEmbeddingProvider } = requireServer();
      const embeddings = new HashedEmbeddingProvider();
      return {
        embeddings,
        description: `${embeddings.model} (lexical overlap only, no semantics)`,
      };
    }
    case "local": {
      const { LocalEmbeddingProvider } = requireServer();
      const embeddings = new LocalEmbeddingProvider();
      return { embeddings, description: `${embeddings.model} running locally` };
    }
    default:
      throw new Error(
        `Unknown --embeddings value "${choice}". Use none, hashed, or local.`,
      );
  }
}

function requireServer() {
  // Imported through the package entry so the local provider's lazy transformers
  // import stays lazy.
  return serverModule;
}
