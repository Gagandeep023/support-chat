import type { Server as HttpServer } from "node:http";
import type { ChatProvider, EmbeddingProvider } from "@gagandeep023/support-chat-core";
import { resolveConfig, type SupportChatConfig } from "./config.js";
import { createGateway, type Gateway } from "./socket/gateway.js";
import { SocketConfirmationSink, SocketResponseSink } from "./socket/socket-sink.js";
import { ToolRegistry, type HostTool } from "./tools/registry.js";
import { ToolExecutor, type ExecutorOptions } from "./tools/executor.js";
import type { CacheStore } from "./stores/cache-store.js";
import type { DataStore } from "./stores/data-store.js";
import type { VectorStore } from "./stores/vector-store.js";
import { KeywordIndex } from "./ai/keyword-index.js";
import { KnowledgeService } from "./ai/knowledge-service.js";
import { Retriever, type RetrieverOptions } from "./ai/retriever.js";
import { EscalationDetector, type DetectorOptions } from "./ai/escalation-detector.js";
import { Responder, type ResponderOptions } from "./ai/responder.js";
import type { RouterOptions } from "./services/router.js";
import type { SourceDocument } from "./ai/chunker.js";

export type { SupportChatConfig, ResolvedConfig } from "./config.js";
export type { ConversationFilter, DataStore, NewMessage, Page } from "./stores/data-store.js";
export type { CacheStore, Unsubscribe } from "./stores/cache-store.js";
export type { VectorChunk, VectorStore } from "./stores/vector-store.js";
export { ConversationService } from "./services/conversation-service.js";
export { signAgentToken, verifyAgentToken, type AgentClaims } from "./auth/jwt.js";
export { signUserIdentity, verifyUserIdentity } from "./auth/identity.js";
export { Broadcaster } from "./socket/broadcaster.js";
export { FRAME_EVENT, conversationRoom } from "./socket/context.js";
export type { Gateway } from "./socket/gateway.js";
export { attachRedisSocketAdapter } from "./socket/redis-adapter.js";
export { KeywordIndex, tokenize } from "./ai/keyword-index.js";
export { Retriever, type RetrievalResult, type RetrieverOptions } from "./ai/retriever.js";
export {
  EscalationDetector,
  parseVerdict,
  type DetectorOptions,
} from "./ai/escalation-detector.js";
export { Responder, type ResponderOptions, type ResponseSink } from "./ai/responder.js";
export { Router, type RouterOptions, type RouterSink, type RouterTimers } from "./services/router.js";
export {
  assemblePrompt,
  buildSystemPrompt,
  renderContext,
  type AssembledPrompt,
  type PromptOptions,
} from "./ai/prompt.js";
export { chunkDocument, type ChunkOptions, type SourceDocument, type TextChunk } from "./ai/chunker.js";
export { KnowledgeService, type IngestResult } from "./ai/knowledge-service.js";
export * from "./providers/index.js";
// Safe to export from the main entry: the local provider imports transformers.js
// lazily inside embed(), so the 300MB runtime is only pulled when it is used.
export * from "./embeddings/index.js";
export { ToolRegistry, isIdentityParameter, type HostTool } from "./tools/registry.js";
export {
  ToolExecutor,
  stripIdentityKeys,
  type ConfirmationSink,
  type ExecutorOptions,
  type ToolExecutionResult,
} from "./tools/executor.js";
export {
  runDiagnostic,
  renderDiagnosis,
  type DiagnosticDefinition,
  type DiagnosticRule,
} from "./tools/diagnostics.js";

export interface AiOptions extends ResponderOptions {
  chat: ChatProvider;
  embeddings?: EmbeddingProvider;
  vectors?: VectorStore;
  retrieval?: RetrieverOptions;
  detector?: DetectorOptions;
}

export interface SupportChatOptions extends SupportChatConfig {
  data: DataStore;
  cache: CacheStore;
  /** Omit to run the socket layer with no bot at all, which is a valid mode. */
  ai?: AiOptions;
  routing?: RouterOptions;
  tools?: ExecutorOptions;
}

export interface SupportChat {
  attach(httpServer: HttpServer): Gateway;
  /**
   * Expose one of the host application's own operations to the model.
   *
   * Must be called before `attach`. Registration validates the schema, and a
   * tool that accepts a user identifier is rejected outright.
   */
  registerTool<TInput extends Record<string, unknown>, TOutput>(
    tool: HostTool<TInput, TOutput>,
  ): void;
  /** Add or replace a knowledge document. Re-ingesting unchanged content is a no-op. */
  ingest(tenantId: string, document: SourceDocument): Promise<{ chunks: number; skipped: boolean }>;
  removeDocument(tenantId: string, documentId: string): Promise<void>;
  drain(reason?: "deploy" | "shutdown" | "rebalance"): Promise<number>;
  close(): Promise<void>;
}

export function createSupportChat(options: SupportChatOptions): SupportChat {
  const config = resolveConfig(options);
  const keywords = new KeywordIndex();
  const vectors = options.ai?.vectors ?? null;
  const embeddings = options.ai?.embeddings ?? null;

  const knowledge = new KnowledgeService({ vectors, keywords, embeddings });
  const registry = new ToolRegistry();
  let gateway: Gateway | null = null;

  return {
    registerTool(tool) {
      if (gateway) {
        throw new Error("support-chat: register tools before attaching to a server.");
      }
      registry.register(tool);
    },
    attach(httpServer: HttpServer): Gateway {
      if (gateway) throw new Error("support-chat: already attached to an HTTP server.");

      const built = createGateway(httpServer, {
        data: options.data,
        cache: options.cache,
        config,
        ...(options.routing ? { router: options.routing } : {}),
      });

      const executor = new ToolExecutor(
        {
          registry,
          data: options.data,
          confirmations: new SocketConfirmationSink(built.broadcast),
        },
        options.tools ?? {},
      );
      built.setToolDecisionResolver((toolCallId, approved) =>
        executor.resolveConfirmation(toolCallId, approved),
      );

      if (options.ai) {
        const responder = new Responder(
          {
            data: options.data,
            conversations: built.conversations,
            chat: options.ai.chat,
            retriever: new Retriever(vectors, keywords, embeddings, options.ai.retrieval),
            detector: new EscalationDetector(options.ai.chat, options.ai.detector),
            sink: new SocketResponseSink(built.broadcast),
            tools: registry,
            executor,
            onEscalated: (tenantId) => {
              void built.router.pump(tenantId).catch(() => undefined);
            },
          },
          options.ai,
        );
        // Fire and forget on purpose: the user's message is already persisted and
        // acked, so a model failure must not fail their send. Errors surface as a
        // reply plus an escalation rather than a dropped frame.
        built.onUserMessage((input) => {
          void responder.respond(input).catch(() => undefined);
        });
      }

      gateway = built;
      return built;
    },
    async ingest(tenantId, document) {
      if (vectors && embeddings) await vectors.init(embeddings.dimensions);
      const result = await knowledge.ingest(tenantId, document);
      return { chunks: result.chunks, skipped: result.skipped };
    },
    async removeDocument(tenantId, documentId) {
      await knowledge.remove(tenantId, documentId);
    },
    async drain(reason = "deploy") {
      return gateway ? gateway.drain(reason) : 0;
    },
    async close() {
      await gateway?.close();
      await vectors?.close();
      await options.cache.close();
      await options.data.close();
      gateway = null;
    },
  };
}
