import type { Namespace } from "socket.io";
import { envelope, newFrameId } from "@gagandeep023/support-chat-core";
import { FRAME_EVENT } from "./context.js";

export interface DrainOptions {
  windowMs: number;
  graceMs: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Graceful shutdown for a pod full of long-lived sockets.
 *
 * A deploy drops every connection at once, and without coordination every client
 * dials back in the same instant against pods with cold caches, which turns a
 * routine rolling deploy into a self-inflicted denial of service.
 *
 * The fix is that the server, not the client, decides when each client returns.
 * Every socket is handed its own delay drawn from the drain window before the
 * connection closes, so a wave of ten thousand reconnects arrives spread across
 * that window instead of all at once. Sockets are closed together; it is the
 * *reconnects* that are staggered.
 */
export async function drainSockets(
  namespaces: Namespace[],
  reason: "deploy" | "shutdown" | "rebalance",
  options: DrainOptions,
): Promise<number> {
  const { windowMs, graceMs, random = Math.random, sleep = defaultSleep } = options;
  // Per namespace, deliberately. `io.fetchSockets()` only returns sockets in the
  // main "/" namespace, so draining through the Server silently skips every
  // connection this system actually has.
  const sockets = (
    await Promise.all(namespaces.map((nsp) => nsp.fetchSockets()))
  ).flat();

  for (const socket of sockets) {
    socket.emit(
      FRAME_EVENT,
      envelope(
        "server.draining",
        { reconnectAfterMs: Math.round(random() * windowMs), reason },
        newFrameId(),
      ),
    );
  }

  // Let the frame flush before closing. Without this the client sees a bare
  // disconnect, falls back to its own backoff, and loses the server's spread.
  await sleep(graceMs);
  for (const socket of sockets) socket.disconnect(true);
  return sockets.length;
}
