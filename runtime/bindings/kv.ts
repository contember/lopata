import type { Database } from "bun:sqlite";

export class SqliteKVNamespace {
  private db: Database;
  private namespace: string;

  constructor(db: Database, namespace: string) {
    this.db = db;
    this.namespace = namespace;
  }

  async get(key: string, options?: string | { type?: string }): Promise<string | ArrayBuffer | object | ReadableStream | null> {
    const row = this.db.query<{ value: Buffer; metadata: string | null; expiration: number | null }, [string, string]>(
      "SELECT value, metadata, expiration FROM kv WHERE namespace = ? AND key = ?"
    ).get(this.namespace, key);

    if (!row) return null;

    if (row.expiration && row.expiration < Date.now() / 1000) {
      this.db.run("DELETE FROM kv WHERE namespace = ? AND key = ?", [this.namespace, key]);
      return null;
    }

    const type = typeof options === "string" ? options : options?.type ?? "text";
    return this.decodeValue(row.value, type);
  }

  async getWithMetadata(key: string, options?: string | { type?: string }) {
    const row = this.db.query<{ value: Buffer; metadata: string | null; expiration: number | null }, [string, string]>(
      "SELECT value, metadata, expiration FROM kv WHERE namespace = ? AND key = ?"
    ).get(this.namespace, key);

    if (!row) return { value: null, metadata: null };

    if (row.expiration && row.expiration < Date.now() / 1000) {
      this.db.run("DELETE FROM kv WHERE namespace = ? AND key = ?", [this.namespace, key]);
      return { value: null, metadata: null };
    }

    const type = typeof options === "string" ? options : options?.type ?? "text";
    const value = this.decodeValue(row.value, type);
    const metadata = row.metadata ? JSON.parse(row.metadata) : null;
    return { value, metadata };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { metadata?: unknown; expirationTtl?: number; expiration?: number },
  ) {
    const blob = await this.encodeValue(value);

    let expiration: number | null = null;
    if (options?.expiration) expiration = options.expiration;
    else if (options?.expirationTtl) expiration = Date.now() / 1000 + options.expirationTtl;

    const metadata = options?.metadata !== undefined ? JSON.stringify(options.metadata) : null;

    this.db.run(
      "INSERT OR REPLACE INTO kv (namespace, key, value, metadata, expiration) VALUES (?, ?, ?, ?, ?)",
      [this.namespace, key, blob, metadata, expiration],
    );
  }

  async delete(key: string) {
    this.db.run("DELETE FROM kv WHERE namespace = ? AND key = ?", [this.namespace, key]);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const cursor = options?.cursor ?? "";

    const now = Date.now() / 1000;

    // Lazily delete expired entries for this namespace
    this.db.run(
      "DELETE FROM kv WHERE namespace = ? AND expiration IS NOT NULL AND expiration < ?",
      [this.namespace, now],
    );

    let rows: { key: string; expiration: number | null; metadata: string | null }[];

    if (cursor) {
      rows = this.db.query<
        { key: string; expiration: number | null; metadata: string | null },
        [string, string, string, number]
      >(
        "SELECT key, expiration, metadata FROM kv WHERE namespace = ? AND key LIKE ? AND key > ? ORDER BY key LIMIT ?",
      ).all(this.namespace, prefix + "%", cursor, limit + 1);
    } else {
      rows = this.db.query<
        { key: string; expiration: number | null; metadata: string | null },
        [string, string, number]
      >(
        "SELECT key, expiration, metadata FROM kv WHERE namespace = ? AND key LIKE ? ORDER BY key LIMIT ?",
      ).all(this.namespace, prefix + "%", limit + 1);
    }

    const listComplete = rows.length <= limit;
    const resultRows = rows.slice(0, limit);

    const keys = resultRows.map((row) => ({
      name: row.key,
      expiration: row.expiration ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));

    const lastRow = resultRows[resultRows.length - 1];
    const newCursor = listComplete || !lastRow ? "" : lastRow.key;

    return { keys, list_complete: listComplete, cursor: newCursor };
  }

  private decodeValue(blob: Buffer, type: string): string | ArrayBuffer | object | ReadableStream {
    if (type === "json") {
      return JSON.parse(Buffer.from(blob).toString());
    }
    if (type === "arrayBuffer") {
      const buf = Buffer.from(blob);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    if (type === "stream") {
      const buf = Buffer.from(blob);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      });
    }
    // text
    return Buffer.from(blob).toString();
  }

  private async encodeValue(value: string | ArrayBuffer | ReadableStream): Promise<Buffer> {
    if (typeof value === "string") {
      return Buffer.from(value);
    }
    if (value instanceof ArrayBuffer) {
      return Buffer.from(value);
    }
    // ReadableStream
    const chunks: Uint8Array[] = [];
    const reader = value.getReader();
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
