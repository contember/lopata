import { test, expect, describe, beforeEach } from "bun:test";
import { WebSocketPair, CFWebSocket } from "../bindings/websocket-pair";

describe("WebSocketPair", () => {
  let pair: WebSocketPair;
  let client: CFWebSocket;
  let server: CFWebSocket;

  beforeEach(() => {
    pair = new WebSocketPair();
    [client, server] = Object.values(pair) as [CFWebSocket, CFWebSocket];
  });

  test("constructor creates two linked sockets with numeric keys", () => {
    expect(pair[0]).toBeInstanceOf(CFWebSocket);
    expect(pair[1]).toBeInstanceOf(CFWebSocket);
    expect(pair[0]).not.toBe(pair[1]);
  });

  test("Object.values returns both sockets", () => {
    const values = Object.values(pair);
    expect(values).toHaveLength(2);
    expect(values[0]).toBeInstanceOf(CFWebSocket);
    expect(values[1]).toBeInstanceOf(CFWebSocket);
  });

  test("initial readyState is CONNECTING", () => {
    expect(client.readyState).toBe(CFWebSocket.CONNECTING);
    expect(server.readyState).toBe(CFWebSocket.CONNECTING);
  });

  test("accept() sets readyState to OPEN", () => {
    server.accept();
    expect(server.readyState).toBe(CFWebSocket.OPEN);
  });

  test("accept() is idempotent", () => {
    server.accept();
    server.accept();
    expect(server.readyState).toBe(CFWebSocket.OPEN);
  });

  test("send() throws if not accepted", () => {
    expect(() => server.send("hello")).toThrow("WebSocket is not open");
  });

  test("bidirectional string messaging", () => {
    server.accept();
    client.accept();

    const serverMessages: string[] = [];
    const clientMessages: string[] = [];

    server.addEventListener("message", (ev) => {
      serverMessages.push((ev as MessageEvent).data as string);
    });
    client.addEventListener("message", (ev) => {
      clientMessages.push((ev as MessageEvent).data as string);
    });

    client.send("from client");
    server.send("from server");

    expect(serverMessages).toEqual(["from client"]);
    expect(clientMessages).toEqual(["from server"]);
  });

  test("binary messaging with ArrayBuffer", () => {
    server.accept();
    client.accept();

    let received: ArrayBuffer | null = null;
    server.addEventListener("message", (ev) => {
      received = (ev as MessageEvent).data as ArrayBuffer;
    });

    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    client.send(data);

    expect(received).not.toBeNull();
    expect(new Uint8Array(received!)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("binary messaging with ArrayBufferView", () => {
    server.accept();
    client.accept();

    let received: ArrayBuffer | null = null;
    server.addEventListener("message", (ev) => {
      received = (ev as MessageEvent).data as ArrayBuffer;
    });

    const data = new Uint8Array([10, 20, 30]);
    client.send(data);

    expect(received).not.toBeNull();
    expect(new Uint8Array(received!)).toEqual(new Uint8Array([10, 20, 30]));
  });

  test("events buffered until accept() is called", () => {
    client.accept();

    const messages: string[] = [];
    server.addEventListener("message", (ev) => {
      messages.push((ev as MessageEvent).data as string);
    });

    // Send messages before server.accept()
    client.send("msg1");
    client.send("msg2");

    // Not yet received
    expect(messages).toEqual([]);

    // Now accept — buffered messages should flush
    server.accept();
    expect(messages).toEqual(["msg1", "msg2"]);
  });

  test("close() propagates to peer", () => {
    server.accept();
    client.accept();

    let closeFired = false;
    let closeCode: number | undefined;
    let closeReason: string | undefined;

    server.addEventListener("close", (ev) => {
      closeFired = true;
      closeCode = (ev as CloseEvent).code;
      closeReason = (ev as CloseEvent).reason;
    });

    client.close(1000, "done");

    expect(closeFired).toBe(true);
    expect(closeCode).toBe(1000);
    expect(closeReason).toBe("done");
    expect(client.readyState).toBe(CFWebSocket.CLOSED);
    expect(server.readyState).toBe(CFWebSocket.CLOSED);
  });

  test("close() with default code", () => {
    server.accept();
    client.accept();

    let closeCode: number | undefined;
    server.addEventListener("close", (ev) => {
      closeCode = (ev as CloseEvent).code;
    });

    client.close();
    expect(closeCode).toBe(1000);
  });

  test("close() is idempotent", () => {
    server.accept();
    client.accept();

    let closeCount = 0;
    server.addEventListener("close", () => closeCount++);

    client.close();
    client.close();

    expect(closeCount).toBe(1);
  });

  test("send after close throws", () => {
    server.accept();
    server.close();
    expect(() => server.send("fail")).toThrow("WebSocket is not open");
  });

  test("onmessage callback style", () => {
    server.accept();
    client.accept();

    let received = "";
    server.onmessage = (ev) => {
      received = ev.data as string;
    };

    client.send("callback style");
    expect(received).toBe("callback style");
  });

  test("onclose callback style", () => {
    server.accept();
    client.accept();

    let closeFired = false;
    server.onclose = () => {
      closeFired = true;
    };

    client.close();
    expect(closeFired).toBe(true);
  });

  test("readyState transitions", () => {
    expect(server.readyState).toBe(0); // CONNECTING
    server.accept();
    expect(server.readyState).toBe(1); // OPEN
    server.close();
    expect(server.readyState).toBe(3); // CLOSED
  });

  test("readyState constants match standard WebSocket", () => {
    expect(CFWebSocket.CONNECTING).toBe(0);
    expect(CFWebSocket.OPEN).toBe(1);
    expect(CFWebSocket.CLOSING).toBe(2);
    expect(CFWebSocket.CLOSED).toBe(3);
    // Instance constants
    expect(server.CONNECTING).toBe(0);
    expect(server.OPEN).toBe(1);
    expect(server.CLOSING).toBe(2);
    expect(server.CLOSED).toBe(3);
  });

  test("upgrade response pattern", () => {
    server.accept();

    // Simulate the CF pattern: return client socket in Response
    const response = new Response(null, { status: 101 });
    // Attach webSocket property (CF-style)
    Object.defineProperty(response, "webSocket", {
      value: client,
      writable: false,
      configurable: true,
    });

    expect(response.status).toBe(101);
    expect((response as unknown as { webSocket: CFWebSocket }).webSocket).toBe(client);

    // Server side can still communicate
    const messages: string[] = [];
    server.addEventListener("message", (ev) => {
      messages.push((ev as MessageEvent).data as string);
    });

    // Simulate real client sending through the pair
    client.accept();
    client.send("hello from client");
    expect(messages).toEqual(["hello from client"]);
  });

  test("multiple event listeners", () => {
    server.accept();
    client.accept();

    const calls: string[] = [];
    server.addEventListener("message", () => calls.push("listener1"));
    server.addEventListener("message", () => calls.push("listener2"));

    client.send("test");
    expect(calls).toEqual(["listener1", "listener2"]);
  });

  test("close event also fires on the closing socket", () => {
    server.accept();
    client.accept();

    let selfCloseFired = false;
    client.addEventListener("close", () => {
      selfCloseFired = true;
    });

    client.close(1000, "bye");
    expect(selfCloseFired).toBe(true);
  });

  test("buffered close events flush on accept", () => {
    client.accept();

    // Close before server accepts
    client.close(1001, "going away");

    let closeFired = false;
    let closeCode: number | undefined;
    server.addEventListener("close", (ev) => {
      closeFired = true;
      closeCode = (ev as CloseEvent).code;
    });

    // Server accepts — buffered close event should flush
    server.accept();
    expect(closeFired).toBe(true);
    expect(closeCode).toBe(1001);
  });
});
