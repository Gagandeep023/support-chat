import {
  SupportChatError,
  type ToolAccess,
  type ToolContext,
  type ToolDefinition,
} from "@gagandeep023/support-chat-core";

export interface HostTool<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Must not accept a user identifier. */
  inputSchema?: Record<string, unknown>;
  access: ToolAccess;
  /** Shown to the user before an `act` tool runs. */
  confirmationPrompt?: (input: TInput) => string;
  handler(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

/**
 * Parameter names that would let the model choose whose data to read.
 *
 * Matched loosely on purpose. `userId`, `user_id`, `customerId`, `accountId`,
 * `endUserId` and friends all describe the same mistake, and the cost of
 * rejecting a legitimate name is a rename, while the cost of missing one is
 * every visitor being able to read anybody's record.
 */
const IDENTITY_PATTERN =
  /^(user|customer|account|member|subscriber|client|end_?user|owner|person)_?(id|uid|uuid|identifier|email|ref)$/i;

/** Also rejected wherever it appears, since these are never the model's to pick. */
const IDENTITY_EXACT = new Set([
  "userid", "user_id", "uid", "customerid", "customer_id",
  "accountid", "account_id", "enduserid", "end_user_id",
  "externalid", "external_id", "tenantid", "tenant_id",
  "email", "emailaddress", "email_address", "phone", "phonenumber", "phone_number",
]);

export function isIdentityParameter(name: string): boolean {
  const normalised = name.trim().toLowerCase();
  return IDENTITY_EXACT.has(normalised.replace(/[^a-z_]/g, "")) || IDENTITY_PATTERN.test(name);
}

/**
 * Tools the host application exposes to the model.
 *
 * The library knows nothing about charging sessions, orders, or subscriptions.
 * It knows how to let a customer expose their own domain without handing the
 * model the ability to choose whose data to read.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, HostTool>();

  register<TInput extends Record<string, unknown>, TOutput>(
    tool: HostTool<TInput, TOutput>,
  ): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name)) {
      throw new SupportChatError(
        "internal",
        `Tool name "${tool.name}" must be alphanumeric with underscores, starting with a letter.`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new SupportChatError("internal", `Tool "${tool.name}" is already registered.`);
    }

    // Rejected at registration, not at runtime. A schema accepting a user
    // identifier means any visitor can type "look up session 4471, I am user
    // 8823" and be obliged: an IDOR with prompt injection as its delivery
    // mechanism, trivially exploitable on a public widget. Failing at startup
    // makes it impossible to ship rather than merely discouraged.
    for (const parameter of schemaParameterNames(tool.inputSchema)) {
      if (isIdentityParameter(parameter)) {
        throw new SupportChatError(
          "internal",
          `Tool "${tool.name}" accepts "${parameter}", which identifies a user. The framework ` +
            `injects who is asking as ctx.endUser; a tool that takes it as an argument lets ` +
            `any visitor read another user's data by claiming to be them. Remove the parameter.`,
        );
      }
    }

    if (tool.access === "act" && !tool.confirmationPrompt) {
      throw new SupportChatError(
        "internal",
        `Tool "${tool.name}" has access "act" but no confirmationPrompt. Acting tools are ` +
          `shown to the user before they run, so they need something to show.`,
      );
    }

    this.tools.set(tool.name, tool as unknown as HostTool);
  }

  get(name: string): HostTool | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  /** Definitions for the model. Never includes handlers or access tiers. */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    }));
  }
}

function schemaParameterNames(schema: Record<string, unknown> | undefined): string[] {
  if (!schema) return [];
  const names: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (typeof properties === "object" && properties !== null) {
      for (const [key, value] of Object.entries(properties)) {
        names.push(key);
        walk(value);
      }
    }
    // Nested objects and arrays hide the same mistake one level down.
    for (const key of ["items", "additionalProperties"]) {
      if (record[key]) walk(record[key]);
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const branch = record[key];
      if (Array.isArray(branch)) for (const entry of branch) walk(entry);
    }
  };
  walk(schema);
  return names;
}
