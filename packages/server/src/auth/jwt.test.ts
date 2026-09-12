import { describe, expect, it } from "vitest";
import { SupportChatError } from "@gagandeep023/support-chat-core";
import { signAgentToken, verifyAgentToken } from "./jwt.js";
import { signUserIdentity, verifyUserIdentity } from "./identity.js";

const SECRET = "tenant-secret-value";
const claims = { agentId: "agt_1", tenantId: "ten_1", name: "Asha" };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("agent tokens", () => {
  it("round-trips claims", () => {
    const token = signAgentToken({ ...claims, role: "admin" }, SECRET);
    const verified = verifyAgentToken(token, SECRET);
    expect(verified.agentId).toBe("agt_1");
    expect(verified.role).toBe("admin");
  });

  it("rejects a token signed with a different secret", () => {
    const token = signAgentToken(claims, "some-other-tenant-secret");
    expect(() => verifyAgentToken(token, SECRET)).toThrow(SupportChatError);
  });

  it("rejects alg:none", () => {
    // The classic JWT forgery: strip the signature and declare no algorithm.
    const header = b64({ alg: "none", typ: "JWT" });
    const body = b64({ ...claims, iat: 0, exp: 9_999_999_999 });
    expect(() => verifyAgentToken(`${header}.${body}.`, SECRET)).toThrow(
      /Unsupported token algorithm/,
    );
  });

  it("rejects an algorithm swap", () => {
    // RS256 declared so a verifier might treat a public key as an HMAC secret.
    const header = b64({ alg: "RS256", typ: "JWT" });
    const body = b64({ ...claims, iat: 0, exp: 9_999_999_999 });
    expect(() => verifyAgentToken(`${header}.${body}.anything`, SECRET)).toThrow(
      /Unsupported token algorithm/,
    );
  });

  it("rejects a tampered payload", () => {
    const token = signAgentToken(claims, SECRET);
    const [head, , signature] = token.split(".") as [string, string, string];
    const forged = b64({ ...claims, tenantId: "ten_victim", iat: 0, exp: 9_999_999_999 });
    expect(() => verifyAgentToken(`${head}.${forged}.${signature}`, SECRET)).toThrow(
      /signature is invalid/,
    );
  });

  it("rejects an expired token", () => {
    const token = signAgentToken(claims, SECRET, {
      expiresInSeconds: 60,
      now: () => 1_000_000_000_000,
    });
    expect(() =>
      verifyAgentToken(token, SECRET, { now: () => 1_000_000_000_000 + 120_000 }),
    ).toThrow(/expired/);
  });

  it("accepts a token inside the clock tolerance", () => {
    const token = signAgentToken(claims, SECRET, {
      expiresInSeconds: 60,
      now: () => 1_000_000_000_000,
    });
    expect(
      verifyAgentToken(token, SECRET, { now: () => 1_000_000_000_000 + 70_000 }).agentId,
    ).toBe("agt_1");
  });

  it("rejects structurally broken tokens without throwing anything but our error", () => {
    for (const bad of ["", "a", "a.b", "a.b.c.d", "....", "not-a-token"]) {
      expect(() => verifyAgentToken(bad, SECRET)).toThrow(SupportChatError);
    }
  });
});

describe("signed user identity", () => {
  it("accepts a hash the host computed", () => {
    expect(verifyUserIdentity("user-42", signUserIdentity("user-42", SECRET), SECRET)).toBe(
      true,
    );
  });

  it("rejects another user's hash", () => {
    // Without this check, a visitor edits externalId in devtools and reads
    // someone else's entire support history.
    const stolen = signUserIdentity("user-42", SECRET);
    expect(verifyUserIdentity("user-99", stolen, SECRET)).toBe(false);
  });

  it("rejects a hash from a different secret", () => {
    expect(
      verifyUserIdentity("user-42", signUserIdentity("user-42", "other-secret"), SECRET),
    ).toBe(false);
  });

  it("rejects a malformed hash without throwing", () => {
    expect(verifyUserIdentity("user-42", "", SECRET)).toBe(false);
    expect(verifyUserIdentity("user-42", "zz", SECRET)).toBe(false);
  });
});
