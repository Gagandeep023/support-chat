import {
  PROTOCOL_VERSION,
  decodeFrame,
  envelope,
  newFrameId,
  reconnectDelay,
  serverToWidgetSchema,
  type ConversationStatus,
  type Message,
  type ServerToWidget,
} from "@gagandeep023/support-chat-core";
import type { Transport, TransportFactory } from "./transport.js";

export type MessageRole = "user" | "ai" | "agent" | "system";

export interface WidgetMessage {
  id: string;
  role: MessageRole;
  body: string;
  at: string;
  /** `pending` is not yet acked; `streaming` is still arriving. */
  state: "pending" | "sent" | "streaming" | "done";
  clientMessageId?: string;
}

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface WidgetState {
  connection: ConnectionState;
  conversationId: string | null;
  status: ConversationStatus | null;
  queuePosition: number | null;
  messages: WidgetMessage[];
  /** Someone on the other side is composing: the bot or an assigned agent. */
  typing: boolean;
  error: string | null;
}

export interface ClientOptions {
  transport: TransportFactory;
  /** Overridable for tests. */
  now?: () => number;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  storageKey?: string;
}

const INITIAL: WidgetState = {
  connection: "idle",
  conversationId: null,
  status: null,
  queuePosition: null,
  messages: [],
  typing: false,
  error: null,
};

/**
 * Transport-agnostic widget client.
 *
 * State is exposed through `subscribe`, which fires immediately with the current
 * value rather than only on future changes. That is deliberate: an event-only
 * API makes it easy to attach a listener after the thing you were waiting for
 * already happened, and with a fast reply the whole exchange can complete
 * between a send and a later subscription. A snapshot on subscribe makes that
 * mistake impossible to write.
 */
export class SupportChatClient {
  private state: WidgetState = INITIAL;
  private readonly listeners = new Set<(state: WidgetState) => void>();
  private transport: Transport | null = null;
  private readonly factory: TransportFactory;

  /** Sends that have not been acked. Survives a reconnect and is replayed. */
  private readonly outbox = new Map<string, { conversationId: string; body: string }>();
  private lastSeq = 0;
  private attempt = 0;
  private retryHandle: unknown = null;
  private closedByUser = false;

