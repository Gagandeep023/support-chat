import {
  SupportChatError,
  agentToServerSchema,
  decodeFrame,
  type AgentToServer,
} from "@gagandeep023/support-chat-core";
import type { Namespace, Socket } from "socket.io";
import type { ResolvedConfig } from "../config.js";
import type { CacheStore } from "../stores/cache-store.js";
import type { DataStore } from "../stores/data-store.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { Router } from "../services/router.js";
import { verifyAgentToken } from "../auth/jwt.js";
import type { Broadcaster } from "./broadcaster.js";
import {
  FRAME_EVENT,
  agentRoom,
  conversationRoom,
  sendToAgent,
  type AgentSocketData,
} from "./context.js";

interface Deps {
  data: DataStore;
  cache: CacheStore;
  conversations: ConversationService;
  config: ResolvedConfig;
  broadcast: Broadcaster;
  router: Router;
}

function socketData(socket: Socket): AgentSocketData {
  return socket.data as AgentSocketData;
}

export function registerAgentNamespace(nsp: Namespace, deps: Deps): void {
  nsp.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as { token?: unknown; tenantId?: unknown };
      if (typeof auth.token !== "string" || !auth.token) {
        throw new SupportChatError("unauthenticated", "An agent token is required.");
      }
      if (typeof auth.tenantId !== "string" || !auth.tenantId) {
        throw new SupportChatError("unauthenticated", "A tenant id is required.");
      }

      // The secret is resolved per tenant *before* the token is trusted, and the
      // token's own tenantId is then checked against the one it was verified
      // under. Skipping that check would let a token signed by one tenant's
      // secret be presented against another tenant.
      const secret = await deps.config.resolveSecret(auth.tenantId);
      const claims = verifyAgentToken(auth.token, secret);
      if (claims.tenantId !== auth.tenantId) {
        throw new SupportChatError("forbidden", "Token tenant mismatch.");
      }

      const agent = await deps.data.upsertAgent({
        tenantId: claims.tenantId,
        externalId: claims.agentId,
        displayName: claims.name,
        ...(claims.skills ? { skills: claims.skills } : {}),
        ...(claims.maxConcurrent ? { maxConcurrent: claims.maxConcurrent } : {}),
        ...(claims.role ? { role: claims.role } : {}),
      });

      const data: AgentSocketData = {
        kind: "agent",
        tenantId: agent.tenantId,
        agentId: agent.id,
        externalId: agent.externalId,
        displayName: agent.displayName,
        role: agent.role,
      };
      socket.data = data;
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error("Authentication failed."));
    }
  });

  nsp.on("connection", (socket) => {
    const data = socketData(socket);
    // One room per agent rather than per socket, so an offer reaches every
    // console that agent has open and is not lost to whichever tab happens to
    // hold the newest connection.
    void socket.join(agentRoom(data.agentId));

    socket.on(FRAME_EVENT, (raw: unknown) => {
      const decoded = decodeFrame(agentToServerSchema, raw);
      if (!decoded.ok) {
        sendToAgent(socket, "error", {
          code: decoded.code,
          message: decoded.message,
          retryable: false,
          frameId: decoded.frameId,
        });
        return;
      }
      // Any frame from this agent is proof of life, not just an explicit
      // heartbeat. A background tab whose timer was throttled but which is still
      // being used should not be treated as offline.
      void deps.cache.heartbeat(
        data.tenantId,
        data.agentId,
        deps.config.presenceTtlSeconds,
      );
      void handleFrame(socket, decoded.frame, deps).catch((error: unknown) => {
        const wire =
          error instanceof SupportChatError
            ? error.toWire(decoded.frame.id)
            : {
                code: "internal" as const,
                message: "Something went wrong handling that frame.",
                retryable: true,
                frameId: decoded.frame.id,
              };
        sendToAgent(socket, "error", wire);
      });
    });

    socket.on("disconnect", () => {
      // Presence is dropped immediately on disconnect rather than left to expire.
      // Letting the TTL run during a deploy means the router believes agents are
      // online who are not connected, so offers go to nobody and every accept
      // window expires in turn before anything is queued.
      void deps.cache.clearPresence(data.tenantId, data.agentId);
      // An outstanding offer to this agent is released immediately rather than
      // left to time out, so the customer is not waiting on a closed laptop.
      void deps.router.abandon({ tenantId: data.tenantId, agentId: data.agentId });
    });
  });
}

