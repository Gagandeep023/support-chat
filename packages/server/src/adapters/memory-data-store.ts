import {
  newConversationId,
  newEndUserId,
  newEventId,
  newMessageId,
  newAgentId,
  type AgentRecord,
  type Conversation,
  type ConversationEvent,
  type ConversationStatus,
  type EndUser,
  type Message,
  type Tenant,
} from "@gagandeep023/support-chat-core";
import type {
  ConversationFilter,
  DataStore,
  NewMessage,
  Page,
} from "../stores/data-store.js";

/**
 * In-memory DataStore.
 *
 * Serves two real purposes: it is the reference implementation the other
 * adapters are checked against, and it backs `support-chat dev`, where the
 * point is that evaluating this takes no infrastructure at all.
 */
export class MemoryDataStore implements DataStore {
  private readonly tenants = new Map<string, Tenant>();
  private readonly endUsers = new Map<string, EndUser>();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, Message[]>();
  private readonly events = new Map<string, ConversationEvent[]>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  seedTenant(tenant: Tenant): Tenant {
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  async getTenant(id: string): Promise<Tenant | null> {
    return this.tenants.get(id) ?? null;
  }

  async getTenantByPublishableKey(key: string): Promise<Tenant | null> {
    for (const tenant of this.tenants.values()) {
      if (tenant.publishableKey === key) return tenant;
    }
    return null;
  }

  async upsertEndUser(input: {
    tenantId: string;
    externalId: string | null;
    displayName?: string | null;
    email?: string | null;
    attributes?: Record<string, unknown>;
  }): Promise<EndUser> {
    if (input.externalId !== null) {
      for (const user of this.endUsers.values()) {
        if (user.tenantId === input.tenantId && user.externalId === input.externalId) {
          return user;
        }
      }
    }
    const user: EndUser = {
      id: newEndUserId(),
      tenantId: input.tenantId,
      externalId: input.externalId,
      isAnonymous: input.externalId === null,
      displayName: input.displayName ?? null,
      email: input.email ?? null,
      attributes: input.attributes ?? {},
      createdAt: new Date().toISOString(),
    };
    this.endUsers.set(user.id, user);
    return user;
  }

  async upsertAgent(input: {
    tenantId: string;
    externalId: string;
    displayName: string;
    avatarUrl?: string | null;
    skills?: string[];
    maxConcurrent?: number;
    role?: AgentRecord["role"];
  }): Promise<AgentRecord> {
    for (const agent of this.agents.values()) {
      if (agent.tenantId === input.tenantId && agent.externalId === input.externalId) {
        const updated: AgentRecord = {
          ...agent,
          displayName: input.displayName,
          avatarUrl: input.avatarUrl ?? agent.avatarUrl,
          skills: input.skills ?? agent.skills,
          maxConcurrent: input.maxConcurrent ?? agent.maxConcurrent,
          role: input.role ?? agent.role,
        };
        this.agents.set(updated.id, updated);
        return updated;
      }
    }
    const agent: AgentRecord = {
      id: newAgentId(),
      tenantId: input.tenantId,
      externalId: input.externalId,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl ?? null,
      skills: input.skills ?? [],
      maxConcurrent: input.maxConcurrent ?? 3,
      role: input.role ?? "agent",
      createdAt: new Date().toISOString(),
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  async getAgent(tenantId: string, id: string): Promise<AgentRecord | null> {
    const agent = this.agents.get(id);
    return agent && agent.tenantId === tenantId ? agent : null;
  }

  async createConversation(input: {
    tenantId: string;
    endUserId: string;
    channel: Conversation["channel"];
  }): Promise<Conversation> {
    const conversation: Conversation = {
      id: newConversationId(),
      tenantId: input.tenantId,
      endUserId: input.endUserId,
      status: "ai",
      assignedAgentId: null,
      channel: input.channel,
      subject: null,
      tags: [],
      lastSeq: 0,
      lastMessageAt: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.conversations.set(conversation.id, conversation);
    this.messages.set(conversation.id, []);
    return conversation;
  }

  async getConversation(tenantId: string, id: string): Promise<Conversation | null> {
    const conversation = this.conversations.get(id);
    return conversation && conversation.tenantId === tenantId ? conversation : null;
  }

  async setConversationStatus(id: string, status: ConversationStatus): Promise<void> {
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    this.conversations.set(id, {
      ...conversation,
      status,
      resolvedAt: status === "resolved" ? new Date().toISOString() : conversation.resolvedAt,
    });
  }

  async assignConversation(id: string, agentId: string | null): Promise<void> {
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    this.conversations.set(id, { ...conversation, assignedAgentId: agentId });
  }

  async listConversations(
    tenantId: string,
    filter: ConversationFilter,
  ): Promise<Page<Conversation>> {
    const all = [...this.conversations.values()]
      .filter((c) => c.tenantId === tenantId)
      .filter((c) => (filter.status ? c.status === filter.status : true))
      .filter((c) => (filter.agentId ? c.assignedAgentId === filter.agentId : true))
      .filter((c) => (filter.cursor ? c.id > filter.cursor : true))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const items = all.slice(0, filter.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: all.length > filter.limit && last ? last.id : null,
    };
  }

  async appendMessage(input: NewMessage): Promise<Message> {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) {
      throw new Error(`Unknown conversation ${input.conversationId}`);
    }
    const existing = this.messages.get(input.conversationId) ?? [];

    // Idempotency. A client retrying a send across a reconnect must get its
    // original message back rather than post a duplicate.
    if (input.clientMessageId) {
      const duplicate = existing.find((m) => m.clientMessageId === input.clientMessageId);
      if (duplicate) return duplicate;
    }

    const seq = conversation.lastSeq + 1;
    const message: Message = {
      id: input.id ?? newMessageId(),
      conversationId: input.conversationId,
      tenantId: input.tenantId,
      seq,
      senderType: input.senderType,
      senderId: input.senderId,
      body: input.body,
      bodyEncrypted: null,
      contentType: input.contentType ?? "text/plain",
      clientMessageId: input.clientMessageId ?? null,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    existing.push(message);
    this.messages.set(input.conversationId, existing);
    this.conversations.set(conversation.id, {
      ...conversation,
      lastSeq: seq,
      lastMessageAt: message.createdAt,
    });
    return message;
  }

  async listMessages(
    conversationId: string,
    options: { afterSeq?: number; limit: number },
  ): Promise<Message[]> {
    const after = options.afterSeq ?? 0;
    return (this.messages.get(conversationId) ?? [])
      .filter((m) => m.seq > after)
      .slice(0, options.limit);
  }

  async appendEvent(event: Omit<ConversationEvent, "id" | "createdAt">): Promise<void> {
    const list = this.events.get(event.conversationId) ?? [];
    list.push({ ...event, id: newEventId(), createdAt: new Date().toISOString() });
    this.events.set(event.conversationId, list);
  }

  async listEvents(conversationId: string): Promise<ConversationEvent[]> {
    return this.events.get(conversationId) ?? [];
  }
}
