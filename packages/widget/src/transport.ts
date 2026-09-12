export interface TransportHandlers {
  onOpen(): void;
  onFrame(raw: unknown): void;
  onClose(reason: string): void;
  onError(error: Error): void;
}

export interface Transport {
  connect(): void;
  send(frame: unknown): void;
  close(): void;
  readonly connected: boolean;
}

export type TransportFactory = (handlers: TransportHandlers) => Transport;

export interface SocketIoTransportOptions {
  url: string;
  basePath?: string;
  auth: Record<string, unknown>;
}

/**
 * socket.io transport.
 *
 * Reconnection is disabled here on purpose. The client owns retry scheduling so
 * that a server drain notice can override it: a deploy drops every socket at
 * once, and letting each client reconnect on its own immediate schedule turns a
 * rolling deploy into a stampede.
 */
export function socketIoTransport(options: SocketIoTransportOptions): TransportFactory {
  const basePath = options.basePath ?? "/support-chat";
  return (handlers) => {
    let socket: import("socket.io-client").Socket | null = null;

    return {
      get connected(): boolean {
        return socket?.connected ?? false;
      },
      connect(): void {
        void import("socket.io-client").then(({ io }) => {
          socket = io(`${options.url}${basePath}/widget`, {
            path: `${basePath}/socket.io`,
            transports: ["websocket"],
            auth: options.auth,
            reconnection: false,
          });
          socket.on("connect", () => handlers.onOpen());
          socket.on("frame", (raw: unknown) => handlers.onFrame(raw));
          socket.on("disconnect", (reason: string) => handlers.onClose(reason));
          socket.on("connect_error", (error: Error) => {
            handlers.onError(error);
            handlers.onClose("connect_error");
          });
        });
      },
      send(frame: unknown): void {
        socket?.emit("frame", frame);
      },
      close(): void {
        socket?.disconnect();
        socket = null;
      },
    };
  };
}
