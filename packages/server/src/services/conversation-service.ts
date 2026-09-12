import {
  SupportChatError,
  type Conversation,
  type Message,
} from "@gagandeep023/support-chat-core";
import type { CacheStore } from "../stores/cache-store.js";
import type { DataStore } from "../stores/data-store.js";

const REPLAY_LIMIT = 200;

export interface ResumeResult {
  conversation: Conversation;
  /** The gap only. Empty when the client was already current. */
  messages: Message[];
  resumed: boolean;
}

/**
 * Conversation lifecycle, independent of transport.
 *
 * The socket layer is a thin adapter over this. Keeping the logic here is what
 * lets the same engine sit behind SSE, plain HTTP polling, or a test harness
 * without rewriting anything.
 */
export class ConversationService {
  constructor(
    private readonly data: DataStore,
    private readonly cache: CacheStore,
  ) {}

  async start(input: {
    tenantId: string;
    endUserId: string;
    channel: Conversation["channel"];
    conversationId?: string;
  }): Promise<ResumeResult> {
    if (input.conversationId) {
      return this.resume({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        lastSeq: 0,
      });
    }
    const conversation = await this.data.createConversation({
      tenantId: input.tenantId,
      endUserId: input.endUserId,
      channel: input.channel,
    });
    await this.cache.setConversationSeq(conversation.id, 0);
    await this.data.appendEvent({
      conversationId: conversation.id,
      tenantId: input.tenantId,
      type: "conversation.created",
      actor: { type: "user", id: input.endUserId },
      payload: { channel: input.channel },
    });
    return { conversation, messages: [], resumed: false };
  }

  /**
   * Reconnect path.
   *
   * The fast path matters more than it looks: a deploy drops every socket at
   * once, so this runs for every connected client within a few seconds. When the
   * client already has everything, the cached head sequence answers it and the
   * messages table is never touched, which is the difference between a reconnect
   * wave costing one indexed row read per client and costing an unbounded range
   * scan per client.
   */
  async resume(input: {
    tenantId: string;
    conversationId: string;
    lastSeq: number;
  }): Promise<ResumeResult> {
    const conversation = await this.data.getConversation(
      input.tenantId,
      input.conversationId,
    );
    if (!conversation) {
      throw new SupportChatError(
        "conversation_not_found",
        "That conversation does not exist.",
      );
    }

    const cachedSeq = await this.cache.getConversationSeq(conversation.id);
    const headSeq = cachedSeq ?? conversation.lastSeq;
    if (input.lastSeq >= headSeq) {
      return { conversation, messages: [], resumed: true };
    }

    const messages = await this.data.listMessages(conversation.id, {
      afterSeq: input.lastSeq,
      limit: REPLAY_LIMIT,
    });
    return { conversation, messages, resumed: true };
  }

  async appendUserMessage(input: {
    tenantId: string;
    conversationId: string;
    endUserId: string;
    clientMessageId: string;
    body: string;
  }): Promise<Message> {
    const conversation = await this.requireOpenConversation(
      input.tenantId,
      input.conversationId,
    );
    const message = await this.data.appendMessage({
      conversationId: conversation.id,
      tenantId: input.tenantId,
      senderType: "user",
      senderId: input.endUserId,
      body: input.body,
      clientMessageId: input.clientMessageId,
    });
    await this.cache.setConversationSeq(conversation.id, message.seq);
    return message;
  }

  async appendAgentMessage(input: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    clientMessageId: string;
    body: string;
  }): Promise<Message> {
    const conversation = await this.requireOpenConversation(
      input.tenantId,
      input.conversationId,
    );
    if (conversation.assignedAgentId !== input.agentId) {
      throw new SupportChatError(
        "forbidden",
        "This conversation is assigned to a different agent.",
      );
    }
    const message = await this.data.appendMessage({
      conversationId: conversation.id,
      tenantId: input.tenantId,
      senderType: "agent",
      senderId: input.agentId,
      body: input.body,
      clientMessageId: input.clientMessageId,
    });
    await this.cache.setConversationSeq(conversation.id, message.seq);
    return message;
  }

  /**
   * An explicit "talk to a human" from the user.
   *
   * Handled before any model call so that it cannot be overridden, ignored, or
   * reasoned away: when someone asks for a person, they get queued for a person.
   */
  async requestHandoff(input: {
    tenantId: string;
    conversationId: string;
    endUserId: string;
    reason?: string;
  }): Promise<Conversation> {
    const conversation = await this.requireOpenConversation(
      input.tenantId,
      input.conversationId,
    );
    if (conversation.status === "assigned" || conversation.status === "queued") {
      return conversation;
    }
    await this.data.setConversationStatus(conversation.id, "queued");
    await this.cache.enqueue(input.tenantId, conversation.id);
    await this.data.appendEvent({
      conversationId: conversation.id,
      tenantId: input.tenantId,
      type: "escalation.triggered",
      actor: { type: "user", id: input.endUserId },
      payload: { trigger: "user_request", reason: input.reason ?? null },
    });
    await this.data.appendEvent({
      conversationId: conversation.id,
      tenantId: input.tenantId,
      type: "handoff.queued",
      actor: { type: "system", id: null },
      payload: {},
    });
    return { ...conversation, status: "queued" };
  }

  async queuePosition(tenantId: string, conversationId: string): Promise<number | null> {
    return this.cache.queuePosition(tenantId, conversationId);
  }

  private async requireOpenConversation(
    tenantId: string,
    conversationId: string,
  ): Promise<Conversation> {
    const conversation = await this.data.getConversation(tenantId, conversationId);
    if (!conversation) {
      throw new SupportChatError(
        "conversation_not_found",
        "That conversation does not exist.",
      );
    }
    if (conversation.status === "resolved") {
      throw new SupportChatError("conversation_closed", "That conversation is closed.");
    }
    return conversation;
  }
}
