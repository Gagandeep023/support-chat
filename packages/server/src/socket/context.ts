import {
  envelope,
  newFrameId,
  type ServerToAgent,
  type ServerToWidget,
} from "@gagandeep023/support-chat-core";
import type { Socket } from "socket.io";

/** The single socket.io event name. Frame type lives inside the envelope. */
export const FRAME_EVENT = "frame";

export interface WidgetSocketData {
  kind: "widget";
  tenantId: string;
  endUserId: string;
  isAnonymous: boolean;
  /** Conversations this socket is subscribed to. */
  rooms: Set<string>;
}

export interface AgentSocketData {
  kind: "agent";
  tenantId: string;
  /** Our internal agent id. */
  agentId: string;
  /** The host application's user id, from the token. Needed to re-upsert. */
  externalId: string;
  displayName: string;
  role: "agent" | "admin";
}

type Frame = { type: string; payload: unknown };
type PayloadOf<U extends Frame, T extends U["type"]> = Extract<U, { type: T }>["payload"];

function emitFrame(socket: Socket, type: string, payload: unknown): void {
  socket.emit(FRAME_EVENT, envelope(type, payload, newFrameId()));
}

export function sendToWidget<T extends ServerToWidget["type"]>(
  socket: Socket,
  type: T,
  payload: PayloadOf<ServerToWidget, T>,
): void {
  emitFrame(socket, type, payload);
}

export function sendToAgent<T extends ServerToAgent["type"]>(
  socket: Socket,
  type: T,
  payload: PayloadOf<ServerToAgent, T>,
): void {
  emitFrame(socket, type, payload);
}

/** Everyone watching one conversation, across both namespaces and every pod. */
export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/** One room per agent, so an offer reaches every console that agent has open. */
export function agentRoom(agentId: string): string {
  return `agent:${agentId}`;
}
