import { SupportChatClient, type WidgetState } from "./client.js";
import { socketIoTransport } from "./transport.js";
import { WIDGET_STYLES } from "./styles.js";

const STATUS_TEXT: Record<string, string> = {
  queued: "Waiting for a teammate to join",
  assigned: "You are chatting with a teammate",
  resolved: "This conversation is closed",
};

/**
 * `<support-chat>` custom element.
 *
 * A web component rather than a React component so it works on Vue, Angular,
 * Svelte, Rails, and plain HTML without a wrapper. React gets a thin one on top;
 * shipping React-only would exclude most of the sites this is meant for.
 *
 * Everything renders inside a shadow root, which is non-negotiable for an
 * embeddable widget: without it, one aggressive global stylesheet on the host
 * page breaks the chat, and the chat's own styles leak into the host.
 */
export class SupportChatElement extends HTMLElement {
  static observedAttributes = ["publishable-key", "url", "base-path", "external-id", "user-hash"];

  private client: SupportChatClient | null = null;
  private unsubscribe: (() => void) | null = null;
  private open = false;
  private state: WidgetState | null = null;

  private root!: ShadowRoot;
  private panel!: HTMLElement;
  private launcher!: HTMLButtonElement;
  private log!: HTMLElement;
  private statusBar!: HTMLElement;
  private textarea!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private typingRow!: HTMLElement;
  private humanButton!: HTMLButtonElement;

  connectedCallback(): void {
    if (!this.shadowRoot) this.render();
    this.start();
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.client?.close();
    this.client = null;
  }

  attributeChangedCallback(): void {
    if (!this.isConnected || !this.client) return;
    this.client.close();
    this.client = null;
    this.start();
  }

  private start(): void {
    const publishableKey = this.getAttribute("publishable-key");
    if (!publishableKey) {
      // Loud in the console, silent on the page. A broken widget should not put
      // an error banner on someone's marketing site.
      console.error("<support-chat> requires a publishable-key attribute.");
      return;
    }
    const externalId = this.getAttribute("external-id");
    const userHash = this.getAttribute("user-hash");

    this.client = new SupportChatClient({
      transport: socketIoTransport({
        url: this.getAttribute("url") ?? window.location.origin,
        basePath: this.getAttribute("base-path") ?? "/support-chat",
        auth: {
          publishableKey,
          ...(externalId && userHash ? { externalId, userHash } : {}),
        },
      }),
    });
    this.unsubscribe = this.client.subscribe((state) => this.update(state));
    this.client.connect();
  }

  private render(): void {
    this.root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = WIDGET_STYLES;

    const panel = document.createElement("section");
    panel.className = "panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", this.getAttribute("heading") ?? "Support chat");
    panel.innerHTML = `
      <header class="header">
        <h2></h2>
        <span class="spacer"></span>
        <button class="icon-button" part="close" aria-label="Close chat">&times;</button>
      </header>
      <p class="status" hidden></p>
      <div class="log" role="log" aria-live="polite"></div>
      <div class="typing" hidden aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="footer-actions">
        <button class="link-button" part="request-human">Talk to a person</button>
      </div>
      <form class="composer">
        <textarea rows="1" aria-label="Message" placeholder="Ask a question"></textarea>
        <button class="send" type="submit">Send</button>
      </form>`;

    const launcher = document.createElement("button");
    launcher.className = "launcher";
    launcher.setAttribute("part", "launcher");
    launcher.setAttribute("aria-label", "Open support chat");
    launcher.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M21 12a8 8 0 1 1-3.2-6.4" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round"/><path d="M4 20l1.4-3.6" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"/></svg>';

    this.root.append(style, panel, launcher);

    this.panel = panel;
    this.launcher = launcher;
    this.log = panel.querySelector(".log") as HTMLElement;
    this.statusBar = panel.querySelector(".status") as HTMLElement;
    this.textarea = panel.querySelector("textarea") as HTMLTextAreaElement;
    this.sendButton = panel.querySelector(".send") as HTMLButtonElement;
    this.typingRow = panel.querySelector(".typing") as HTMLElement;
    this.humanButton = panel.querySelector('[part="request-human"]') as HTMLButtonElement;
    (panel.querySelector("h2") as HTMLElement).textContent =
      this.getAttribute("heading") ?? "Support";

    launcher.addEventListener("click", () => this.toggle(true));
    (panel.querySelector('[part="close"]') as HTMLElement).addEventListener("click", () =>
      this.toggle(false),
    );
    this.humanButton.addEventListener("click", () => this.client?.requestHuman());

    (panel.querySelector("form") as HTMLFormElement).addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit();
    });
    this.textarea.addEventListener("keydown", (event) => {
      // Enter sends, Shift+Enter breaks the line. The opposite surprises people
      // who are used to every other chat box.
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      }
    });
  }

  private toggle(open: boolean): void {
    this.open = open;
    this.panel.hidden = !open;
    this.launcher.hidden = open;
    if (open) this.textarea.focus();
    else this.launcher.focus();
  }

  private submit(): void {
    const body = this.textarea.value;
    if (!body.trim()) return;
    this.client?.send(body);
    this.textarea.value = "";
  }

  private update(state: WidgetState): void {
    this.state = state;
    if (!this.root) return;

    this.renderStatus(state);
    this.renderMessages(state);
    this.typingRow.hidden = !state.typing;
    this.humanButton.hidden = state.status !== "ai";

    const closed = state.status === "resolved";
    this.textarea.disabled = closed;
    this.sendButton.disabled = closed || !state.conversationId;
    if (this.open) this.log.scrollTop = this.log.scrollHeight;
  }

  private renderStatus(state: WidgetState): void {
    let text: string | null = null;
    let tone = "info";

    if (state.error) {
      text = state.error;
      tone = "error";
    } else if (state.connection === "reconnecting") {
      // Not an error. During a deploy this is the expected state, and the
      // composer deliberately stays usable: anything typed is buffered and sent
      // on reconnect.
      text = "Reconnecting...";
    } else if (state.status && STATUS_TEXT[state.status]) {
      text =
        state.status === "queued" && state.queuePosition
          ? `Waiting for a teammate (position ${state.queuePosition})`
          : (STATUS_TEXT[state.status] as string);
    }

    this.statusBar.textContent = text ?? "";
    this.statusBar.hidden = text === null;
    this.statusBar.dataset.tone = tone;
  }

  private renderMessages(state: WidgetState): void {
    this.log.replaceChildren();
    if (state.messages.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = this.getAttribute("greeting") ?? "Ask us anything.";
      this.log.append(empty);
      return;
    }
    for (const message of state.messages) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.dataset.role = message.role;
      bubble.dataset.state = message.state;
      bubble.setAttribute("part", `bubble bubble-${message.role}`);
      // textContent, never innerHTML: message bodies include agent and customer
      // input, and one of them rendering as markup is a stored XSS on every page
      // this widget is embedded in.
      bubble.textContent = message.body;
      this.log.append(bubble);
    }
  }

  /** Escape hatch for hosts that want to drive the widget themselves. */
  get chat(): SupportChatClient | null {
    return this.client;
  }

  get currentState(): WidgetState | null {
    return this.state;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("support-chat")) {
  customElements.define("support-chat", SupportChatElement);
}
