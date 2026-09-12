import { describe, expect, it } from "vitest";
import { newConversationId, newId, newMessageId } from "./ids.js";

describe("ids", () => {
  it("prefixes by type", () => {
    expect(newConversationId().startsWith("cnv_")).toBe(true);
    expect(newMessageId().startsWith("msg_")).toBe(true);
  });

  it("sorts lexicographically in creation order", () => {
    // Message ordering and cursor pagination both rely on this.
    const ids = Array.from({ length: 500 }, () => newId("msg"));
    expect([...ids].sort()).toEqual(ids);
  });

  it("is unique within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId("msg")));
    expect(ids.size).toBe(5000);
  });
});
