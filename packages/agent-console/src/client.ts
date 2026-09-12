import {
  decodeFrame,
  envelope,
  newFrameId,
  reconnectDelay,
  serverToAgentSchema,
  type AgentRecord,
  type Conversation,
  type Diagnosis,
  type Message,
  type ServerToAgent,
  type Urgency,
} from "@gagandeep023/support-chat-core";
import type { Transport, TransportFactory } from "./transport.js";

export interface Offer {
  conversationId: string;
  summary: string;
  urgency: Urgency;
  diagnosis: Diagnosis | null;
  waitingSince: string;
  expiresAt: string;
  /** Set while an accept or decline is in flight. */
  responding: "accept" | "decline" | null;
}

export interface ActiveConversation {
  conversation: Conversation;
  messages: Message[];
  diagnosis: Diagnosis | null;
}

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface AgentConsoleState {
  connection: ConnectionState;
  agent: AgentRecord | null;
  offers: Offer[];
  conversations: ActiveConversation[];
  activeConversationId: string | null;
  queueDepth: number;
  error: string | null;
}

export interface AgentConsoleOptions {
  transport: TransportFactory;
  /** Presence heartbeat interval. Must stay well inside the server's TTL. */
  heartbeatMs?: number;
  now?: () => number;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  random?: () => number;
}

const INITIAL: AgentConsoleState = {
  connection: "idle",
  agent: null,
  offers: [],
  conversations: [],
  activeConversationId: null,
  queueDepth: 0,
  error: null,
};

/**
 * Headless agent console.
 *
 * Same shape as the widget client and for the same reason: all protocol logic in
 * one transport-agnostic object, so the React surface is a skin and the whole
 * thing is testable without a browser. `subscribe` fires immediately with the
 * current state, so a component mounting mid-session sees everything rather than
 * waiting for the next change.
 */
export class AgentConsoleClient {
  private state: AgentConsoleState = INITIAL;
  private readonly listeners = new Set<(state: AgentConsoleState) => void>();
  private transport: Transport | null = null;
  private readonly factory: TransportFactory;

