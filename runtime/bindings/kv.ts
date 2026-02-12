interface KVEntry {
  value: string | ArrayBuffer;
  metadata?: unknown;
  expiration?: number; // epoch seconds
}

export class InMemoryKVNamespace {
  private store = new Map<string, KVEntry>();

  async get(key: string, options?: string | { type?: string }): Promise<string | ArrayBuffer | object | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiration && entry.expiration < Date.now() / 1000) {
      this.store.delete(key);
      return null;
    }
    const type = typeof options === "string" ? options : options?.type ?? "text";
    if (type === "json") return JSON.parse(entry.value as string);
    if (type === "arrayBuffer") {
      if (entry.value instanceof ArrayBuffer) return entry.value;
      return new TextEncoder().encode(entry.value as string).buffer;
    }
    if (type === "stream") {
      const buf = entry.value instanceof ArrayBuffer ? entry.value : new TextEncoder().encode(entry.value as string).buffer;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      });
    }
    // text
    if (entry.value instanceof ArrayBuffer) return new TextDecoder().decode(entry.value);
    return entry.value;
  }

  async getWithMetadata(key: string, options?: string | { type?: string }) {
    const value = await this.get(key, options);
    const entry = this.store.get(key);
    return { value, metadata: entry?.metadata ?? null };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { metadata?: unknown; expirationTtl?: number; expiration?: number },
  ) {
    let stored: string | ArrayBuffer;
    if (value instanceof ReadableStream) {
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
      stored = buf.buffer;
    } else {
      stored = value;
    }

    let expiration: number | undefined;
    if (options?.expiration) expiration = options.expiration;
    else if (options?.expirationTtl) expiration = Date.now() / 1000 + options.expirationTtl;

    this.store.set(key, { value: stored, metadata: options?.metadata, expiration });
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const keys: { name: string; expiration?: number; metadata?: unknown }[] = [];

    for (const [name, entry] of this.store) {
      if (!name.startsWith(prefix)) continue;
      if (entry.expiration && entry.expiration < Date.now() / 1000) {
        this.store.delete(name);
        continue;
      }
      keys.push({ name, expiration: entry.expiration, metadata: entry.metadata });
      if (keys.length >= limit) break;
    }

    return { keys, list_complete: keys.length < limit, cursor: "" };
  }
}
