declare module "ws" {
  export class WebSocketServer {
    constructor(options: { noServer: boolean });
    handleUpgrade(req: import("node:http").IncomingMessage, socket: unknown, head: Buffer, cb: (ws: unknown) => void): void;
  }
}
