import { Server, type Namespace } from "socket.io";
import type { Server as HttpServer } from "node:http";
import type { ResolvedConfig } from "../config.js";
import type { CacheStore } from "../stores/cache-store.js";
import type { DataStore } from "../stores/data-store.js";
import { ConversationService } from "../services/conversation-service.js";
import { Router, type RouterOptions } from "../services/router.js";
import { SocketRouterSink } from "./router-sink.js";
import { Broadcaster } from "./broadcaster.js";
import { drainSockets } from "./drain.js";
import { registerAgentNamespace } from "./agent-namespace.js";
import { registerWidgetNamespace } from "./widget-namespace.js";
import { attachRedisSocketAdapter } from "./redis-adapter.js";

export interface UserMessageEvent {
  tenantId: string;
  conversationId: string;
  messageId: string;
}

export interface GatewayDeps {
  data: DataStore;
  cache: CacheStore;
  config: ResolvedConfig;
  router?: RouterOptions;
}

export interface Gateway {
  io: Server;
  widget: Namespace;
  agent: Namespace;
  broadcast: Broadcaster;
  conversations: ConversationService;
  router: Router;
  /** Set once host tools are wired, so confirmations can be answered. */
  setToolDecisionResolver(resolver: (toolCallId: string, approved: boolean) => void): void;
  /**
   * Subscribe to inbound user messages. This is the seam the AI pipeline hangs
   * off, kept as a subscription so the socket layer has no knowledge of it and
   * stays usable with no bot configured at all.
   */
  onUserMessage(handler: (event: UserMessageEvent) => void): () => void;
  /** Spread reconnects, then close every socket. Wire this to SIGTERM. */
  drain(reason?: "deploy" | "shutdown" | "rebalance"): Promise<number>;
  close(): Promise<void>;
}

export function createGateway(httpServer: HttpServer, deps: GatewayDeps): Gateway {
  const io = new Server(httpServer, {
    path: `${deps.config.basePath}/socket.io`,
    // WebSocket only, deliberately. The HTTP long-polling fallback is the sole
    // reason this would need sticky sessions, and sticky routing buys nothing
    // during a deploy (a restart moves those clients anyway) while costing
    // balance the rest of the time.
    transports: ["websocket"],
    serveClient: false,
  });

  if (deps.config.socketAdapter?.type === "redis") {
    // Attached before namespaces take connections, and awaited by `ready` so a
    // caller can fail fast rather than discover at runtime that broadcasts are
    // not crossing pods.
    void attachRedisSocketAdapter(io, deps.config.socketAdapter);
  }

  const widget = io.of(`${deps.config.basePath}/widget`);
  const agent = io.of(`${deps.config.basePath}/agent`);
  const broadcast = new Broadcaster(widget, agent);
  const conversations = new ConversationService(deps.data, deps.cache);
  const userMessageHandlers = new Set<(event: UserMessageEvent) => void>();
  let toolDecisionResolver: ((toolCallId: string, approved: boolean) => void) | null = null;
  const router = new Router(
    { data: deps.data, cache: deps.cache, sink: new SocketRouterSink(broadcast, deps.data) },
    deps.router ?? {},
  );

  registerWidgetNamespace(widget, {
    data: deps.data,
    conversations,
    config: deps.config,
    broadcast,
    router,
    resolveToolDecision: (toolCallId, approved) =>
      toolDecisionResolver?.(toolCallId, approved),
    onUserMessage: (event) => {
      for (const handler of userMessageHandlers) handler(event);
    },
  });

  registerAgentNamespace(agent, {
    data: deps.data,
    cache: deps.cache,
    conversations,
    config: deps.config,
    broadcast,
    router,
  });

  return {
    io,
    widget,
    agent,
    broadcast,
    conversations,
    router,
    setToolDecisionResolver(resolver) {
      toolDecisionResolver = resolver;
    },
    onUserMessage(handler) {
      userMessageHandlers.add(handler);
      return () => userMessageHandlers.delete(handler);
    },
    drain: (reason = "deploy") =>
      drainSockets([widget, agent], reason, {
        windowMs: deps.config.drainWindowMs,
        graceMs: deps.config.drainGraceMs,
      }),
    close: async () => {
      router.stop();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}