  private attempt = 0;
  private retryHandle: unknown = null;
  private heartbeatHandle: unknown = null;
  private closedByUser = false;

  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly schedule: (handler: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly repeat: (handler: () => void, ms: number) => unknown;
  private readonly stopRepeat: (handle: unknown) => void;
  private readonly random: () => number;

  constructor(options: AgentConsoleOptions) {
    this.factory = options.transport;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.now = options.now ?? Date.now;
    this.schedule = options.setTimeout ?? ((h, ms) => setTimeout(h, ms));
    this.cancel = options.clearTimeout ?? ((h) => clearTimeout(h as never));
    this.repeat = options.setInterval ?? ((h, ms) => setInterval(h, ms));
    this.stopRepeat = options.clearInterval ?? ((h) => clearInterval(h as never));
    this.random = options.random ?? Math.random;
  }

  getState(): AgentConsoleState {
    return this.state;
  }

  subscribe(listener: (state: AgentConsoleState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  connect(): void {
    if (this.transport) return;
    this.closedByUser = false;
    this.patch({ connection: this.attempt === 0 ? "connecting" : "reconnecting" });
    this.transport = this.factory({
      onOpen: () => this.handleOpen(),
      onFrame: (raw) => this.handleFrame(raw),
      onClose: () => this.handleClose(),
      onError: (error) => this.patch({ error: error.message }),
    });
    this.transport.connect();
  }

  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.retryHandle) this.cancel(this.retryHandle);
    this.retryHandle = null;
    // Sent before disconnecting so presence is dropped at once. Leaving it to
    // expire means the router keeps offering conversations to a console that has
    // deliberately gone away.
    this.emit("agent.heartbeat", { status: "offline" });
    this.transport?.close();
    this.transport = null;
    this.patch({ connection: "closed" });
  }

  respond(conversationId: string, accept: boolean): void {
    this.patch({
      offers: this.state.offers.map((offer) =>
        offer.conversationId === conversationId
          ? { ...offer, responding: accept ? ("accept" as const) : ("decline" as const) }
          : offer,
      ),
    });
    this.emit("agent.offer.respond", { conversationId, accept });
  }

  select(conversationId: string | null): void {
    this.patch({ activeConversationId: conversationId });
    if (conversationId && !this.state.conversations.some((c) => c.conversation.id === conversationId)) {
      this.emit("agent.conversation.subscribe", { conversationId });
    }
  }

  send(conversationId: string, body: string): void {
    const trimmed = body.trim();
    if (!trimmed) return;
    this.emit("agent.message.send", {
      conversationId,
      clientMessageId: `${this.now().toString(36)}-${Math.floor(this.random() * 1e9).toString(36)}`,
      body: trimmed,
    });
  }

  resolve(conversationId: string, options: { note?: string; promoteToKnowledge?: boolean } = {}): void {
    this.emit("agent.conversation.resolve", {
      conversationId,
      ...(options.note ? { note: options.note } : {}),
      // Always an explicit human decision. Promoting every resolution
      // automatically would teach the bot every wrong answer an agent ever gave,
      // permanently and with full confidence.
      ...(options.promoteToKnowledge ? { promoteToKnowledge: true } : {}),
    });
    this.patch({
      conversations: this.state.conversations.filter(
        (c) => c.conversation.id !== conversationId,
      ),
      activeConversationId:
        this.state.activeConversationId === conversationId
          ? null
          : this.state.activeConversationId,
    });
  }

  /** Call when the tab becomes visible again, to re-assert presence at once. */
  ping(): void {
    this.emit("agent.heartbeat", { status: "online" });
  }

  private handleOpen(): void {
    this.patch({ connection: "open", error: null });
    this.emit("agent.hello", {});
    this.startHeartbeat();
  }

  private handleClose(): void {
    this.transport = null;
    this.stopHeartbeat();
    if (this.closedByUser) return;
    // Offers cannot be answered from a dead socket, and a stale card invites an
    // agent to accept something that has already gone to somebody else.
    this.patch({ connection: "reconnecting", offers: [] });
    this.scheduleReconnect();
  }

  private scheduleReconnect(hintMs?: number): void {
    if (this.retryHandle) this.cancel(this.retryHandle);
    const delay = reconnectDelay({
      attempt: this.attempt,
      random: this.random,
      ...(hintMs !== undefined ? { hintMs } : {}),
    });
    this.attempt += 1;
    this.retryHandle = this.schedule(() => {
      this.retryHandle = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatHandle = this.repeat(() => {
      this.emit("agent.heartbeat", { status: "online" });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle) this.stopRepeat(this.heartbeatHandle);
    this.heartbeatHandle = null;
  }

  private emit(type: string, payload: unknown): void {
    this.transport?.send(envelope(type, payload, newFrameId()));
  }

  private handleFrame(raw: unknown): void {
    const decoded = decodeFrame(serverToAgentSchema, raw);
    if (!decoded.ok) return;
    this.apply(decoded.frame);
  }

  private apply(frame: ServerToAgent): void {
    switch (frame.type) {
      case "agent.ready": {
        // Reaching hello is proof the connection works; only then is the backoff
        // reset, so a server that accepts sockets and dies keeps being backed off.
        this.attempt = 0;
        this.patch({
          agent: frame.payload.agent,
          queueDepth: frame.payload.queueDepth,
          conversations: frame.payload.assigned.map((conversation) => ({
            conversation,
            messages: [],
            diagnosis: null,
          })),
        });
        return;
      }

      case "agent.offer": {
        const offer: Offer = {
          conversationId: frame.payload.conversationId,
          summary: frame.payload.summary,
          urgency: frame.payload.urgency,
          diagnosis: frame.payload.diagnosis,
          waitingSince: frame.payload.waitingSince,
          expiresAt: frame.payload.expiresAt,
          responding: null,
        };
        this.patch({
          offers: [
            ...this.state.offers.filter((o) => o.conversationId !== offer.conversationId),
            offer,
          ],
        });
        return;
      }

      case "agent.offer.revoked": {
        this.patch({
          offers: this.state.offers.filter(
            (offer) => offer.conversationId !== frame.payload.conversationId,
          ),
          ...(frame.payload.reason === "taken"
            ? { error: "That conversation was taken by someone else." }
            : {}),
        });
        return;
      }

      case "agent.conversation.assigned": {
        const { conversation, messages, diagnosis } = frame.payload;
        const others = this.state.conversations.filter(
          (c) => c.conversation.id !== conversation.id,
        );
        this.patch({
          offers: this.state.offers.filter((o) => o.conversationId !== conversation.id),
          conversations: [...others, { conversation, messages, diagnosis }],
          // Opened automatically only when nothing else is being worked on, so an
          // incoming assignment never yanks the view away mid-reply.
          activeConversationId: this.state.activeConversationId ?? conversation.id,
          error: null,
        });
        return;
      }

      case "message.new": {
        const message = frame.payload.message;
        this.patch({
          conversations: this.state.conversations.map((entry) =>
            entry.conversation.id === message.conversationId
              ? {
                  ...entry,
                  messages: entry.messages.some((m) => m.id === message.id)
                    ? entry.messages
                    : [...entry.messages, message],
                }
              : entry,
          ),
        });
        return;
      }

      case "queue.update": {
        this.patch({ queueDepth: frame.payload.depth });
        return;
      }

      case "server.draining": {
        this.transport?.close();
        this.transport = null;
        this.stopHeartbeat();
        this.attempt = 0;
        this.patch({ connection: "reconnecting", offers: [] });
        this.scheduleReconnect(frame.payload.reconnectAfterMs);
        return;
      }

      case "error": {
        this.patch({ error: frame.payload.message });
        return;
      }
    }
  }

  private patch(partial: Partial<AgentConsoleState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }
}