  private readonly now: () => number;
  private readonly schedule: (handler: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly random: () => number;
  private readonly storage: ClientOptions["storage"];
  private readonly storageKey: string;

  constructor(options: ClientOptions) {
    this.factory = options.transport;
    this.now = options.now ?? Date.now;
    this.schedule = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
    this.random = options.random ?? Math.random;
    this.storageKey = options.storageKey ?? "support-chat:conversation";
    this.storage =
      options.storage === undefined ? safeLocalStorage() : options.storage;
  }

  getState(): WidgetState {
    return this.state;
  }

  subscribe(listener: (state: WidgetState) => void): () => void {
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

  send(body: string): void {
    const trimmed = body.trim();
    if (!trimmed) return;
    const conversationId = this.state.conversationId;
    if (!conversationId) return;

    const clientMessageId = `${this.now().toString(36)}-${Math.floor(this.random() * 1e9).toString(36)}`;
    this.outbox.set(clientMessageId, { conversationId, body: trimmed });
    this.patch({
      messages: [
        ...this.state.messages,
        {
          id: clientMessageId,
          role: "user",
          body: trimmed,
          at: new Date(this.now()).toISOString(),
          state: "pending",
          clientMessageId,
        },
      ],
    });
    this.flush();
  }

  requestHuman(reason?: string): void {
    if (!this.state.conversationId) return;
    this.emit("handoff.request", {
      conversationId: this.state.conversationId,
      ...(reason ? { reason } : {}),
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryHandle) this.cancel(this.retryHandle);
    this.retryHandle = null;
    this.transport?.close();
    this.transport = null;
    this.patch({ connection: "closed" });
  }

  /** Forget the stored conversation and start a new one on next connect. */
  reset(): void {
    this.writeStoredConversation(null);
    this.lastSeq = 0;
    this.outbox.clear();
    this.state = { ...INITIAL };
    this.notify();
  }

  private handleOpen(): void {
    // The backoff counter is deliberately NOT reset here. A transport that opens
    // and immediately dies (a pod crash-looping, a proxy accepting then closing)
    // would otherwise reset the backoff on every cycle and retry at full rate
    // forever. It resets on `session.ready`, which is proof the connection was
    // good enough to do actual work.
    this.patch({ connection: "open", error: null });

    const stored = this.readStoredConversation();
    if (stored) {
      this.emit("session.resume", { conversationId: stored, lastSeq: this.lastSeq });
    } else {
      this.emit("session.start", {});
    }
  }

  private handleClose(): void {
    this.transport = null;
    if (this.closedByUser) return;
    this.patch({ connection: "reconnecting", typing: false });
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

  private flush(): void {
    if (!this.transport?.connected) return;
    for (const [clientMessageId, entry] of this.outbox) {
      this.emit("message.send", {
        conversationId: entry.conversationId,
        clientMessageId,
        body: entry.body,
      });
    }
  }

  private emit(type: string, payload: unknown): void {
    this.transport?.send(envelope(type, payload, newFrameId()));
  }

  private handleFrame(raw: unknown): void {
    const decoded = decodeFrame(serverToWidgetSchema, raw);
    if (!decoded.ok) {
      // An unparseable frame from the server is not something a user can act on,
      // and tearing the session down over it would be worse than ignoring it.
      if (decoded.code === "unsupported_protocol_version") {
        this.patch({
          error: `This chat needs updating (server speaks a newer protocol than v${PROTOCOL_VERSION}).`,
        });
      }
      return;
    }
    this.apply(decoded.frame);
  }

  private apply(frame: ServerToWidget): void {
    switch (frame.type) {
      case "session.ready": {
        const { conversation, messages } = frame.payload;
        this.attempt = 0;
        this.writeStoredConversation(conversation.id);
        this.lastSeq = Math.max(this.lastSeq, conversation.lastSeq);
        this.patch({
          conversationId: conversation.id,
          status: conversation.status,
          messages: mergeServerMessages(this.state.messages, messages),
        });
        // Anything typed while disconnected goes out now, under its original
        // clientMessageId so a message that did land is not posted twice.
        this.flush();
        return;
      }

      case "message.ack": {
        const { clientMessageId, messageId, seq } = frame.payload;
        this.outbox.delete(clientMessageId);
        this.lastSeq = Math.max(this.lastSeq, seq);
        this.patch({
          messages: this.state.messages.map((message) =>
            message.clientMessageId === clientMessageId
              ? { ...message, id: messageId, state: "sent" as const }
              : message,
          ),
        });
        return;
      }

      case "message.delta": {
        const { messageId, text } = frame.payload;
        const existing = this.state.messages.find((m) => m.id === messageId);
        this.patch({
          typing: true,
          messages: existing
            ? this.state.messages.map((m) =>
                m.id === messageId ? { ...m, body: m.body + text } : m,
              )
            : [
                ...this.state.messages,
                {
                  id: messageId,
                  role: "ai",
                  body: text,
                  at: new Date(this.now()).toISOString(),
                  state: "streaming" as const,
                },
              ],
        });
        return;
      }

      case "message.complete":
      case "message.new": {
        const message = frame.payload.message;
        this.lastSeq = Math.max(this.lastSeq, message.seq);
        this.patch({
          typing: false,
          messages: upsertMessage(this.state.messages, message),
        });
        return;
      }

      case "conversation.status": {
        this.patch({
          status: frame.payload.status,
          queuePosition: frame.payload.queuePosition,
        });
        return;
      }

      case "typing": {
        this.patch({ typing: frame.payload.typing });
        return;
      }

      case "tool.decision.request": {
        return;
      }

      case "server.draining": {
        // The server chose this delay, spread across connected clients. Honouring
        // it is the entire mechanism that stops a deploy from stampeding.
        this.transport?.close();
        this.transport = null;
        this.attempt = 0;
        this.patch({ connection: "reconnecting", typing: false });
        this.scheduleReconnect(frame.payload.reconnectAfterMs);
        return;
      }

      case "error": {
        this.patch({ error: frame.payload.message });
        return;
      }
    }
  }

  private patch(partial: Partial<WidgetState>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private readStoredConversation(): string | null {
    if (this.state.conversationId) return this.state.conversationId;
    try {
      return this.storage?.getItem(this.storageKey) ?? null;
    } catch {
      return null;
    }
  }

  private writeStoredConversation(id: string | null): void {
    try {
      if (id) this.storage?.setItem(this.storageKey, id);
      else this.storage?.removeItem(this.storageKey);
    } catch {
      // Private browsing, blocked site data, or a preview frame. A widget that
      // throws here is worse than one that forgets the conversation on refresh.
    }
  }
}

function safeLocalStorage(): ClientOptions["storage"] {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function toWidgetMessage(message: Message): WidgetMessage {
  return {
    id: message.id,
    role: message.senderType,
    body: message.body ?? "",
    at: message.createdAt,
    state: "done",
    ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
  };
}

function upsertMessage(current: WidgetMessage[], message: Message): WidgetMessage[] {
  const next = toWidgetMessage(message);
  const index = current.findIndex(
    (m) =>
      m.id === message.id ||
      (message.clientMessageId !== null && m.clientMessageId === message.clientMessageId),
  );
  if (index === -1) return [...current, next];
  const copy = [...current];
  copy[index] = next;
  return copy;
}

function mergeServerMessages(
  current: WidgetMessage[],
  messages: Message[],
): WidgetMessage[] {
  let merged = current;
  for (const message of messages) merged = upsertMessage(merged, message);
  return merged;
}
