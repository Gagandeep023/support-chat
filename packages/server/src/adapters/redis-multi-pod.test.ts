import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RedisCacheStore } from "./redis-cache-store.js";

const url = process.env.SUPPORT_CHAT_TEST_REDIS_URL ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The reason this adapter exists.
 *
 * Everything in the conformance suite passes against the in-memory store too, so
 * none of it proves Redis is doing anything. These use two independent
 * CacheStore instances with their own connections, which is what two pods behind
 * a load balancer actually look like.
 */
const suite = url ? describe : describe.skip;

suite("redis across pods", () => {
  const prefix = `sc-pods-${Math.random().toString(36).slice(2, 10)}`;
  let podA: RedisCacheStore;
  let podB: RedisCacheStore;

  beforeEach(() => {
    podA = new RedisCacheStore({ url, prefix });
    podB = new RedisCacheStore({ url, prefix });
  });

  afterEach(async () => {
    await podA.close();
    await podB.close();
  });

  it("lets only one pod claim a conversation", async () => {
    // Two pods pumping the same queue at the same moment. Without a shared
    // atomic claim they both offer it, and two agents start replying to one
    // customer.
    const [a, b] = await Promise.all([
      podA.claim("offer:cnv_1", "agt_a", 30),
      podB.claim("offer:cnv_1", "agt_b", 30),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await podA.peek("offer:cnv_1")).toBe(await podB.peek("offer:cnv_1"));
  });

  it("shows an agent connected to one pod as online to the other", async () => {
    // Routing happens wherever the queue is pumped, not where the agent is
    // connected, so presence has to be visible from every pod.
    await podA.heartbeat("ten_1", "agt_1", 30);
    expect(await podB.onlineAgents("ten_1")).toContain("agt_1");
    await podA.clearPresence("ten_1", "agt_1");
    expect(await podB.onlineAgents("ten_1")).not.toContain("agt_1");
  });

  it("shares the queue between pods", async () => {
    await podA.enqueue("ten_1", "cnv_1");
    await podB.enqueue("ten_1", "cnv_2");
    expect(await podA.listQueue("ten_1")).toEqual(["cnv_1", "cnv_2"]);
    expect(await podB.dequeue("ten_1")).toBe("cnv_1");
    expect(await podA.queueDepth("ten_1")).toBe(1);
  });

  it("counts agent load across pods", async () => {
    await podA.incrLoad("agt_1");
    await podB.incrLoad("agt_1");
    expect((await podA.getLoad(["agt_1"]))["agt_1"]).toBe(2);
  });

  it("delivers a message published on one pod to a subscriber on the other", async () => {
    // This is what carries a reply to a customer whose socket is held by a
    // different pod from the agent's.
    const received: unknown[] = [];
    await podB.subscribe("conversation:cnv_1", (payload) => received.push(payload));
    await sleep(120);

    await podA.publish("conversation:cnv_1", { messageId: "msg_1", body: "hello" });
    for (let i = 0; i < 60 && received.length === 0; i += 1) await sleep(25);

    expect(received).toEqual([{ messageId: "msg_1", body: "hello" }]);
  });

  it("keeps a shared head sequence so a reconnect lands on any pod", async () => {
    await podA.setConversationSeq("cnv_1", 9);
    expect(await podB.getConversationSeq("cnv_1")).toBe(9);
  });
});
