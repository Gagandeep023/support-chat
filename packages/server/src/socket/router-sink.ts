import type { Conversation } from "@gagandeep023/support-chat-core";
import type { RouterSink } from "../services/router.js";
import type { DataStore } from "../stores/data-store.js";
import type { Broadcaster } from "./broadcaster.js";
import { agentRoom } from "./context.js";

export class SocketRouterSink implements RouterSink {
  constructor(
    private readonly broadcast: Broadcaster,
    private readonly data: DataStore,
  ) {}

  offer(input: Parameters<RouterSink["offer"]>[0]): void {
    this.broadcast.toAgent(agentRoom(input.agentId), "agent.offer", {
      conversationId: input.conversationId,
      summary: input.summary,
      urgency: input.urgency,
      diagnosis: input.diagnosis,
      waitingSince: input.waitingSince,
      expiresAt: input.expiresAt,
    });
  }

  revoke(input: Parameters<RouterSink["revoke"]>[0]): void {
    this.broadcast.toAgent(agentRoom(input.agentId), "agent.offer.revoked", {
      conversationId: input.conversationId,
      reason: input.reason,
    });
  }

  assigned(input: Parameters<RouterSink["assigned"]>[0]): void {
    // Fetched rather than passed along, because the agent needs the whole
    // transcript including everything the bot already tried. An agent who starts
    // blank makes the customer repeat themselves.
    void this.data
      .listMessages(input.conversation.id, { limit: 200 })
      .then((messages) => {
        this.broadcast.toAgent(
          agentRoom(input.agentId),
          "agent.conversation.assigned",
          { conversation: input.conversation, messages, diagnosis: input.diagnosis },
        );
      })
      .catch(() => undefined);
  }

  conversationStatus(conversation: Conversation, queuePosition: number | null): void {
    this.broadcast.toWidgetsInConversation(conversation.id, "conversation.status", {
      conversationId: conversation.id,
      status: conversation.status,
      agent: null,
      queuePosition,
    });
  }

  queueUpdate(_tenantId: string, depth: number): void {
    this.broadcast.toAllAgents("queue.update", { depth, oldestWaitingSince: null });
  }
}
