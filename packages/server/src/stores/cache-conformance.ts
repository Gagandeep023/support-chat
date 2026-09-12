import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CacheStore } from "./cache-store.js";

export interface CacheConformanceHarness {
  store: CacheStore;
  dispose(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for an asynchronous delivery without a fixed sleep. */
async function eventually(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error("condition never became true");
}

/**
 * One suite, run against every CacheStore.
 *
 * The in-memory implementation is the one most people will run, and Redis is the
 * one that has to behave identically once they scale past a single pod. Any gap
 * between them shows up as a bug that only appears in production, which is the
 * worst possible place to find it.
 */
export function describeCacheStore(
  name: string,
  createHarness: () => Promise<CacheConformanceHarness> | CacheConformanceHarness,
): void {
  describe(`CacheStore conformance: ${name}`, () => {
    let harness: CacheConformanceHarness;
    let cache: CacheStore;
    const tenant = `ten_${Math.random().toString(36).slice(2, 10)}`;

    beforeEach(async () => {
      harness = await createHarness();
      cache = harness.store;
    });

    afterEach(async () => {
      await harness.dispose();
    });

    describe("presence", () => {
      it("lists an agent after a heartbeat", async () => {
        await cache.heartbeat(tenant, "agt_1", 30);
        expect(await cache.onlineAgents(tenant)).toEqual(["agt_1"]);
      });

      it("drops presence immediately when cleared", async () => {
        // Clean disconnect must not wait for the TTL: during a deploy a stale key
        // makes the router offer conversations to consoles that have gone away.
        await cache.heartbeat(tenant, "agt_1", 30);
        await cache.clearPresence(tenant, "agt_1");
        expect(await cache.onlineAgents(tenant)).toEqual([]);
      });

      it("expires presence after the ttl", async () => {
        await cache.heartbeat(tenant, "agt_ttl", 1);
        expect(await cache.onlineAgents(tenant)).toContain("agt_ttl");
        await sleep(1200);
        expect(await cache.onlineAgents(tenant)).not.toContain("agt_ttl");
      });

      it("keeps tenants separate", async () => {
        await cache.heartbeat(tenant, "agt_1", 30);
        expect(await cache.onlineAgents(`${tenant}_other`)).toEqual([]);
      });

      it("treats a repeated heartbeat as a refresh, not a duplicate", async () => {
        await cache.heartbeat(tenant, "agt_1", 30);
        await cache.heartbeat(tenant, "agt_1", 30);
        expect(await cache.onlineAgents(tenant)).toEqual(["agt_1"]);
      });
    });

    describe("load", () => {
      it("counts up and down", async () => {
        expect(await cache.incrLoad("agt_1")).toBe(1);
        expect(await cache.incrLoad("agt_1")).toBe(2);
        expect(await cache.decrLoad("agt_1")).toBe(1);
      });

      it("never goes negative", async () => {
        // A double resolve, or a resolve after a crash, would otherwise leave an
        // agent on -1 and make them look permanently more available than anyone.
        expect(await cache.decrLoad("agt_fresh")).toBe(0);
        expect(await cache.decrLoad("agt_fresh")).toBe(0);
        expect((await cache.getLoad(["agt_fresh"]))["agt_fresh"]).toBe(0);
      });

      it("reports zero for an agent it has never seen", async () => {
        expect(await cache.getLoad(["agt_unknown"])).toEqual({ agt_unknown: 0 });
      });

      it("reads several agents at once", async () => {
        await cache.incrLoad("agt_a");
        await cache.incrLoad("agt_b");
        await cache.incrLoad("agt_b");
        expect(await cache.getLoad(["agt_a", "agt_b", "agt_c"])).toEqual({
          agt_a: 1,
          agt_b: 2,
          agt_c: 0,
        });
      });
    });

    describe("queue", () => {
      it("keeps arrival order", async () => {
        for (const id of ["cnv_1", "cnv_2", "cnv_3"]) await cache.enqueue(tenant, id);
        expect(await cache.listQueue(tenant)).toEqual(["cnv_1", "cnv_2", "cnv_3"]);
        expect(await cache.queueDepth(tenant)).toBe(3);
      });

      it("reports a one-based position", async () => {
        // Shown to the customer as "position 2", so an off-by-one is visible.
        await cache.enqueue(tenant, "cnv_1");
        await cache.enqueue(tenant, "cnv_2");
        expect(await cache.queuePosition(tenant, "cnv_1")).toBe(1);
        expect(await cache.queuePosition(tenant, "cnv_2")).toBe(2);
        expect(await cache.queuePosition(tenant, "cnv_missing")).toBeNull();
      });

      it("ignores a repeated enqueue", async () => {
        await cache.enqueue(tenant, "cnv_1");
        await cache.enqueue(tenant, "cnv_1");
        expect(await cache.queueDepth(tenant)).toBe(1);
      });

      it("takes from the front", async () => {
        await cache.enqueue(tenant, "cnv_1");
        await cache.enqueue(tenant, "cnv_2");
        expect(await cache.dequeue(tenant)).toBe("cnv_1");
        expect(await cache.dequeue(tenant)).toBe("cnv_2");
        expect(await cache.dequeue(tenant)).toBeNull();
      });

      it("removes a conversation that left the queue another way", async () => {
        await cache.enqueue(tenant, "cnv_1");
        await cache.enqueue(tenant, "cnv_2");
        await cache.unqueue(tenant, "cnv_1");
        expect(await cache.listQueue(tenant)).toEqual(["cnv_2"]);
        await cache.unqueue(tenant, "cnv_missing");
        expect(await cache.queueDepth(tenant)).toBe(1);
      });
    });

    describe("claims", () => {
      it("lets exactly one holder win", async () => {
        // The primitive that stops two agents being handed the same conversation.
        expect(await cache.claim("offer:cnv_1", "agt_a", 30)).toBe(true);
        expect(await cache.claim("offer:cnv_1", "agt_b", 30)).toBe(false);
        expect(await cache.peek("offer:cnv_1")).toBe("agt_a");
      });

      it("is idempotent for the holder", async () => {
        expect(await cache.claim("offer:cnv_2", "agt_a", 30)).toBe(true);
        expect(await cache.claim("offer:cnv_2", "agt_a", 30)).toBe(true);
      });

      it("releases only for the holder", async () => {
        await cache.claim("offer:cnv_3", "agt_a", 30);
        await cache.release("offer:cnv_3", "agt_b");
        expect(await cache.peek("offer:cnv_3")).toBe("agt_a");
        await cache.release("offer:cnv_3", "agt_a");
        expect(await cache.peek("offer:cnv_3")).toBeNull();
      });

      it("frees a claim once its ttl passes", async () => {
        await cache.claim("offer:cnv_4", "agt_a", 1);
        await sleep(1200);
        expect(await cache.peek("offer:cnv_4")).toBeNull();
        expect(await cache.claim("offer:cnv_4", "agt_b", 30)).toBe(true);
      });

      it("returns null when peeking at nothing", async () => {
        expect(await cache.peek("offer:never")).toBeNull();
      });
    });

    describe("conversation sequence", () => {
      it("round-trips a head sequence", async () => {
        await cache.setConversationSeq("cnv_1", 7);
        expect(await cache.getConversationSeq("cnv_1")).toBe(7);
      });

      it("returns null for an unknown conversation so the caller falls back", async () => {
        expect(await cache.getConversationSeq("cnv_unknown")).toBeNull();
      });
    });

    describe("pub/sub", () => {
      it("delivers to a subscriber", async () => {
        const received: unknown[] = [];
        await cache.subscribe("room:1", (payload) => received.push(payload));
        await cache.publish("room:1", { hello: "world" });
        await eventually(() => received.length === 1);
        expect(received[0]).toEqual({ hello: "world" });
      });

      it("does not cross channels", async () => {
        const received: unknown[] = [];
        await cache.subscribe("room:a", (payload) => received.push(payload));
        await cache.publish("room:b", { nope: true });
        await cache.publish("room:a", { yes: true });
        await eventually(() => received.length === 1);
        expect(received).toEqual([{ yes: true }]);
      });

      it("stops delivering after unsubscribe", async () => {
        const received: unknown[] = [];
        const unsubscribe = await cache.subscribe("room:2", (p) => received.push(p));
        await cache.publish("room:2", { first: true });
        await eventually(() => received.length === 1);
        await unsubscribe();
        await cache.publish("room:2", { second: true });
        await sleep(150);
        expect(received).toHaveLength(1);
      });
    });
  });
}
