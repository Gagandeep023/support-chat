import {
  SupportChatError,
  decodeFrame,
  widgetToServerSchema,
  type WidgetToServer,
} from "@gagandeep023/support-chat-core";
import type { Namespace, Socket } from "socket.io";
import type { ResolvedConfig } from "../config.js";
import type { DataStore } from "../stores/data-store.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { Router } from "../services/router.js";
import { verifyUserIdentity } from "../auth/identity.js";
import type { Broadcaster } from "./broadcaster.js";
import {
  FRAME_EVENT,
  conversationRoom,
  sendToWidget,
  type WidgetSocketData,
} from "./context.js";

interface Deps {
  data: DataStore;
  conversations: ConversationService;
  config: ResolvedConfig;
  broadcast: Broadcaster;
  router: Router;
  /** Present only when host tools are configured. */
  resolveToolDecision?: (toolCallId: string, approved: boolean) => void;
  onUserMessage: (event: {
    tenantId: string;
    conversationId: string;
    messageId: string;
  }) => void;
}

function socketData(socket: Socket): WidgetSocketData {
  return socket.data as WidgetSocketData;
}

export function registerWidgetNamespace(nsp: Namespace, deps: Deps): void {
  nsp.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as {
        publishableKey?: unknown;
        externalId?: unknown;
        userHash?: unknown;
      };

      if (typeof auth.publishableKey !== "string" || !auth.publishableKey) {
        throw new SupportChatError("unauthenticated", "A publishable key is required.");
      }
      const tenant = await deps.data.getTenantByPublishableKey(auth.publishableKey);
      if (!tenant) {
        throw new SupportChatError("unauthenticated", "Unknown publishable key.");
      }

      let externalId: string | null = null;
      if (typeof auth.externalId === "string" && auth.externalId) {
        // The identity is only trusted when it arrives with an HMAC the host
        // computed server-side. Accepting a bare externalId would let any
        // visitor type someone else's id and read their support history.
        if (typeof auth.userHash !== "string" || !auth.userHash) {
          throw new SupportChatError(
            "identity_signature_invalid",
            "A signed identity is required when externalId is supplied.",
          );
        }
        const secret = await deps.config.resolveSecret(tenant.id);
        if (!verifyUserIdentity(auth.externalId, auth.userHash, secret)) {
          throw new SupportChatError(
            "identity_signature_invalid",
            "The identity signature does not match.",
          );
        }
        externalId = auth.externalId;
      } else if (deps.config.requireSignedIdentity) {
        throw new SupportChatError(
          "unauthenticated",
          "This deployment requires a signed identity.",
        );
      }

      const endUser = await deps.data.upsertEndUser({
        tenantId: tenant.id,
        externalId,
      });

      const data: WidgetSocketData = {
        kind: "widget",
        tenantId: tenant.id,
        endUserId: endUser.id,
        isAnonymous: endUser.isAnonymous,
        rooms: new Set(),
      };
      socket.data = data;
      next();
    } catch (error) {
      next(error instanceof Error ? error : new Error("Authentication failed."));
    }
  });

  nsp.on("connection", (socket) => {
    socket.on(FRAME_EVENT, (raw: unknown) => {
      const decoded = decodeFrame(widgetToServerSchema, raw);
      if (!decoded.ok) {
        sendToWidget(socket, "error", {
          code: decoded.code,
          message: decoded.message,
          retryable: false,
          frameId: decoded.frameId,
        });
        return;
      }
      void handleFrame(socket, decoded.frame, deps).catch((error: unknown) => {
        const wire =
          error instanceof SupportChatError
            ? error.toWire(decoded.frame.id)
            : {
                code: "internal" as const,
                message: "Something went wrong handling that message.",
                retryable: true,
                frameId: decoded.frame.id,
              };
        sendToWidget(socket, "error", wire);
      });
    });
  });
}

async function handleFrame(
  socket: Socket,
  frame: WidgetToServer,
  deps: Deps,
): Promise<void> {
  const data = socketData(socket);

  switch (frame.type) {
    case "session.start": {
      const result = await deps.conversations.start({
        tenantId: data.tenantId,
        endUserId: data.endUserId,
        channel: "web",
        ...(frame.payload.conversationId
          ? { conversationId: frame.payload.conversationId }
          : {}),
      });
      await joinConversation(socket, result.conversation.id);
      sendToWidget(socket, "session.ready", {
        conversation: result.conversation,
        messages: result.messages,
        agent: null,
        resumed: result.resumed,
      });
      return;
    }

    case "session.resume": {
      const result = await deps.conversations.resume({
        tenantId: data.tenantId,
        conversationId: frame.payload.conversationId,
        lastSeq: frame.payload.lastSeq,
      });
      await joinConversation(socket, result.conversation.id);
      sendToWidget(socket, "session.ready", {
        conversation: result.conversation,
        messages: result.messages,
        agent: null,
        resumed: true,
      });
      return;
    }

    case "message.send": {
      const message = await deps.conversations.appendUserMessage({
        tenantId: data.tenantId,
        conversationId: frame.payload.conversationId,
        endUserId: data.endUserId,
        clientMessageId: frame.payload.clientMessageId,
        body: frame.payload.body,
      });
      // Ack first: the widget clears its outbound buffer on this, and a client
      // that reconnects mid-answer must not resend a message already persisted.
      sendToWidget(socket, "message.ack", {
        clientMessageId: frame.payload.clientMessageId,
        messageId: message.id,
        seq: message.seq,
      });
      // Other watchers of this conversation (a second tab, the assigned agent)
      // get the message itself; the sender already has it via the ack.
      deps.broadcast.toConversation(
        message.conversationId,
        "message.new",
        { message },
        { exceptSocketId: socket.id },
      );
      deps.onUserMessage({
        tenantId: data.tenantId,
        conversationId: message.conversationId,
        messageId: message.id,
      });
      return;
    }

    case "typing.set": {
      return;
    }

    case "handoff.request": {
      const conversation = await deps.conversations.requestHandoff({
        tenantId: data.tenantId,
        conversationId: frame.payload.conversationId,
        endUserId: data.endUserId,
        ...(frame.payload.reason ? { reason: frame.payload.reason } : {}),
      });
      const position = await deps.conversations.queuePosition(
        data.tenantId,
        conversation.id,
      );
      sendToWidget(socket, "conversation.status", {
        conversationId: conversation.id,
        status: conversation.status,
        agent: null,
        queuePosition: position,
      });
      await deps.router.pump(data.tenantId);
      return;
    }

    case "tool.decision": {
      if (!deps.resolveToolDecision) {
        throw new SupportChatError(
          "tool_not_found",
          "Tool confirmations are not enabled on this deployment.",
        );
      }
      // Scoped to this socket's conversation. Without the check any connected
      // visitor could approve somebody else's pending action by guessing an id.
      if (!data.rooms.has(conversationRoom(frame.payload.conversationId))) {
        throw new SupportChatError("forbidden", "Not your conversation.");
      }
      deps.resolveToolDecision(frame.payload.toolCallId, frame.payload.approved);
      return;
    }
  }
}

async function joinConversation(socket: Socket, conversationId: string): Promise<void> {
  const data = socketData(socket);
  const room = conversationRoom(conversationId);
  if (data.rooms.has(room)) return;
  await socket.join(room);
  data.rooms.add(room);
}
