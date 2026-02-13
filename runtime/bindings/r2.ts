import type { Database } from "bun:sqlite";
import { join, dirname, resolve } from "node:path";
import { mkdirSync, rmSync, existsSync, statSync } from "node:fs";

// --- Limits ---

export interface R2Limits {
  maxKeySize?: number; // default 1024 bytes
  maxCustomMetadataSize?: number; // default 2048 bytes
  maxBatchDeleteKeys?: number; // default 1000
  maxMultipartPartSize?: number; // default 5 GiB (not enforced, just documented)
  minMultipartPartSize?: number; // default 5 MiB (last part exempt)
  maxMultipartParts?: number; // default 10000
}

const R2_DEFAULTS: Required<R2Limits> = {
  maxKeySize: 1024,
  maxCustomMetadataSize: 2048,
  maxBatchDeleteKeys: 1000,
  maxMultipartPartSize: 5 * 1024 * 1024 * 1024,
  minMultipartPartSize: 5 * 1024 * 1024,
  maxMultipartParts: 10000,
};

// --- Interfaces ---

export interface R2Conditional {
  etagMatches?: string | string[];
  etagDoesNotMatch?: string | string[];
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface R2Checksums {
  md5?: ArrayBuffer;
  sha1?: ArrayBuffer;
  sha256?: ArrayBuffer;
  sha384?: ArrayBuffer;
  sha512?: ArrayBuffer;
}

export interface R2GetOptions {
  onlyIf?: R2Conditional;
  range?: R2Range;
}

export interface R2PutOptions {
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
  onlyIf?: R2Conditional;
  md5?: ArrayBuffer | string;
  sha1?: ArrayBuffer | string;
  sha256?: ArrayBuffer | string;
  sha384?: ArrayBuffer | string;
  sha512?: ArrayBuffer | string;
}

export interface R2ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
  delimiter?: string;
  include?: ("httpMetadata" | "customMetadata")[];
}

interface R2ObjectMeta {
  key: string;
  size: number;
  etag: string;
  version: string;
  uploaded: Date;
  httpMetadata: Record<string, string>;
  customMetadata: Record<string, string>;
  checksums: R2Checksums;
  range?: { offset: number; length: number };
}

// --- R2Object ---

export class R2Object {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly version: string;
  readonly uploaded: Date;
  readonly httpMetadata: Record<string, string>;
  readonly customMetadata: Record<string, string>;
  readonly checksums: R2Checksums;
  readonly storageClass: string;
  readonly range?: { offset: number; length: number };

  constructor(meta: R2ObjectMeta) {
    this.key = meta.key;
    this.size = meta.size;
    this.etag = meta.etag;
    this.httpEtag = `"${meta.etag}"`;
    this.version = meta.version;
    this.uploaded = meta.uploaded;
    this.httpMetadata = meta.httpMetadata;
    this.customMetadata = meta.customMetadata;
    this.checksums = meta.checksums;
    this.storageClass = "Standard";
    this.range = meta.range;
  }

  writeHttpMetadata(headers: Headers): void {
    for (const [k, v] of Object.entries(this.httpMetadata)) {
      headers.set(k, v);
    }
  }
}

// --- R2ObjectBody ---

export class R2ObjectBody extends R2Object {
  private data: ArrayBuffer;
  readonly bodyUsed: boolean = false;

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

  async blob(): Promise<Blob> {
    return new Blob([this.data]);
  }
}

// --- DB row ---

interface R2Row {
  key: string;
  size: number;
  etag: string;
  version: string;
  uploaded: string;
  http_metadata: string | null;
  custom_metadata: string | null;
  checksums: string | null;
}

function rowToMeta(row: R2Row): R2ObjectMeta {
  return {
    key: row.key,
    size: row.size,
    etag: row.etag,
    version: row.version ?? row.etag,
    uploaded: new Date(row.uploaded),
    httpMetadata: row.http_metadata ? JSON.parse(row.http_metadata) : {},
    customMetadata: row.custom_metadata ? JSON.parse(row.custom_metadata) : {},
    checksums: row.checksums ? deserializeChecksums(JSON.parse(row.checksums)) : {},
  };
}

