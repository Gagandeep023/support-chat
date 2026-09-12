export interface BackoffOptions {
  /** 0 for the first retry after a drop. */
  attempt: number;
  baseMs?: number;
  capMs?: number;
  /**
   * Server-supplied delay from a `server.draining` frame. The server has spread
   * these across connected clients already, so it is used as the floor rather
   * than recomputed.
   */
  hintMs?: number;
  /** Injectable for tests. */
  random?: () => number;
}

const DEFAULT_BASE_MS = 500;
const DEFAULT_CAP_MS = 30_000;
/** Extra spread applied on top of a server hint, as insurance against an unjittered server. */
const HINT_SPREAD = 0.2;

/**
 * Full-jitter exponential backoff.
 *
 * `random(0, min(cap, base * 2^attempt))` rather than a fixed backoff, because
 * the failure that matters here is correlated: a deploy drops every socket at
 * once, and any deterministic delay reconnects them all at the same instant,
 * which is the same stampede one step later. Randomising across the whole
 * window is what actually spreads the load.
 *
 * Returns milliseconds to wait before the next connection attempt.
 */
export function reconnectDelay(options: BackoffOptions): number {
  const {
    attempt,
    baseMs = DEFAULT_BASE_MS,
    capMs = DEFAULT_CAP_MS,
    hintMs,
    random = Math.random,
  } = options;

  if (hintMs !== undefined) {
    return Math.round(hintMs + random() * hintMs * HINT_SPREAD);
  }

  const safeAttempt = Math.max(0, Math.min(attempt, 30));
  const window = Math.min(capMs, baseMs * 2 ** safeAttempt);
  // Floor at a tenth of the window so a client never busy-loops on reconnect.
  const floor = window / 10;
  return Math.round(floor + random() * (window - floor));
}
