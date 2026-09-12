import type { Server } from "socket.io";

/**
 * Attach socket.io's Redis adapter.
 *
 * A RedisCacheStore alone is only half of running more than one pod. It shares
 * presence, queues, claims and sequences, but socket.io rooms are per-process:
 * `nsp.to(room).emit()` reaches sockets on the pod that ran it and nowhere else.
 * Without this, a customer whose socket is held by pod A never sees the reply
 * typed by an agent connected to pod B, and nothing errors. The symptom is
 * messages that silently go missing for some users and not others, which is
 * miserable to diagnose.
 *
 * Requires two more connections: a subscriber cannot issue ordinary commands.
 */
export async function attachRedisSocketAdapter(
  io: Server,
  options: { url?: string; pubClient?: unknown; subClient?: unknown } = {},
): Promise<void> {
  let createAdapter: (pub: unknown, sub: unknown) => unknown;
  try {
    ({ createAdapter } = (await import("@socket.io/redis-adapter")) as unknown as {
      createAdapter: (pub: unknown, sub: unknown) => unknown;
    });
  } catch {
    throw new Error(
      "support-chat: running more than one pod needs `@socket.io/redis-adapter`. " +
        "Install it with `npm install @socket.io/redis-adapter`.",
    );
  }

  let pub = options.pubClient;
  let sub = options.subClient;

  if (!pub || !sub) {
    let Redis: new (url: string) => { duplicate(): unknown };
    try {
      Redis = ((await import("ioredis")) as unknown as {
        default: new (url: string) => { duplicate(): unknown };
      }).default;
    } catch {
      throw new Error("support-chat: the Redis socket adapter needs `ioredis`.");
    }
    const url = options.url ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
    const client = new Redis(url);
    pub = client;
    sub = client.duplicate();
  }

  io.adapter(createAdapter(pub, sub) as Parameters<Server["adapter"]>[0]);
}