function serializeChecksums(c: R2Checksums): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v instanceof ArrayBuffer) {
      result[k] = Buffer.from(v).toString("hex");
    } else if (typeof v === "string") {
      result[k] = v;
    }
  }
  return result;
}

function deserializeChecksums(c: Record<string, string>): R2Checksums {
  const result: R2Checksums = {};
  for (const [k, v] of Object.entries(c)) {
    (result as Record<string, ArrayBuffer>)[k] = Buffer.from(v, "hex").buffer as ArrayBuffer;
  }
  return result;
}

// --- Conditional check ---

function evaluateConditional(cond: R2Conditional, etag: string, uploaded: Date): boolean {
  if (cond.etagMatches !== undefined) {
    const tags = Array.isArray(cond.etagMatches) ? cond.etagMatches : [cond.etagMatches];
    if (!tags.some((t) => t === etag || t === `"${etag}"` || t === "*")) return false;
  }
  if (cond.etagDoesNotMatch !== undefined) {
    const tags = Array.isArray(cond.etagDoesNotMatch) ? cond.etagDoesNotMatch : [cond.etagDoesNotMatch];
    if (tags.some((t) => t === etag || t === `"${etag}"`)) return false;
  }
  if (cond.uploadedBefore !== undefined) {
    if (uploaded >= cond.uploadedBefore) return false;
  }
  if (cond.uploadedAfter !== undefined) {
    if (uploaded <= cond.uploadedAfter) return false;
  }
  return true;
}

// --- Multipart Upload ---

interface MultipartRow {
  upload_id: string;
  bucket: string;
  key: string;
  http_metadata: string | null;
  custom_metadata: string | null;
  created_at: string;
}

interface MultipartPartRow {
  upload_id: string;
  part_number: number;
  etag: string;
  size: number;
  file_path: string;
}

