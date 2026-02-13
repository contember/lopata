import type { HandlerContext, KvNamespace, Paginated, KvKey, KvValue, OkResponse } from "../types";
import { getDatabase } from "../../../db";
import type { SQLQueryBindings } from "bun:sqlite";

export const handlers = {
  "kv.listNamespaces"(_input: {}, ctx: HandlerContext): KvNamespace[] {
    const db = getDatabase();
    const rows = db.query<{ namespace: string; count: number }, []>(
      "SELECT namespace, COUNT(*) as count FROM kv GROUP BY namespace ORDER BY namespace"
    ).all();
    const rowMap = new Map(rows.map(r => [r.namespace, r]));
    for (const ns of ctx.config?.kv_namespaces ?? []) {
      if (!rowMap.has(ns.binding)) {
        rows.push({ namespace: ns.binding, count: 0 });
      }
    }
    rows.sort((a, b) => a.namespace.localeCompare(b.namespace));
    return rows;
  },

  "kv.listKeys"({ ns, limit = 50, cursor = "", prefix = "" }: { ns: string; limit?: number; cursor?: string; prefix?: string }): Paginated<KvKey> {
    const db = getDatabase();
    let query = "SELECT key, LENGTH(value) as size, metadata, expiration FROM kv WHERE namespace = ?";
    const params: SQLQueryBindings[] = [ns];

    if (prefix) { query += " AND key LIKE ?"; params.push(prefix + "%"); }
    if (cursor) { query += " AND key > ?"; params.push(cursor); }
    query += " ORDER BY key LIMIT ?";
    params.push(limit + 1);

    const rows = db.prepare(query).all(...params) as KvKey[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, cursor: hasMore && last ? last.key : null };
  },

  "kv.getKey"({ ns, key }: { ns: string; key: string }): KvValue {
    const db = getDatabase();
    const row = db.query<{ value: Buffer; metadata: string | null; expiration: number | null }, [string, string]>(
      "SELECT value, metadata, expiration FROM kv WHERE namespace = ? AND key = ?"
    ).get(ns, key);
    if (!row) throw new Error("Key not found");

    let valueStr: string;
    try { valueStr = new TextDecoder().decode(row.value); }
    catch { valueStr = `<binary: ${row.value.length} bytes>`; }

    return {
      key,
      value: valueStr,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      expiration: row.expiration,
    };
  },

  "kv.deleteKey"({ ns, key }: { ns: string; key: string }): OkResponse {
    const db = getDatabase();
    db.prepare("DELETE FROM kv WHERE namespace = ? AND key = ?").run(ns, key);
    return { ok: true };
  },
};
