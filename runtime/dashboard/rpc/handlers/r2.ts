import type { HandlerContext, R2Bucket, R2Object, Paginated, OkResponse } from "../types";
import { getAllConfigs } from "../types";
import { getDatabase, getDataDir } from "../../../db";
import type { SQLQueryBindings } from "bun:sqlite";
import { join, dirname } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";

export const handlers = {
  "r2.listBuckets"(_input: {}, ctx: HandlerContext): R2Bucket[] {
    const db = getDatabase();
    const rows = db.query<{ bucket: string; count: number; total_size: number }, []>(
      "SELECT bucket, COUNT(*) as count, COALESCE(SUM(size),0) as total_size FROM r2_objects GROUP BY bucket ORDER BY bucket"
    ).all();
    const rowMap = new Map(rows.map(r => [r.bucket, r]));
    for (const config of getAllConfigs(ctx)) {
      for (const b of config.r2_buckets ?? []) {
        if (!rowMap.has(b.bucket_name)) {
          rows.push({ bucket: b.bucket_name, count: 0, total_size: 0 });
        }
      }
    }
    rows.sort((a, b) => a.bucket.localeCompare(b.bucket));
    return rows;
  },

  "r2.listObjects"({ bucket, limit = 50, cursor = "", prefix = "" }: { bucket: string; limit?: number; cursor?: string; prefix?: string }): Paginated<R2Object> {
    const db = getDatabase();
    let query = "SELECT key, size, etag, uploaded, http_metadata, custom_metadata FROM r2_objects WHERE bucket = ?";
    const params: SQLQueryBindings[] = [bucket];

    if (prefix) { query += " AND key LIKE ?"; params.push(prefix + "%"); }
    if (cursor) { query += " AND key > ?"; params.push(cursor); }
    query += " ORDER BY key LIMIT ?";
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as R2Object[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, cursor: hasMore && last ? last.key : null };
  },

  "r2.deleteObject"({ bucket, key }: { bucket: string; key: string }): OkResponse {
    const db = getDatabase();
    db.prepare("DELETE FROM r2_objects WHERE bucket = ? AND key = ?").run(bucket, key);
    const filePath = join(getDataDir(), "r2", bucket, key);
    if (existsSync(filePath)) unlinkSync(filePath);
    return { ok: true };
  },

  async "r2.renameObject"({ bucket, oldKey, newKey }: { bucket: string; oldKey: string; newKey: string }): Promise<OkResponse> {
    const db = getDatabase();
    const oldPath = join(getDataDir(), "r2", bucket, oldKey);
    const newPath = join(getDataDir(), "r2", bucket, newKey);

    if (!existsSync(oldPath)) {
      throw new Error(`Object "${oldKey}" not found in bucket "${bucket}"`);
    }

    mkdirSync(dirname(newPath), { recursive: true });
    const data = await Bun.file(oldPath).arrayBuffer();
    await Bun.write(newPath, data);

    db.run(
      "UPDATE r2_objects SET key = ? WHERE bucket = ? AND key = ?",
      [newKey, bucket, oldKey],
    );

    unlinkSync(oldPath);
    return { ok: true };
  },
};
