import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AgentConsoleClient, type AgentConsoleState, type Offer } from "./client.js";
import { socketIoTransport } from "./transport.js";

export interface UseAgentConsoleOptions {
  tenantId: string;
  /**
   * Mints a short-lived agent token from the host application's own session.
   *
   * This is the whole integration surface. The host owns agent identity; this
   * package builds no signup, login, or password reset, and the agent record on
   * the server is a projection of the host's user created on first connect.
   */
  fetchToken: () => Promise<string>;
  url?: string;
  basePath?: string;
  autoConnect?: boolean;
}

export interface AgentConsoleApi {
  state: AgentConsoleState;
  accept(conversationId: string): void;
  decline(conversationId: string): void;
  select(conversationId: string | null): void;
  send(conversationId: string, body: string): void;
  resolve(
    conversationId: string,
    options?: { note?: string; promoteToKnowledge?: boolean },
  ): void;
  client: AgentConsoleClient;
}

export function useAgentConsole(options: UseAgentConsoleOptions): AgentConsoleApi {
  const { tenantId, fetchToken, url, basePath, autoConnect = true } = options;
  const tokenRef = useRef(fetchToken);
  tokenRef.current = fetchToken;

  const client = useMemo(
    () =>
      new AgentConsoleClient({
        transport: socketIoTransport({
          url: url ?? (typeof window === "undefined" ? "" : window.location.origin),
          ...(basePath ? { basePath } : {}),
          tenantId,
          fetchToken: () => tokenRef.current(),
        }),
      }),
    [tenantId, url, basePath],
  );

  useEffect(() => {
    if (autoConnect) client.connect();
    return () => client.close();
  }, [client, autoConnect]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    // Browsers throttle timers in hidden tabs to around one per minute, which
    // can outlast a presence TTL. Re-asserting the moment the tab is looked at
    // again closes the window where an agent is present but considered offline.
    const onVisible = () => {
      if (document.visibilityState === "visible") client.ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [client]);

  const state = useSyncExternalStore(
    (onChange) => client.subscribe(() => onChange()),
    () => client.getState(),
    () => client.getState(),
  );

  return {
    state,
    accept: (id) => client.respond(id, true),
    decline: (id) => client.respond(id, false),
    select: (id) => client.select(id),
    send: (id, body) => client.send(id, body),
    resolve: (id, opts) => client.resolve(id, opts ?? {}),
    client,
  };
}

/** Seconds left on an offer, ticking once a second. */
function useCountdown(expiresAt: string): number {
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000)),
  );
  useEffect(() => {
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000)));
    tick();
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, [expiresAt]);
  return remaining;
}

function OfferCard({
  offer,
  onAccept,
  onDecline,
}: {
  offer: Offer;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const remaining = useCountdown(offer.expiresAt);
  return (
    <article data-urgency={offer.urgency} aria-label="Incoming conversation">
      <p>{offer.summary}</p>
      {/* The diagnosis, when a host diagnostic ran. The agent opens already
          knowing the cause instead of asking the customer to repeat themselves. */}
      {offer.diagnosis && (
        <dl>
          <dt>Diagnosis</dt>
          <dd>
            {offer.diagnosis.code} ({offer.diagnosis.confidence})
          </dd>
          {offer.diagnosis.evidence.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p aria-live="off">{remaining}s to respond</p>
      <button type="button" onClick={onAccept} disabled={offer.responding !== null}>
        {offer.responding === "accept" ? "Accepting..." : "Accept"}
      </button>
      <button type="button" onClick={onDecline} disabled={offer.responding !== null}>
        Pass
      </button>
    </article>
  );
}

export interface AgentConsoleProps extends UseAgentConsoleOptions {
  className?: string;
}

/**
 * Drop-in console.
 *
 * Unstyled by design beyond structure: it mounts inside the customer's existing
 * dashboard, so imposing a visual identity on it would fight whatever design
 * system is already there. Data attributes and semantic elements give them
 * something to style against.
 */
export function AgentConsole(props: AgentConsoleProps): React.ReactElement {
  const { state, accept, decline, select, send, resolve } = useAgentConsole(props);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const active = state.conversations.find(
    (entry) => entry.conversation.id === state.activeConversationId,
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const input = inputRef.current;
    if (!input?.value.trim() || !active) return;
    send(active.conversation.id, input.value);
    input.value = "";
  };

  return (
    <div className={props.className} data-connection={state.connection}>
      <header>
        <span>{state.agent?.displayName ?? "Connecting..."}</span>
        <span data-testid="queue-depth">{state.queueDepth} waiting</span>
        {state.connection === "reconnecting" && <span role="status">Reconnecting...</span>}
        {state.error && <p role="alert">{state.error}</p>}
      </header>

      <section aria-label="Offers">
        {state.offers.map((offer) => (
          <OfferCard
            key={offer.conversationId}
            offer={offer}
            onAccept={() => accept(offer.conversationId)}
            onDecline={() => decline(offer.conversationId)}
          />
        ))}
      </section>

      <nav aria-label="Your conversations">
        {state.conversations.map((entry) => (
          <button
            key={entry.conversation.id}
            type="button"
            aria-current={entry.conversation.id === state.activeConversationId}
            onClick={() => select(entry.conversation.id)}
          >
            {entry.conversation.subject ?? entry.conversation.id.slice(0, 12)}
          </button>
        ))}
      </nav>

      {active && (
        <section aria-label="Transcript">
          <div role="log">
            {/* Everything the bot already tried is here, so the agent does not
                restart the conversation from zero. */}
            {active.messages.map((message) => (
              <p key={message.id} data-sender={message.senderType}>
                {message.body}
              </p>
            ))}
          </div>

          <form onSubmit={submit}>
            <textarea ref={inputRef} rows={2} aria-label="Reply" />
            <button type="submit">Send</button>
          </form>

          <button
            type="button"
            onClick={() => resolve(active.conversation.id, { promoteToKnowledge: false })}
          >
            Resolve
          </button>
          <button
            type="button"
            onClick={() => resolve(active.conversation.id, { promoteToKnowledge: true })}
          >
            Resolve and add to knowledge base
          </button>
        </section>
      )}
    </div>
  );
}
