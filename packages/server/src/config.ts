export interface SupportChatConfig {
  /**
   * Secret used to verify signed user identities and agent tokens. Never
   * reaches a browser. For multi-tenant installs, use `resolveSecret` instead.
   */
  secretKey?: string;
  resolveSecret?: (tenantId: string) => string | Promise<string>;

  /** Mount path for the socket namespaces and HTTP routes. */
  basePath?: string;

  /**
   * Require every widget connection to carry a signed identity. Off by default,
   * because anonymous pre-login support chat is the common case; turn it on when
   * every visitor is authenticated and impersonation should be impossible.
   */
  requireSignedIdentity?: boolean;

  /**
   * Agent presence TTL. Heartbeats must arrive well inside it.
   *
   * Generous on purpose. Browsers throttle timers in background tabs to roughly
   * one per minute, so a tight TTL makes an agent who switched tabs flap offline
   * and stop receiving offers. The real protection against a genuinely dead
   * agent is the offer accept window, not this: a stale-online agent costs one
   * offer cycle before the router moves on, while a flapping agent costs every
   * conversation they should have taken.
   */
  presenceTtlSeconds?: number;

  /**
   * Cross-pod socket fan-out. Required once more than one instance runs;
   * a RedisCacheStore on its own does not cover socket.io rooms.
   */
  socketAdapter?: { type: "redis"; url?: string };

  drain?: {
    /**
     * Window across which reconnects are spread. Each client is told a delay
     * drawn from it, so ten thousand clients come back over this period instead
     * of in the same instant.
     */
    windowMs?: number;
    /** Time allowed for the drain frame to flush before sockets are closed. */
    graceMs?: number;
  };
}

export interface ResolvedConfig {
  basePath: string;
  socketAdapter: { type: "redis"; url?: string } | null;
  requireSignedIdentity: boolean;
  presenceTtlSeconds: number;
  drainWindowMs: number;
  drainGraceMs: number;
  resolveSecret: (tenantId: string) => Promise<string>;
}

export function resolveConfig(config: SupportChatConfig): ResolvedConfig {
  const { secretKey, resolveSecret } = config;
  if (!secretKey && !resolveSecret) {
    throw new Error(
      "support-chat: one of `secretKey` or `resolveSecret` is required. " +
        "It signs agent tokens and verifies end-user identities; without it, any " +
        "visitor could claim to be any user.",
    );
  }
  return {
    basePath: config.basePath ?? "/support-chat",
    socketAdapter: config.socketAdapter ?? null,
    requireSignedIdentity: config.requireSignedIdentity ?? false,
    presenceTtlSeconds: config.presenceTtlSeconds ?? 90,
    drainWindowMs: config.drain?.windowMs ?? 5_000,
    drainGraceMs: config.drain?.graceMs ?? 1_000,
    resolveSecret: async (tenantId: string) =>
      resolveSecret ? await resolveSecret(tenantId) : (secretKey as string),
  };
}
