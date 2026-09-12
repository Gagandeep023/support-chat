/**
 * Widget styles, injected into the shadow root.
 *
 * Tier one of the theming contract: roughly twenty custom properties covering
 * the large majority of customisation requests. They are declared on `:host` so
 * the embedding page can override any of them from outside the shadow boundary
 * without needing to know a single internal class name. Internal selectors are
 * not part of the public API, which is what lets the markup change without
 * breaking every customer who styled it.
 */
export const WIDGET_STYLES = `
:host {
  --sc-color-accent: #2f6df6;
  --sc-color-accent-text: #ffffff;
  --sc-color-surface: #ffffff;
  --sc-color-surface-alt: #f4f5f7;
  --sc-color-text: #16181d;
  --sc-color-text-muted: #676c77;
  --sc-color-border: #e2e4e9;
  --sc-color-danger: #c0392b;
  --sc-radius: 14px;
  --sc-radius-bubble: 16px;
  --sc-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --sc-font-size: 14px;
  --sc-space: 12px;
  --sc-shadow: 0 12px 32px rgba(15, 18, 25, 0.18);
  --sc-panel-width: 372px;
  --sc-panel-height: 540px;
  --sc-launcher-size: 56px;
  --sc-z: 2147483000;

  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: var(--sc-z);
  font-family: var(--sc-font);
  font-size: var(--sc-font-size);
  color: var(--sc-color-text);
  color-scheme: light;
}

/* The default tracks the visitor's system setting; an explicit theme attribute
   on the host element wins in both directions. */
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {
    --sc-color-surface: #1b1d23;
    --sc-color-surface-alt: #24272f;
    --sc-color-text: #f2f3f5;
    --sc-color-text-muted: #a0a5b1;
    --sc-color-border: #32363f;
    --sc-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    color-scheme: dark;
  }
}
:host([theme="dark"]) {
  --sc-color-surface: #1b1d23;
  --sc-color-surface-alt: #24272f;
  --sc-color-text: #f2f3f5;
  --sc-color-text-muted: #a0a5b1;
  --sc-color-border: #32363f;
  --sc-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  color-scheme: dark;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }

.launcher {
  width: var(--sc-launcher-size);
  height: var(--sc-launcher-size);
  border-radius: 50%;
  border: none;
  background: var(--sc-color-accent);
  color: var(--sc-color-accent-text);
  box-shadow: var(--sc-shadow);
  cursor: pointer;
  display: grid;
  place-items: center;
  margin-left: auto;
}
.launcher:focus-visible { outline: 3px solid var(--sc-color-accent); outline-offset: 3px; }

.panel {
  width: var(--sc-panel-width);
  max-width: calc(100vw - 32px);
  height: var(--sc-panel-height);
  max-height: calc(100vh - 120px);
  background: var(--sc-color-surface);
  border: 1px solid var(--sc-color-border);
  border-radius: var(--sc-radius);
  box-shadow: var(--sc-shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin-bottom: var(--sc-space);
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--sc-space);
  border-bottom: 1px solid var(--sc-color-border);
  background: var(--sc-color-surface-alt);
}
.header h2 { margin: 0; font-size: 15px; font-weight: 600; }
.header .spacer { flex: 1; }
.icon-button {
  border: none;
  background: transparent;
  color: var(--sc-color-text-muted);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 6px;
}
.icon-button:hover { background: var(--sc-color-border); }

.status {
  padding: 6px var(--sc-space);
  font-size: 12px;
  color: var(--sc-color-text-muted);
  background: var(--sc-color-surface-alt);
  border-bottom: 1px solid var(--sc-color-border);
}
.status[data-tone="error"] { color: var(--sc-color-danger); }

.log {
  flex: 1;
  overflow-y: auto;
  padding: var(--sc-space);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bubble {
  max-width: 82%;
  padding: 9px 12px;
  border-radius: var(--sc-radius-bubble);
  background: var(--sc-color-surface-alt);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.45;
}
.bubble[data-role="user"] {
  align-self: flex-end;
  background: var(--sc-color-accent);
  color: var(--sc-color-accent-text);
}
.bubble[data-role="system"] {
  align-self: center;
  background: transparent;
  color: var(--sc-color-text-muted);
  font-size: 12px;
}
.bubble[data-state="pending"] { opacity: 0.6; }

.empty { color: var(--sc-color-text-muted); margin: auto; text-align: center; padding: 0 16px; }

.typing { display: flex; gap: 4px; padding: 4px 12px; }
.typing span {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--sc-color-text-muted);
  animation: sc-blink 1.2s infinite ease-in-out;
}
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes sc-blink { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }

/* Respect a visitor who has asked for less motion. */
@media (prefers-reduced-motion: reduce) {
  .typing span { animation: none; opacity: 0.6; }
}

.composer {
  display: flex;
  gap: 8px;
  padding: var(--sc-space);
  border-top: 1px solid var(--sc-color-border);
  align-items: flex-end;
}
.composer textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--sc-color-border);
  border-radius: 10px;
  padding: 9px 10px;
  font: inherit;
  color: inherit;
  background: var(--sc-color-surface);
  max-height: 120px;
  min-height: 38px;
}
.composer textarea:focus-visible { outline: 2px solid var(--sc-color-accent); outline-offset: -1px; }
.send {
  border: none;
  border-radius: 10px;
  background: var(--sc-color-accent);
  color: var(--sc-color-accent-text);
  padding: 9px 14px;
  font: inherit;
  cursor: pointer;
}
.send:disabled { opacity: 0.5; cursor: default; }

.footer-actions { padding: 0 var(--sc-space) var(--sc-space); }
.link-button {
  background: none;
  border: none;
  color: var(--sc-color-accent);
  cursor: pointer;
  font: inherit;
  padding: 0;
  text-decoration: underline;
}

@media (max-width: 420px) {
  :host { right: 12px; bottom: 12px; left: 12px; }
  .panel { width: auto; }
}
`;