async function handleFrame(
  socket: Socket,
  frame: AgentToServer,
  deps: Deps,
): Promise<void> {
  const data = socketData(socket);

  switch (frame.type) {
    case "agent.hello": {
      const agent = await deps.data.upsertAgent({
        tenantId: data.tenantId,
        // The host's user id, not our internal one. Passing the internal id here
        // fails to match the existing row and silently creates a second agent,
        // whose id then never matches any assignment.
        externalId: data.externalId,
        displayName: data.displayName,
        ...(frame.payload.skills ? { skills: frame.payload.skills } : {}),
        ...(frame.payload.maxConcurrent
          ? { maxConcurrent: frame.payload.maxConcurrent }
          : {}),
      });
      await deps.cache.heartbeat(
        data.tenantId,
        data.agentId,
        deps.config.presenceTtlSeconds,
      );
      const assigned = await deps.data.listConversations(data.tenantId, {
        agentId: data.agentId,
        status: "assigned",
        limit: 50,
      });
      for (const conversation of assigned.items) {
        await socket.join(conversationRoom(conversation.id));
      }
      sendToAgent(socket, "agent.ready", {
        agent,
        assigned: assigned.items,
        queueDepth: await deps.cache.queueDepth(data.tenantId),
      });
      // Someone just became available; anything waiting can move now.
      await deps.router.pump(data.tenantId);
      return;
    }

    case "agent.heartbeat": {
      if (frame.payload.status === "offline") {
        await deps.cache.clearPresence(data.tenantId, data.agentId);
        return;
      }
      await deps.cache.heartbeat(
        data.tenantId,
        data.agentId,
        deps.config.presenceTtlSeconds,
      );
      return;
    }

    case "agent.offer.respond": {
      await deps.router.respond({
        tenantId: data.tenantId,
        conversationId: frame.payload.conversationId,
        agentId: data.agentId,
        accept: frame.payload.accept,
      });
      if (frame.payload.accept) {
        await socket.join(conversationRoom(frame.payload.conversationId));
      }
      return;
    }

    case "agent.conversation.subscribe": {
      const conversation = await deps.data.getConversation(
        data.tenantId,
        frame.payload.conversationId,
      );
      if (!conversation) {
        throw new SupportChatError("conversation_not_found", "No such conversation.");
      }
      await socket.join(conversationRoom(conversation.id));
      const messages = await deps.data.listMessages(conversation.id, { limit: 200 });
      sendToAgent(socket, "agent.conversation.assigned", {
        conversation,
        messages,
        diagnosis: null,
      });
      return;
    }

    case "agent.conversation.release": {
      await socket.leave(conversationRoom(frame.payload.conversationId));
      return;
    }

    case "agent.message.send": {
      const message = await deps.conversations.appendAgentMessage({
        tenantId: data.tenantId,
        conversationId: frame.payload.conversationId,
        agentId: data.agentId,
        clientMessageId: frame.payload.clientMessageId,
        body: frame.payload.body,
      });
      deps.broadcast.toConversation(message.conversationId, "message.new", { message });
      return;
    }

    case "agent.conversation.resolve": {
      await deps.data.setConversationStatus(frame.payload.conversationId, "resolved");
      await deps.data.appendEvent({
        conversationId: frame.payload.conversationId,
        tenantId: data.tenantId,
        type: "conversation.resolved",
        actor: { type: "agent", id: data.agentId },
        payload: {
          note: frame.payload.note ?? null,
          promoteToKnowledge: frame.payload.promoteToKnowledge ?? false,
        },
      });
      // Frees this agent's capacity and immediately re-examines the queue.
      await deps.router.release({ tenantId: data.tenantId, agentId: data.agentId });
      return;
    }
  }
}
