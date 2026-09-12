import { createHmac, timingSafeEqual } from "node:crypto";
import { SupportChatError } from "@gagandeep023/support-chat-core";

/**
 * Minimal HS256 JWT, used only for agent identity.
 *
 * Hand-rolled rather than pulled from a dependency because the surface is tiny
 * and the two classic JWT vulnerabilities are both closed by construction here:
 * the algorithm is pinned to HS256 and anything else (including `none`) is
 * rejected before verification, so algorithm confusion has nowhere to go; and
 * the signature comparison is constant time.
 *
 * This is not a general JWT library. It verifies exactly the tokens this system
 * issues, which is the only thing that should ever be pointed at it.
 */

export interface AgentClaims {
  agentId: string;
  tenantId: string;
  name: string;
  skills?: string[];
  maxConcurrent?: number;
  role?: "agent" | "admin";
}

interface RegisteredClaims {
  iat: number;
  exp: number;
}

type TokenPayload = AgentClaims & RegisteredClaims;

const HEADER = { alg: "HS256", typ: "JWT" } as const;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export interface SignOptions {
  /** Seconds. Keep this short; the console refreshes before expiry. */
  expiresInSeconds?: number;
  now?: () => number;
}

export function signAgentToken(
  claims: AgentClaims,
  secret: string,
  options: SignOptions = {},
): string {
  if (!secret) throw new SupportChatError("internal", "A signing secret is required.");
  const { expiresInSeconds = 300, now = Date.now } = options;
  const iat = Math.floor(now() / 1000);
  const payload: TokenPayload = { ...claims, iat, exp: iat + expiresInSeconds };
  const head = b64url(JSON.stringify(HEADER));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

export function verifyAgentToken(
  token: string,
  secret: string,
  options: { now?: () => number; clockToleranceSeconds?: number } = {},
): TokenPayload {
  const { now = Date.now, clockToleranceSeconds = 30 } = options;
  const reject = (message: string): never => {
    throw new SupportChatError("unauthenticated", message);
  };

  const parts = token.split(".");
  if (parts.length !== 3) reject("Malformed agent token.");
  const [head, body, signature] = parts as [string, string, string];

  // Algorithm is pinned before anything else is read. A token asking for
  // `none`, or for an asymmetric algorithm whose public key we would otherwise
  // be tricked into using as an HMAC secret, is rejected here.
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
  } catch {
    return reject("Malformed agent token header.");
  }
  if (
    typeof header !== "object" ||
    header === null ||
    (header as { alg?: unknown }).alg !== "HS256"
  ) {
    return reject("Unsupported token algorithm.");
  }

  const expected = Buffer.from(sign(`${head}.${body}`, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return reject("Agent token signature is invalid.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return reject("Malformed agent token payload.");
  }
  if (typeof payload !== "object" || payload === null) {
    return reject("Malformed agent token payload.");
  }

  const claims = payload as Partial<TokenPayload>;
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") {
    return reject("Agent token is missing expiry claims.");
  }
  const nowSeconds = Math.floor(now() / 1000);
  if (nowSeconds > claims.exp + clockToleranceSeconds) {
    return reject("Agent token has expired.");
  }
  if (claims.iat > nowSeconds + clockToleranceSeconds) {
    return reject("Agent token was issued in the future.");
  }
  if (!claims.agentId || !claims.tenantId || !claims.name) {
    return reject("Agent token is missing required claims.");
  }

  return claims as TokenPayload;
}
