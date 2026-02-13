import { test, expect, describe } from "bun:test";
import { IdentityTransformStream, FixedLengthStream } from "../bindings/cf-streams";

async function collectStream(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("IdentityTransformStream", () => {
  test("passes data through unchanged", async () => {
    const stream = new IdentityTransformStream();
    const writer = stream.writable.getWriter();

    const input = new TextEncoder().encode("hello world");
    const resultPromise = collectStream(stream.readable);

    await writer.write(input);
    await writer.close();

    const result = await resultPromise;
    expect(new TextDecoder().decode(result)).toBe("hello world");
  });

  test("passes multiple chunks through", async () => {
    const stream = new IdentityTransformStream();
    const writer = stream.writable.getWriter();

    const resultPromise = collectStream(stream.readable);

    await writer.write(new TextEncoder().encode("chunk1"));
    await writer.write(new TextEncoder().encode("chunk2"));
    await writer.close();

    const result = await resultPromise;
    expect(new TextDecoder().decode(result)).toBe("chunk1chunk2");
  });

  test("works with pipeTo", async () => {
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("piped data"));
        controller.close();
      },
    });

    const identity = new IdentityTransformStream();
    const resultPromise = collectStream(identity.readable);
    await input.pipeTo(identity.writable);

    const result = await resultPromise;
    expect(new TextDecoder().decode(result)).toBe("piped data");
  });

  test("has readable and writable properties", () => {
    const stream = new IdentityTransformStream();
    expect(stream.readable).toBeInstanceOf(ReadableStream);
    expect(stream.writable).toBeInstanceOf(WritableStream);
  });

  test("passes binary data through unchanged", async () => {
    const stream = new IdentityTransformStream();
    const writer = stream.writable.getWriter();

    const binary = new Uint8Array([0x00, 0xff, 0x42, 0x80]);
    const resultPromise = collectStream(stream.readable);

    await writer.write(binary);
    await writer.close();

    const result = await resultPromise;
    expect(new Uint8Array(result)).toEqual(binary);
  });

  test("is an instance of TransformStream", () => {
    const stream = new IdentityTransformStream();
    expect(stream).toBeInstanceOf(TransformStream);
  });
});

describe("FixedLengthStream", () => {
  test("passes data when exact length matches", async () => {
    const data = new TextEncoder().encode("hello"); // 5 bytes
    const stream = new FixedLengthStream(5);
    const writer = stream.writable.getWriter();

    const resultPromise = collectStream(stream.readable);

    await writer.write(data);
    await writer.close();

    const result = await resultPromise;
    expect(new TextDecoder().decode(result)).toBe("hello");
  });

  test("errors when bytes exceed expected length", async () => {
    const stream = new FixedLengthStream(3);
    const writer = stream.writable.getWriter();

    const data = new TextEncoder().encode("too long");

    // Start reading concurrently — the error surfaces on the readable side
    const readPromise = collectStream(stream.readable).catch((e: Error) => e);

    await writer.write(data).catch(() => {});
    await writer.close().catch(() => {});

    const result = await readPromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("exceeded expected length");
  });

  test("errors when stream closed before expected length", async () => {
    const stream = new FixedLengthStream(100);
    const writer = stream.writable.getWriter();

    // Start reading concurrently — the flush error surfaces on close
    const readPromise = collectStream(stream.readable).catch((e: Error) => e);

    await writer.write(new TextEncoder().encode("short"));
    await writer.close().catch(() => {});

    const result = await readPromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("expected 100");
  });

  test("accepts bigint length", () => {
    const stream = new FixedLengthStream(BigInt(1024));
    expect(stream.expectedLength).toBe(1024);
  });

  test("exposes expectedLength", () => {
    const stream = new FixedLengthStream(42);
    expect(stream.expectedLength).toBe(42);
  });

  test("rejects negative length", () => {
    expect(() => new FixedLengthStream(-1)).toThrow();
  });

  test("allows zero length with immediate close", async () => {
    const stream = new FixedLengthStream(0);
    const writer = stream.writable.getWriter();

    const resultPromise = collectStream(stream.readable);

    await writer.close();

    const result = await resultPromise;
    expect(result.byteLength).toBe(0);
  });

  test("works with multiple chunks summing to exact length", async () => {
    const stream = new FixedLengthStream(10);
    const writer = stream.writable.getWriter();

    const resultPromise = collectStream(stream.readable);

    await writer.write(new TextEncoder().encode("hello")); // 5 bytes
    await writer.write(new TextEncoder().encode("world")); // 5 bytes
    await writer.close();

    const result = await resultPromise;
    expect(new TextDecoder().decode(result)).toBe("helloworld");
  });

  test("works with pipeTo for exact length", async () => {
    const data = new TextEncoder().encode("exact");
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    const fixed = new FixedLengthStream(5);
    const resultPromise = collectStream(fixed.readable);
    await input.pipeTo(fixed.writable);

    const result = await resultPromise;
    expect(new TextDecoder().decode(result)).toBe("exact");
  });

  test("can be used as Response body", async () => {
    const stream = new FixedLengthStream(5);
    const writer = stream.writable.getWriter();

    const response = new Response(stream.readable);

    // Write in background
    writer.write(new TextEncoder().encode("hello")).then(() => writer.close());

    const text = await response.text();
    expect(text).toBe("hello");
  });

  test("is an instance of TransformStream", () => {
    const stream = new FixedLengthStream(10);
    expect(stream).toBeInstanceOf(TransformStream);
  });
});
