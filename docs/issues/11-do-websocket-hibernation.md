# Durable Objects: WebSocket support

WebSocket management through the Durable Object state. No actual hibernation — just standard WebSocket handling.

## API to implement

### DurableObjectState methods

- `acceptWebSocket(ws: WebSocket, tags?: string[]): void` — register WS with the DO, attach optional tags
- `getWebSockets(tag?: string): WebSocket[]` — return all accepted WebSockets, optionally filtered by tag
- `getTags(ws: WebSocket): string[]` — return tags for a WebSocket
- `setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void` — auto-respond to specific messages (e.g. ping/pong)
- `getWebSocketAutoResponse(): WebSocketRequestResponsePair | null`
- `getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null`
- `setHibernatableWebSocketEventTimeout(ms?: number): void` — no-op
- `getHibernatableWebSocketEventTimeout(): number | null` — returns null

### WebSocketRequestResponsePair

```ts
class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
  readonly request: string;
  readonly response: string;
}
```

Export from `cloudflare:workers` plugin.

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
- `acceptWebSocket()` registers event listeners on the WS that delegate to the DO's handler methods (`webSocketMessage`, `webSocketClose`, `webSocketError`)
- Auto-response: in the message listener, if message matches `autoResponsePair.request`, send `autoResponsePair.response` directly without calling `webSocketMessage()`
- No hibernation logic — everything stays in memory, DO instance is never evicted
- Hibernation timeout methods are no-ops (stubs)
- WebSockets don't survive restart (they're ephemeral connections)
