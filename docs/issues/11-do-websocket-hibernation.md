# Durable Objects: WebSocket Hibernation

Manage WebSocket connections through the Durable Object state with hibernation support.

## API to implement

### DurableObjectState methods

- `acceptWebSocket(ws: WebSocket, tags?: string[]): void` — register WS with the DO, attach optional tags (max 10 per WS)
- `getWebSockets(tag?: string): WebSocket[]` — return all accepted WebSockets, optionally filtered by tag
- `setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void` — auto-respond to specific messages without waking DO
- `getWebSocketAutoResponse(): WebSocketRequestResponsePair | null`
- `getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null`
- `setHibernatableWebSocketEventTimeout(ms?: number): void`
- `getHibernatableWebSocketEventTimeout(): number | null`
- `getTags(ws: WebSocket): string[]`

### WebSocketRequestResponsePair

```ts
class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
  readonly request: string;
  readonly response: string;
}
```

### DurableObject handler methods

```ts
class MyDO extends DurableObject {
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {}
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {}
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {}
}
```

## Implementation notes

- Store accepted WebSockets in a `Set<{ ws: WebSocket, tags: string[] }>` on the DO state
- `acceptWebSocket()` calls `ws.accept()` (if not already accepted) and registers event listeners that delegate to the DO's handler methods
- `getWebSockets(tag)` filters the set by tag
- Auto-response: intercept incoming messages in the WS listener — if message matches the request string, send the response string directly without calling `webSocketMessage()`
- Hibernation: in production, DO can be evicted from memory while WebSockets stay alive. In dev, just keep everything in memory — hibernation is effectively a no-op
- `getTags(ws)` looks up the WS in the set and returns its tags
- `WebSocketRequestResponsePair` is a simple class exported from `cloudflare:workers` plugin