export class R2MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  private db: Database;
  private bucket: string;
  private baseDir: string;
  private limits: Required<R2Limits>;

  constructor(
    db: Database,
    bucket: string,
    baseDir: string,
    key: string,
    uploadId: string,
    limits: Required<R2Limits>,
  ) {
    this.db = db;
    this.bucket = bucket;
    this.baseDir = baseDir;
    this.key = key;
    this.uploadId = uploadId;
    this.limits = limits;
  }

  async uploadPart(partNumber: number, data: ArrayBuffer | Uint8Array | string | ReadableStream): Promise<{ partNumber: number; etag: string }> {
    // Verify upload exists and is not aborted/completed
    const upload = this.db
      .query<MultipartRow, [string, string]>(
        `SELECT * FROM r2_multipart_uploads WHERE upload_id = ? AND bucket = ?`,
      )
      .get(this.uploadId, this.bucket);
    if (!upload) throw new Error("Multipart upload not found or already completed/aborted");

    let buf: ArrayBuffer;
    if (typeof data === "string") {
      buf = new TextEncoder().encode(data).buffer as ArrayBuffer;
    } else if (data instanceof Uint8Array) {
      buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } else if (data instanceof ArrayBuffer) {
      buf = data;
    } else {
      // ReadableStream
      const chunks: Uint8Array[] = [];
      const reader = data.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const combined = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        combined.set(c, offset);
        offset += c.length;
      }
      buf = combined.buffer as ArrayBuffer;
    }

    const hasher = new Bun.CryptoHasher("md5");
    hasher.update(new Uint8Array(buf));
    const etag = hasher.digest("hex");

    // Store part data to a temp file
    const partDir = join(this.baseDir, "__multipart__", this.uploadId);
    mkdirSync(partDir, { recursive: true });
    const partPath = join(partDir, `part-${partNumber}`);
    await Bun.write(partPath, buf);

    // Upsert part record
    this.db.run(
      `INSERT OR REPLACE INTO r2_multipart_parts (upload_id, part_number, etag, size, file_path)
       VALUES (?, ?, ?, ?, ?)`,
      [this.uploadId, partNumber, etag, buf.byteLength, partPath],
    );

    return { partNumber, etag };
  }

  async complete(parts: { partNumber: number; etag: string }[]): Promise<R2Object> {
    const upload = this.db
      .query<MultipartRow, [string, string]>(
        `SELECT * FROM r2_multipart_uploads WHERE upload_id = ? AND bucket = ?`,
      )
      .get(this.uploadId, this.bucket);
    if (!upload) throw new Error("Multipart upload not found or already completed/aborted");

    // Sort parts by partNumber
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    // Load all part data
    const allParts: Uint8Array[] = [];
    let totalSize = 0;
    for (const p of sorted) {
      const partRow = this.db
        .query<MultipartPartRow, [string, number]>(
          `SELECT * FROM r2_multipart_parts WHERE upload_id = ? AND part_number = ?`,
        )
        .get(this.uploadId, p.partNumber);
      if (!partRow) throw new Error(`Part ${p.partNumber} not found`);
      if (partRow.etag !== p.etag) throw new Error(`Part ${p.partNumber} etag mismatch`);
      const data = await Bun.file(partRow.file_path).arrayBuffer();
      allParts.push(new Uint8Array(data));
      totalSize += data.byteLength;
    }

    // Concatenate
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const part of allParts) {
      combined.set(part, offset);
      offset += part.length;
    }

    // Write final file
    const filePath = join(this.baseDir, this.key);
    mkdirSync(dirname(filePath), { recursive: true });
    await Bun.write(filePath, combined);

    const hasher = new Bun.CryptoHasher("md5");
    hasher.update(combined);
    const etag = hasher.digest("hex");
    const uploaded = new Date();
    const version = crypto.randomUUID();

    const httpMeta = upload.http_metadata ? JSON.parse(upload.http_metadata) : {};
    const customMeta = upload.custom_metadata ? JSON.parse(upload.custom_metadata) : {};

    // Insert object record
    this.db.run(
      `INSERT OR REPLACE INTO r2_objects (bucket, key, size, etag, version, uploaded, http_metadata, custom_metadata, checksums)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.bucket,
        this.key,
        totalSize,
        etag,
        version,
        uploaded.toISOString(),
        upload.http_metadata,
        upload.custom_metadata,
        null,
      ],
    );

    // Clean up multipart data
    this.cleanupMultipart();

    return new R2Object({
      key: this.key,
      size: totalSize,
      etag,
      version,
      uploaded,
      httpMetadata: httpMeta,
      customMetadata: customMeta,
      checksums: {},
    });
  }

  async abort(): Promise<void> {
    this.cleanupMultipart();
  }

  private cleanupMultipart(): void {
    // Delete part files
    const partDir = join(this.baseDir, "__multipart__", this.uploadId);
    if (existsSync(partDir)) {
      rmSync(partDir, { recursive: true, force: true });
    }
    // Delete DB records
    this.db.run(`DELETE FROM r2_multipart_parts WHERE upload_id = ?`, [this.uploadId]);
    this.db.run(`DELETE FROM r2_multipart_uploads WHERE upload_id = ?`, [this.uploadId]);
  }
}

// --- FileR2Bucket ---

export class FileR2Bucket {
  private db: Database;
  private bucket: string;
  private baseDir: string;
  private limits: Required<R2Limits>;

  constructor(db: Database, bucket: string, dataDir: string, limits?: R2Limits) {
    this.db = db;
    this.bucket = bucket;
    this.baseDir = join(dataDir, "r2", bucket);
    this.limits = { ...R2_DEFAULTS, ...limits };
    mkdirSync(this.baseDir, { recursive: true });

    // Ensure version and checksums columns exist (migration for existing DBs)
    this.ensureColumns();
    this.ensureMultipartTables();
  }

  private ensureColumns(): void {
    try {
      this.db.run(`ALTER TABLE r2_objects ADD COLUMN version TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
    try {
      this.db.run(`ALTER TABLE r2_objects ADD COLUMN checksums TEXT`);
    } catch {
      // Column already exists
    }
  }

  private ensureMultipartTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS r2_multipart_uploads (
        upload_id TEXT PRIMARY KEY,
        bucket TEXT NOT NULL,
        key TEXT NOT NULL,
        http_metadata TEXT,
        custom_metadata TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS r2_multipart_parts (
        upload_id TEXT NOT NULL,
        part_number INTEGER NOT NULL,
        etag TEXT NOT NULL,
        size INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        PRIMARY KEY (upload_id, part_number)
      )
    `);
  }

  private validateKey(key: string): void {
    const keyBytes = new TextEncoder().encode(key);
    if (keyBytes.length > this.limits.maxKeySize) {
      throw new Error(`Key exceeds max size of ${this.limits.maxKeySize} bytes`);
    }
    if (key.includes("..")) {
      throw new Error(`Invalid key: path traversal not allowed`);
    }
  }

  private validateCustomMetadata(metadata: Record<string, string> | undefined): void {
    if (!metadata) return;
    const serialized = JSON.stringify(metadata);
    if (new TextEncoder().encode(serialized).length > this.limits.maxCustomMetadataSize) {
      throw new Error(`Custom metadata exceeds max size of ${this.limits.maxCustomMetadataSize} bytes`);
    }
  }

  private filePath(key: string): string {
    return join(this.baseDir, key);
  }

  private async readValue(
    value: string | ArrayBuffer | ReadableStream | Blob | null,
  ): Promise<ArrayBuffer> {
    if (value === null) return new ArrayBuffer(0);
    if (typeof value === "string") return new TextEncoder().encode(value).buffer as ArrayBuffer;
    if (value instanceof ArrayBuffer) return value;
    if (value instanceof Blob) return await value.arrayBuffer();
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
    return buf.buffer as ArrayBuffer;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream | Blob | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    this.validateKey(key);
    this.validateCustomMetadata(options?.customMetadata);

    // Check conditional before writing
    if (options?.onlyIf) {
      const existing = this.getRow(key);
      if (existing) {
        const meta = rowToMeta(existing);
        if (!evaluateConditional(options.onlyIf, meta.etag, meta.uploaded)) {
          return null;
        }
      }
    }

    const data = await this.readValue(value);

    const fp = this.filePath(key);
    mkdirSync(dirname(fp), { recursive: true });
    await Bun.write(fp, data);

    const hasher = new Bun.CryptoHasher("md5");
    hasher.update(new Uint8Array(data));
    const etag = hasher.digest("hex");
    const uploaded = new Date();
    const version = crypto.randomUUID();

    // Build checksums from provided hashes
    const checksums: R2Checksums = { md5: Buffer.from(etag, "hex").buffer as ArrayBuffer };
    for (const algo of ["sha1", "sha256", "sha384", "sha512"] as const) {
      const provided = options?.[algo];
      if (provided) {
        (checksums as Record<string, ArrayBuffer>)[algo] =
          typeof provided === "string" ? Buffer.from(provided, "hex").buffer as ArrayBuffer : provided;
      }
    }

    this.db.run(
      `INSERT OR REPLACE INTO r2_objects (bucket, key, size, etag, version, uploaded, http_metadata, custom_metadata, checksums)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.bucket,
        key,
        data.byteLength,
        etag,
        version,
        uploaded.toISOString(),
        options?.httpMetadata ? JSON.stringify(options.httpMetadata) : null,
        options?.customMetadata ? JSON.stringify(options.customMetadata) : null,
        JSON.stringify(serializeChecksums(checksums)),
      ],
    );

    return new R2Object({
      key,
      size: data.byteLength,
      etag,
      version,
      uploaded,
      httpMetadata: options?.httpMetadata ?? {},
      customMetadata: options?.customMetadata ?? {},
      checksums,
    });
  }

  private getRow(key: string): R2Row | null {
    return this.db
      .query<R2Row, [string, string]>(
        `SELECT key, size, etag, version, uploaded, http_metadata, custom_metadata, checksums FROM r2_objects WHERE bucket = ? AND key = ?`,
      )
      .get(this.bucket, key);
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
    const row = this.getRow(key);
    if (!row) return null;

    const meta = rowToMeta(row);

    // Check conditional
    if (options?.onlyIf) {
      if (!evaluateConditional(options.onlyIf, meta.etag, meta.uploaded)) {
        // Return R2Object (metadata only, no body) when condition fails
        return new R2Object(meta);
      }
    }

    const fp = this.filePath(key);
    const file = Bun.file(fp);
    let data = await file.arrayBuffer();

    // Handle range reads
    if (options?.range) {
      const range = options.range;
      let offset: number;
      let length: number;

      if ("suffix" in range && range.suffix !== undefined) {
        // suffix: last N bytes
        offset = Math.max(0, data.byteLength - range.suffix);
        length = data.byteLength - offset;
      } else {
        offset = range.offset ?? 0;
        length = range.length ?? (data.byteLength - offset);
        // Clamp to actual data size
        if (offset + length > data.byteLength) {
          length = data.byteLength - offset;
        }
      }

      data = data.slice(offset, offset + length);
      meta.range = { offset, length };
    }

    return new R2ObjectBody(meta, data);
  }

  async head(key: string): Promise<R2Object | null> {
    const row = this.getRow(key);
    if (!row) return null;
    return new R2Object(rowToMeta(row));
  }

  async delete(key: string | string[]) {
    const keys = Array.isArray(key) ? key : [key];
    if (keys.length > this.limits.maxBatchDeleteKeys) {
      throw new Error(`Cannot delete more than ${this.limits.maxBatchDeleteKeys} keys at once`);
    }
    for (const k of keys) {
      this.db.run(`DELETE FROM r2_objects WHERE bucket = ? AND key = ?`, [this.bucket, k]);
      const fp = this.filePath(k);
      if (existsSync(fp)) {
        rmSync(fp);
      }
    }
  }

  async list(options?: R2ListOptions) {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1000;
    const delimiter = options?.delimiter;
    const include = options?.include;
    const cursorOffset = options?.cursor ? parseInt(options.cursor, 10) : 0;

    const rows = this.db
      .query<R2Row, [string, string, number, number]>(
        `SELECT key, size, etag, version, uploaded, http_metadata, custom_metadata, checksums
         FROM r2_objects WHERE bucket = ? AND key LIKE ? ORDER BY key LIMIT ? OFFSET ?`,
      )
      .all(this.bucket, prefix + "%", limit + 1, cursorOffset);

    if (delimiter) {
      // With delimiter: group keys by delimiter, return delimitedPrefixes
      const prefixLen = prefix.length;
      const delimitedPrefixes = new Set<string>();
      const objects: R2Object[] = [];

      for (const row of rows.slice(0, limit)) {
        const rest = row.key.slice(prefixLen);
        const delimIdx = rest.indexOf(delimiter);
        if (delimIdx !== -1) {
          delimitedPrefixes.add(prefix + rest.slice(0, delimIdx + delimiter.length));
        } else {
          const meta = rowToMeta(row);
          objects.push(buildListObject(meta, include));
        }
      }

      const truncated = rows.length > limit;
      return {
        objects,
        truncated,
        cursor: truncated ? String(cursorOffset + limit) : "",
        delimitedPrefixes: [...delimitedPrefixes].sort(),
      };
    }

    const truncated = rows.length > limit;
    const resultRows = truncated ? rows.slice(0, limit) : rows;
    const objects = resultRows.map((row) => {
      const meta = rowToMeta(row);
      return buildListObject(meta, include);
    });

    return {
      objects,
      truncated,
      cursor: truncated ? String(cursorOffset + limit) : "",
      delimitedPrefixes: [] as string[],
    };
  }

  async createMultipartUpload(
    key: string,
    options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> },
  ): Promise<R2MultipartUpload> {
    this.validateKey(key);
    this.validateCustomMetadata(options?.customMetadata);

    const uploadId = crypto.randomUUID();
    this.db.run(
      `INSERT INTO r2_multipart_uploads (upload_id, bucket, key, http_metadata, custom_metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uploadId,
        this.bucket,
        key,
        options?.httpMetadata ? JSON.stringify(options.httpMetadata) : null,
        options?.customMetadata ? JSON.stringify(options.customMetadata) : null,
        new Date().toISOString(),
      ],
    );

    return new R2MultipartUpload(this.db, this.bucket, this.baseDir, key, uploadId, this.limits);
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    return new R2MultipartUpload(this.db, this.bucket, this.baseDir, key, uploadId, this.limits);
  }
}

function buildListObject(meta: R2ObjectMeta, include?: ("httpMetadata" | "customMetadata")[]): R2Object {
  if (include) {
    // Only include requested metadata
    const filtered: R2ObjectMeta = {
      ...meta,
      httpMetadata: include.includes("httpMetadata") ? meta.httpMetadata : {},
      customMetadata: include.includes("customMetadata") ? meta.customMetadata : {},
    };
    return new R2Object(filtered);
  }
  // By default, include both
  return new R2Object(meta);
}
