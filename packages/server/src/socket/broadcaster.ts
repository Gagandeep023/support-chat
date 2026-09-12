import {
  envelope,
  newFrameId,
  type ServerToAgent,
  type ServerToWidget,
} from "@gagandeep023/support-chat-core";
import type { Namespace } from "socket.io";
import { FRAME_EVENT, conversationRoom } from "./context.js";

type Frame = { type: string; payload: unknown };
type PayloadOf<U extends Frame, T extends U["type"]> = Extract<U, { type: T }>["payload"];

/** Frame types both sides understand, so one call reaches everyone watching. */
type SharedType = Extract<ServerToWidget["type"], ServerToAgent["type"]>;

/**
 * Fan-out across both namespaces.
 *
 * socket.io rooms are scoped to a namespace, so `nsp.to(room)` from the agent
 * console reaches other agents and nobody else. A conversation always has
 * watchers in both namespaces, so every broadcast has to address both
 * explicitly. This is also the single seam the Redis adapter plugs into for
 * cross-pod delivery: within a namespace it already handles that, and there is
 * nothing else in the system that fans out.
 */
export class Broadcaster {
  constructor(
    private readonly widget: Namespace,
    private readonly agent: Namespace,
  ) {}

  toConversation<T extends SharedType>(
    conversationId: string,
    type: T,
    payload: PayloadOf<ServerToWidget, T> & PayloadOf<ServerToAgent, T>,
    options: { exceptSocketId?: string } = {},
  ): void {
    const room = conversationRoom(conversationId);
    const frame = envelope(type, payload, newFrameId());
    for (const nsp of [this.widget, this.agent]) {
      const target = options.exceptSocketId
        ? nsp.except(options.exceptSocketId).to(room)
        : nsp.to(room);
      target.emit(FRAME_EVENT, frame);
    }
  }

  toWidgetsInConversation<T extends ServerToWidget["type"]>(
    conversationId: string,
    type: T,
    payload: PayloadOf<ServerToWidget, T>,
  ): void {
    this.widget
      .to(conversationRoom(conversationId))
      .emit(FRAME_EVENT, envelope(type, payload, newFrameId()));
  }

  toAllAgents<T extends ServerToAgent["type"]>(
    type: T,
    payload: PayloadOf<ServerToAgent, T>,
  ): void {
    this.agent.emit(FRAME_EVENT, envelope(type, payload, newFrameId()));
  }

  toAgent<T extends ServerToAgent["type"]>(
    agentRoom: string,
    type: T,
    payload: PayloadOf<ServerToAgent, T>,
  ): void {
    this.agent.to(agentRoom).emit(FRAME_EVENT, envelope(type, payload, newFrameId()));
  }
}
