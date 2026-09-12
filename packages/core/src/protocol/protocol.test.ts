import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  decodeFrame,
  envelope,
  reconnectDelay,
  serverToWidgetSchema,
  widgetToServerSchema,
} from "./index.js";

const send = (payload: unknown) => ({
  v: PROTOCOL_VERSION,
  type: "message.send",
  id: "frm_1",
  ts: 1_700_000_000_000,
  payload,
});

describe("envelope", () => {
  it("accepts a well-formed frame", () => {
    const result = decodeFrame(
      widgetToServerSchema,
      send({ conversationId: "cnv_1", clientMessageId: "c1", body: "hello" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame.type).toBe("message.send");
  });

  it("reports an unsupported version before complaining about shape", () => {
    // A future client sends fields this server has never heard of. It should be
    // told the version is wrong, not handed a wall of schema errors.
    const result = decodeFrame(widgetToServerSchema, {
      v: 99,
      type: "message.compose",
      id: "frm_2",
      ts: 1,
      payload: { somethingNew: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unsupported_protocol_version");
      expect(result.frameId).toBe("frm_2");
    }
  });

  it("rejects an unknown frame type", () => {
    const result = decodeFrame(widgetToServerSchema, {
      ...send({ conversationId: "cnv_1", clientMessageId: "c1", body: "hi" }),
      type: "message.delete",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty body rather than persisting it", () => {
    const result = decodeFrame(
      widgetToServerSchema,
      send({ conversationId: "cnv_1", clientMessageId: "c1", body: "" }),
    );
    expect(result.ok).toBe(false);
  });

  it("caps body length at the wire boundary", () => {
    const result = decodeFrame(
      widgetToServerSchema,
      send({ conversationId: "cnv_1", clientMessageId: "c1", body: "x".repeat(8001) }),
    );
    expect(result.ok).toBe(false);
  });

  it("surfaces the frame id on malformed payloads so an error can be correlated", () => {
    const result = decodeFrame(widgetToServerSchema, send({ conversationId: 42 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("malformed_frame");
      expect(result.frameId).toBe("frm_1");
    }
  });

  it("does not throw on non-object input", () => {
    for (const raw of [null, undefined, 7, "nope", []]) {
      expect(() => decodeFrame(widgetToServerSchema, raw)).not.toThrow();
      expect(decodeFrame(widgetToServerSchema, raw).ok).toBe(false);
    }
  });

  it("builds frames at the current version", () => {
    const f = envelope("session.resume", { conversationId: "cnv_1", lastSeq: 4 }, "frm_9");
    expect(f.v).toBe(PROTOCOL_VERSION);
    expect(decodeFrame(widgetToServerSchema, f).ok).toBe(true);
  });

  it("round-trips a drain notice", () => {
    const f = envelope("server.draining", { reconnectAfterMs: 2500, reason: "deploy" }, "frm_d");
    const result = decodeFrame(serverToWidgetSchema, f);
    expect(result.ok).toBe(true);
  });
});

describe("reconnectDelay", () => {
  it("spreads reconnects across the window instead of a fixed delay", () => {
    // The failure is correlated: every socket drops at the same instant. Two
    // clients on the same attempt must not wake at the same time.
    const low = reconnectDelay({ attempt: 3, random: () => 0 });
    const high = reconnectDelay({ attempt: 3, random: () => 1 });
    expect(high).toBeGreaterThan(low * 5);
  });

  it("never returns zero, so a client cannot busy-loop", () => {
    expect(reconnectDelay({ attempt: 0, random: () => 0 })).toBeGreaterThan(0);
  });

  it("grows with the attempt count and stops at the cap", () => {
    const at = (n: number) => reconnectDelay({ attempt: n, random: () => 1 });
    expect(at(1)).toBeGreaterThan(at(0));
    expect(at(5)).toBeGreaterThan(at(3));
    expect(at(50)).toBeLessThanOrEqual(30_000);
  });

  it("honours a server drain hint as the floor", () => {
    const delay = reconnectDelay({ attempt: 0, hintMs: 4000, random: () => 0.5 });
    expect(delay).toBeGreaterThanOrEqual(4000);
    expect(delay).toBeLessThanOrEqual(4800);
  });
});
