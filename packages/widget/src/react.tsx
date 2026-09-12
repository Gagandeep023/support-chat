import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { SupportChatClient, type WidgetState } from "./client.js";
import { socketIoTransport } from "./transport.js";

export interface UseSupportChatOptions {
  publishableKey: string;
  url?: string;
  basePath?: string;
  /** Host-computed HMAC of externalId. Never derive this in the browser. */
  identity?: { externalId: string; userHash: string };
  autoConnect?: boolean;
}

export interface SupportChatApi {
  state: WidgetState;
  send(body: string): void;
  requestHuman(reason?: string): void;
  reset(): void;
  client: SupportChatClient;
}

/**
 * Tier three of the theming contract: all state and actions, no DOM.
 *
 * `useSyncExternalStore` rather than an effect that copies state into `useState`,
 * so a render that happens between subscribe and the first change still reads
 * the current value instead of a stale initial one.
 */
export function useSupportChat(options: UseSupportChatOptions): SupportChatApi {
  const { publishableKey, url, basePath, autoConnect = true } = options;
  const externalId = options.identity?.externalId;
  const userHash = options.identity?.userHash;

  const client = useMemo(
    () =>
      new SupportChatClient({
        transport: socketIoTransport({
          url: url ?? (typeof window === "undefined" ? "" : window.location.origin),
          ...(basePath ? { basePath } : {}),
          auth: {
            publishableKey,
            ...(externalId && userHash ? { externalId, userHash } : {}),
          },
        }),
      }),
    [publishableKey, url, basePath, externalId, userHash],
  );

  useEffect(() => {
    if (autoConnect) client.connect();
    return () => client.close();
  }, [client, autoConnect]);

  const state = useSyncExternalStore(
    (onChange) => client.subscribe(() => onChange()),
    () => client.getState(),
    () => client.getState(),
  );

  return {
    state,
    send: (body: string) => client.send(body),
    requestHuman: (reason?: string) => client.requestHuman(reason),
    reset: () => client.reset(),
    client,
  };
}

export interface SupportChatProps extends UseSupportChatOptions {
  heading?: string;
  greeting?: string;
  /** Tier two: swap a part without forking the widget. */
  renderMessage?: (message: WidgetState["messages"][number]) => React.ReactNode;
  renderHeader?: (state: WidgetState) => React.ReactNode;
  className?: string;
}

/**
 * React wrapper around the same client the web component uses.
 *
 * Thin on purpose. The protocol logic lives in `SupportChatClient`, so the React
 * and custom-element surfaces cannot drift apart in how they buffer sends,
 * resume, or honour a drain notice.
 */
export function SupportChat(props: SupportChatProps): React.ReactElement {
  const { state, send, requestHuman } = useSupportChat(props);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.messages, state.typing]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const input = inputRef.current;
    if (!input?.value.trim()) return;
    send(input.value);
    input.value = "";
  };

  return (
    <section className={props.className} aria-label={props.heading ?? "Support chat"}>
      {props.renderHeader?.(state) ?? <h2>{props.heading ?? "Support"}</h2>}

      {state.connection === "reconnecting" && <p role="status">Reconnecting...</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {state.status === "queued" && (
        <p role="status">
          Waiting for a teammate
          {state.queuePosition ? ` (position ${state.queuePosition})` : ""}
        </p>
      )}

      <div ref={logRef} role="log" aria-live="polite">
        {state.messages.length === 0 && <p>{props.greeting ?? "Ask us anything."}</p>}
        {state.messages.map((message) =>
          props.renderMessage ? (
            <div key={message.id}>{props.renderMessage(message)}</div>
          ) : (
            <div key={message.id} data-role={message.role} data-state={message.state}>
              {message.body}
            </div>
          ),
        )}
        {state.typing && <div aria-hidden="true">...</div>}
      </div>

      {state.status === "ai" && (
        <button type="button" onClick={() => requestHuman()}>
          Talk to a person
        </button>
      )}

      <form onSubmit={submit}>
        <textarea
          ref={inputRef}
          rows={1}
          aria-label="Message"
          placeholder="Ask a question"
          disabled={state.status === "resolved"}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit(event);
            }
          }}
        />
        <button type="submit" disabled={!state.conversationId || state.status === "resolved"}>
          Send
        </button>
      </form>
    </section>
  );
}
