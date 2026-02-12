interface StoredObject {
  data: ArrayBuffer;
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
  uploaded: Date;
}

class R2Object {
  readonly key: string;
  readonly size: number;
  readonly uploaded: Date;
  readonly httpMetadata: Record<string, string>;
  readonly customMetadata: Record<string, string>;

  constructor(key: string, stored: StoredObject) {
    this.key = key;
    this.size = stored.data.byteLength;
    this.uploaded = stored.uploaded;
    this.httpMetadata = stored.httpMetadata ?? {};
    this.customMetadata = stored.customMetadata ?? {};
  }
}

class R2ObjectBody extends R2Object {
  private data: ArrayBuffer;

  constructor(key: string, stored: StoredObject) {
    super(key, stored);
    this.data = stored.data;
  }

  get body(): ReadableStream<Uint8Array> {
    const data = this.data;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(data));
        controller.close();
      },
    });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.data);
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text());
  }
}

export class InMemoryR2Bucket {
  private store = new Map<string, StoredObject>();

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.store.get(key);
    if (!stored) return null;
    return new R2ObjectBody(key, stored);
  }

  async head(key: string): Promise<R2Object | null> {
    const stored = this.store.get(key);
    if (!stored) return null;
    return new R2Object(key, stored);
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream | Blob | null,
    options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> },
  ): Promise<R2Object> {
    let data: ArrayBuffer;
    if (value === null) {
      data = new ArrayBuffer(0);
    } else if (typeof value === "string") {
      data = new TextEncoder().encode(value).buffer as ArrayBuffer;
    } else if (value instanceof ArrayBuffer) {
      data = value;
    } else if (value instanceof Blob) {
      data = await value.arrayBuffer();
    } else {
      // ReadableStream
      const chunks: Uint8Array[] = [];
      const reader = value.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(chunk);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const buf = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        buf.set(c, offset);
        offset += c.length;
      }
      data = buf.buffer as ArrayBuffer;
    }

    const stored: StoredObject = {
      data,
      uploaded: new Date(),
      httpMetadata: options?.httpMetadata,
      customMetadata: options?.customMetadata,
    };
    this.store.set(key, stored);
    return new R2Object(key, stored);
  }

  async delete(key: string | string[]) {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) this.store.delete(k);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const objects: R2Object[] = [];

    for (const [k, stored] of this.store) {
      if (!k.startsWith(prefix)) continue;
      objects.push(new R2Object(k, stored));
      if (objects.length >= limit) break;
    }

    return { objects, truncated: objects.length >= limit, cursor: "" };
  }
}
