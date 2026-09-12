import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { newTenantId, type Tenant } from "@gagandeep023/support-chat-core";
import type { DataStore } from "./data-store.js";

export interface ConformanceHarness {
  store: DataStore;
  /** Insert a tenant row directly; tenant provisioning is out of scope here. */
  seedTenant(tenant: Tenant): Promise<void> | void;
  dispose(): Promise<void>;
}

/**
 * One suite, run against every DataStore implementation.
 *
 * This is the thing that makes a pluggable database affordable. Three adapters
 * written against an interface will drift in exactly the places nobody thinks to
 * test: idempotency, sequence assignment under concurrency, tenant scoping. A
 * shared suite turns "they implement the same interface" from a claim into
 * something enforced, and it is why the memory adapter is a reference
 * implementation rather than a stub.
 */
export function describeDataStore(
  name: string,
  createHarness: () => Promise<ConformanceHarness> | ConformanceHarness,
): void {
  describe(`DataStore conformance: ${name}`, () => {
    let harness: ConformanceHarness;
    let store: DataStore;
    let tenantId: string;

    const tenant = (): Tenant => ({
      id: tenantId,
      name: "Acme",
      publishableKey: `pk_${tenantId}`,
      settings: { locale: "en" },
      createdAt: new Date().toISOString(),
    });

    async function newConversation(): Promise<string> {
      const user = await store.upsertEndUser({ tenantId, externalId: null });
      const conversation = await store.createConversation({
        tenantId,
        endUserId: user.id,
        channel: "web",
      });
      return conversation.id;
    }

    beforeEach(async () => {
      harness = await createHarness();
      store = harness.store;
      await store.init();
      tenantId = newTenantId();
      await harness.seedTenant(tenant());
    });

    afterEach(async () => {
      await harness.dispose();
    });

    describe("tenants", () => {
      it("looks a tenant up by publishable key", async () => {
        const found = await store.getTenantByPublishableKey(`pk_${tenantId}`);
        expect(found?.id).toBe(tenantId);
        expect(found?.settings).toEqual({ locale: "en" });
      });

      it("returns null for an unknown key rather than throwing", async () => {
        expect(await store.getTenantByPublishableKey("pk_nope")).toBeNull();
      });
    });

    describe("end users", () => {
      it("reuses the row for a known external id", async () => {
        const first = await store.upsertEndUser({ tenantId, externalId: "u1" });
        const second = await store.upsertEndUser({ tenantId, externalId: "u1" });
        expect(second.id).toBe(first.id);
        expect(second.isAnonymous).toBe(false);
      });

      it("gives every anonymous visitor their own row", async () => {
        // Collapsing anonymous visitors onto one row would show every stranger
        // the same conversation.
        const first = await store.upsertEndUser({ tenantId, externalId: null });
        const second = await store.upsertEndUser({ tenantId, externalId: null });
        expect(second.id).not.toBe(first.id);
        expect(second.isAnonymous).toBe(true);
      });

      it("keeps the same external id separate across tenants", async () => {
        const other = newTenantId();
        await harness.seedTenant({ ...tenant(), id: other, publishableKey: `pk_${other}` });
        const a = await store.upsertEndUser({ tenantId, externalId: "u1" });
        const b = await store.upsertEndUser({ tenantId: other, externalId: "u1" });
        expect(b.id).not.toBe(a.id);
      });
    });

    describe("agents", () => {
      it("upserts on the host's external id, not on ours", async () => {
        const first = await store.upsertAgent({
          tenantId,
          externalId: "ext-1",
          displayName: "Asha",
        });
        const second = await store.upsertAgent({
          tenantId,
          externalId: "ext-1",
          displayName: "Asha Patel",
          skills: ["billing"],
        });
        expect(second.id).toBe(first.id);
        expect(second.displayName).toBe("Asha Patel");
        expect(second.skills).toEqual(["billing"]);
      });

      it("scopes lookups to the tenant", async () => {
        const agent = await store.upsertAgent({
          tenantId,
          externalId: "ext-1",
          displayName: "Asha",
        });
        expect(await store.getAgent(newTenantId(), agent.id)).toBeNull();
      });
    });

    describe("conversations", () => {
      it("starts in the ai state with no agent", async () => {
        const id = await newConversation();
        const conversation = await store.getConversation(tenantId, id);
        expect(conversation?.status).toBe("ai");
        expect(conversation?.assignedAgentId).toBeNull();
        expect(conversation?.lastSeq).toBe(0);
      });

      it("refuses to return another tenant's conversation", async () => {
        const id = await newConversation();
        expect(await store.getConversation(newTenantId(), id)).toBeNull();
      });

      it("records resolvedAt when resolved, and only then", async () => {
        const id = await newConversation();
        await store.setConversationStatus(id, "queued");
        expect((await store.getConversation(tenantId, id))?.resolvedAt).toBeNull();
        await store.setConversationStatus(id, "resolved");
        expect((await store.getConversation(tenantId, id))?.resolvedAt).not.toBeNull();
      });

      it("assigns and unassigns an agent", async () => {
        const id = await newConversation();
        const agent = await store.upsertAgent({
          tenantId,
          externalId: "ext-1",
          displayName: "Asha",
        });
        await store.assignConversation(id, agent.id);
        expect((await store.getConversation(tenantId, id))?.assignedAgentId).toBe(agent.id);
        await store.assignConversation(id, null);
        expect((await store.getConversation(tenantId, id))?.assignedAgentId).toBeNull();
      });

      it("filters by status and pages with a cursor", async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) ids.push(await newConversation());
        for (const id of ids.slice(0, 3)) await store.setConversationStatus(id, "queued");

        const queued = await store.listConversations(tenantId, { status: "queued", limit: 10 });
        expect(queued.items).toHaveLength(3);

        const first = await store.listConversations(tenantId, { limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).toBeTruthy();

        const second = await store.listConversations(tenantId, {
          limit: 2,
          cursor: first.nextCursor as string,
        });
        expect(second.items).toHaveLength(2);
        // A cursor that repeats or skips rows is the classic pagination bug.
        const seen = [...first.items, ...second.items].map((c) => c.id);
        expect(new Set(seen).size).toBe(4);
      });

      it("never returns another tenant's rows in a listing", async () => {
        await newConversation();
        const other = await store.listConversations(newTenantId(), { limit: 10 });
        expect(other.items).toEqual([]);
      });
    });

    describe("messages", () => {
      it("numbers messages from one, without gaps", async () => {
        const id = await newConversation();
        for (const body of ["one", "two", "three"]) {
          await store.appendMessage({
            conversationId: id,
            tenantId,
            senderType: "user",
            senderId: null,
            body,
          });
        }
        const messages = await store.listMessages(id, { limit: 10 });
        expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
        expect(messages.map((m) => m.body)).toEqual(["one", "two", "three"]);
      });

      it("keeps sequences independent per conversation", async () => {
        const a = await newConversation();
        const b = await newConversation();
        await store.appendMessage({
          conversationId: a, tenantId, senderType: "user", senderId: null, body: "a1",
        });
        const first = await store.appendMessage({
          conversationId: b, tenantId, senderType: "user", senderId: null, body: "b1",
        });
        expect(first.seq).toBe(1);
      });

      it("advances the conversation's lastSeq", async () => {
        // Resume compares against this. If it lags, a reconnecting client is told
        // it is current when it is not, and silently loses messages.
        const id = await newConversation();
        await store.appendMessage({
          conversationId: id, tenantId, senderType: "user", senderId: null, body: "hi",
        });
        expect((await store.getConversation(tenantId, id))?.lastSeq).toBe(1);
      });

      it("returns the original message when a client retries a send", async () => {
        const id = await newConversation();
        const first = await store.appendMessage({
          conversationId: id, tenantId, senderType: "user", senderId: null,
          body: "did this land?", clientMessageId: "c1",
        });
        const retry = await store.appendMessage({
          conversationId: id, tenantId, senderType: "user", senderId: null,
          body: "did this land?", clientMessageId: "c1",
        });
        expect(retry.id).toBe(first.id);
        expect(retry.seq).toBe(first.seq);
        expect(await store.listMessages(id, { limit: 10 })).toHaveLength(1);
      });

      it("scopes clientMessageId to its conversation", async () => {
        const a = await newConversation();
        const b = await newConversation();
        const base = { tenantId, senderType: "user" as const, senderId: null, body: "x", clientMessageId: "c1" };
        const first = await store.appendMessage({ ...base, conversationId: a });
        const second = await store.appendMessage({ ...base, conversationId: b });
        expect(second.id).not.toBe(first.id);
      });

      it("persists under a caller-supplied id", async () => {
        // The responder streams deltas under an id before the message exists, so
        // it must be able to persist under that same id.
        const id = await newConversation();
        const message = await store.appendMessage({
          id: "msg_preassigned",
          conversationId: id, tenantId, senderType: "ai", senderId: null, body: "streamed",
        });
        expect(message.id).toBe("msg_preassigned");
      });

      it("replays only the gap after a given sequence", async () => {
        const id = await newConversation();
        for (const body of ["one", "two", "three"]) {
          await store.appendMessage({
            conversationId: id, tenantId, senderType: "user", senderId: null, body,
          });
        }
        const gap = await store.listMessages(id, { afterSeq: 1, limit: 10 });
        expect(gap.map((m) => m.body)).toEqual(["two", "three"]);
        expect(await store.listMessages(id, { afterSeq: 3, limit: 10 })).toEqual([]);
      });

      it("round-trips metadata and sender type", async () => {
        const id = await newConversation();
        const message = await store.appendMessage({
          conversationId: id, tenantId, senderType: "ai", senderId: null,
          body: "grounded answer", metadata: { grounded: true, chunks: 3 },
        });
        expect(message.senderType).toBe("ai");
        expect(message.metadata).toEqual({ grounded: true, chunks: 3 });
        const stored = await store.listMessages(id, { limit: 1 });
        expect(stored[0]?.metadata).toEqual({ grounded: true, chunks: 3 });
      });

      it("assigns distinct sequences to concurrent appends", async () => {
        // The race a single-threaded test never sees: read lastSeq, then write.
        // Two appends that interleave there both claim the same number, and the
        // conversation silently loses a message on replay.
        const id = await newConversation();
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            store.appendMessage({
              conversationId: id, tenantId, senderType: "user", senderId: null,
              body: `m${i}`, clientMessageId: `c${i}`,
            }),
          ),
        );
        const seqs = results.map((m) => m.seq).sort((a, b) => a - b);
        expect(new Set(seqs).size).toBe(12);
        expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      });
    });

    describe("events", () => {
      it("stores an audit trail in order", async () => {
        const id = await newConversation();
        for (const type of ["conversation.created", "escalation.triggered", "handoff.queued"] as const) {
          await store.appendEvent({
            conversationId: id, tenantId, type,
            actor: { type: "system", id: null },
            payload: { note: type },
          });
        }
        const events = await store.listEvents(id);
        expect(events.map((e) => e.type)).toEqual([
          "conversation.created",
          "escalation.triggered",
          "handoff.queued",
        ]);
        expect(events[1]?.payload).toEqual({ note: "escalation.triggered" });
      });

      it("round-trips the actor", async () => {
        const id = await newConversation();
        await store.appendEvent({
          conversationId: id, tenantId, type: "handoff.assigned",
          actor: { type: "agent", id: "agt_1" }, payload: {},
        });
        expect((await store.listEvents(id))[0]?.actor).toEqual({ type: "agent", id: "agt_1" });
      });
    });
  });
}
