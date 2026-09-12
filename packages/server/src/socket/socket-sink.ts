import type { Conversation, Message } from "@gagandeep023/support-chat-core";
import type { ResponseSink } from "../ai/responder.js";
import type { ConfirmationSink } from "../tools/executor.js";
import type { Broadcaster } from "./broadcaster.js";

/** Routes streamed model output to everyone watching a conversation. */
export class SocketResponseSink implements ResponseSink {
  constructor(private readonly broadcast: Broadcaster) {}

  delta(conversationId: string, messageId: string, text: string): void {
    this.broadcast.toWidgetsInConversation(conversationId, "message.delta", {
      messageId,
      text,
    });
  }

  complete(conversationId: string, message: Message): void {
    this.broadcast.toConversation(conversationId, "message.new", { message });
  }

  typing(conversationId: string, typing: boolean): void {
    this.broadcast.toWidgetsInConversation(conversationId, "typing", {
      conversationId,
      actor: "ai",
      typing,
    });
  }

  status(conversation: Conversation, queuePosition: number | null): void {
    this.broadcast.toWidgetsInConversation(conversation.id, "conversation.status", {
      conversationId: conversation.id,
      status: conversation.status,
      agent: null,
      queuePosition,
    });
  }
}

/** Asks the customer to approve an acting tool before it runs. */
export class SocketConfirmationSink implements ConfirmationSink {
  constructor(private readonly broadcast: Broadcaster) {}

  request(input: {
    conversationId: string;
    toolCallId: string;
    name: string;
    prompt: string;
    expiresAt: string;
  }): void {
    this.broadcast.toWidgetsInConversation(
      input.conversationId,
      "tool.decision.request",
      {
        conversationId: input.conversationId,
        toolCallId: input.toolCallId,
        name: input.name,
        prompt: input.prompt,
        expiresAt: input.expiresAt,
      },
    );
  }
}
