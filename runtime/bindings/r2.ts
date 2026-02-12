import type { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";

interface R2ObjectMeta {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
}

class R2Object {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly httpMetadata: Record<string, string>;
  readonly customMetadata: Record<string, string>;

  constructor(meta: R2ObjectMeta) {
    this.key = meta.key;
    this.size = meta.size;
    this.etag = meta.etag;
    this.uploaded = meta.uploaded;
    this.httpMetadata = meta.httpMetadata;
    this.customMetadata = meta.customMetadata;
  }
}

class R2ObjectBody extends R2Object {
  private data: ArrayBuffer;

  constructor(meta: R2ObjectMeta, data: ArrayBuffer) {
    super(meta);
    this.data = data;
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

interface R2Row {
  key: string;
  size: number;
  etag: string;
  uploaded: string;
  http_metadata: string | null;
  custom_metadata: string | null;
}

function rowToMeta(row: R2Row): R2ObjectMeta {
  return {
    key: row.key,
    size: row.size,
    etag: row.etag,
    uploaded: new Date(row.uploaded),
    httpMetadata: row.http_metadata ? JSON.parse(row.http_metadata) : {},
    customMetadata: row.custom_metadata ? JSON.parse(row.custom_metadata) : {},
  };
}

export class FileR2Bucket {
  private db: Database;
  private bucket: string;
  private baseDir: string;

  constructor(db: Database, bucket: string, dataDir: string) {
    this.db = db;
    this.bucket = bucket;
    this.baseDir = join(dataDir, "r2", bucket);
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePath(key: string): string {
    if (key.includes("..")) {
      throw new Error(`Invalid key: path traversal not allowed`);
    }
    return join(this.baseDir, key);
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

    const filePath = this.filePath(key);
    mkdirSync(dirname(filePath), { recursive: true });
    await Bun.write(filePath, data);

    const hasher = new Bun.CryptoHasher("md5");
    hasher.update(new Uint8Array(data));
    const etag = hasher.digest("hex");
    const uploaded = new Date();

    this.db.run(
      `INSERT OR REPLACE INTO r2_objects (bucket, key, size, etag, uploaded, http_metadata, custom_metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        this.bucket,
        key,
        data.byteLength,
        etag,
        uploaded.toISOString(),
        options?.httpMetadata ? JSON.stringify(options.httpMetadata) : null,
        options?.customMetadata ? JSON.stringify(options.customMetadata) : null,
      ],
    );

    return new R2Object({
      key,
      size: data.byteLength,
      etag,
      uploaded,
      httpMetadata: options?.httpMetadata ?? {},
      customMetadata: options?.customMetadata ?? {},
    });
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const row = this.db
      .query<R2Row, [string, string]>(
        `SELECT key, size, etag, uploaded, http_metadata, custom_metadata FROM r2_objects WHERE bucket = ? AND key = ?`,
      )
      .get(this.bucket, key);

    if (!row) return null;

    const filePath = this.filePath(key);
    const file = Bun.file(filePath);
    const data = await file.arrayBuffer();
    return new R2ObjectBody(rowToMeta(row), data);
  }

  async head(key: string): Promise<R2Object | null> {
    const row = this.db
      .query<R2Row, [string, string]>(
        `SELECT key, size, etag, uploaded, http_metadata, custom_metadata FROM r2_objects WHERE bucket = ? AND key = ?`,
      )
      .get(this.bucket, key);

    if (!row) return null;
    return new R2Object(rowToMeta(row));
  }

  async delete(key: string | string[]) {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      this.db.run(`DELETE FROM r2_objects WHERE bucket = ? AND key = ?`, [this.bucket, k]);
      const filePath = this.filePath(k);
      if (existsSync(filePath)) {
        rmSync(filePath);
      }
    }
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const cursorOffset = options?.cursor ? parseInt(options.cursor, 10) : 0;

    const rows = this.db
      .query<R2Row, [string, string, number, number]>(
        `SELECT key, size, etag, uploaded, http_metadata, custom_metadata
         FROM r2_objects WHERE bucket = ? AND key LIKE ? ORDER BY key LIMIT ? OFFSET ?`,
      )
      .all(this.bucket, prefix + "%", limit + 1, cursorOffset);

    const truncated = rows.length > limit;
    const resultRows = truncated ? rows.slice(0, limit) : rows;
    const objects = resultRows.map((row) => new R2Object(rowToMeta(row)));

    return {
      objects,
      truncated,
      cursor: truncated ? String(cursorOffset + limit) : "",
    };
  }
}
