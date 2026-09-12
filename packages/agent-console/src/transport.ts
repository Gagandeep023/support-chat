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
  tenantId: string;
  /**
   * Called on every connect, not once.
   *
   * Agent tokens are short-lived by design, so a reconnect after an outage needs
   * a fresh one. Caching the first token would leave a console that dropped
   * overnight unable to come back without a page reload.
   */
  fetchToken: () => Promise<string>;
}

export function socketIoTransport(options: SocketIoTransportOptions): TransportFactory {
  const basePath = options.basePath ?? "/support-chat";
  return (handlers) => {
    let socket: import("socket.io-client").Socket | null = null;

    return {
      get connected(): boolean {
        return socket?.connected ?? false;
      },
      connect(): void {
        void (async () => {
          try {
            const [{ io }, token] = await Promise.all([
              import("socket.io-client"),
              options.fetchToken(),
            ]);
            socket = io(`${options.url}${basePath}/agent`, {
              path: `${basePath}/socket.io`,
              transports: ["websocket"],
              auth: { tenantId: options.tenantId, token },
              reconnection: false,
            });
            socket.on("connect", () => handlers.onOpen());
            socket.on("frame", (raw: unknown) => handlers.onFrame(raw));
            socket.on("disconnect", (reason: string) => handlers.onClose(reason));
            socket.on("connect_error", (error: Error) => {
              handlers.onError(error);
              handlers.onClose("connect_error");
            });
          } catch (error) {
            handlers.onError(error instanceof Error ? error : new Error("token fetch failed"));
            handlers.onClose("token_error");
          }
        })();
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
