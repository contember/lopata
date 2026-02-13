import { getDatabase, getDataDir } from "../db";
import type { WranglerConfig } from "../config";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readdirSync, unlinkSync } from "node:fs";

const PREFIX = "/__dashboard";
const API_PREFIX = `${PREFIX}/api`;

// Store config for showing configured-but-empty bindings
let _config: WranglerConfig | null = null;

export function setDashboardConfig(config: WranglerConfig): void {
  _config = config;
}

// Dashboard HTML — must be used in Bun.serve routes (not fetch) for proper bundling
export { default as dashboardHtml } from "./index.html";

export function handleDashboardRequest(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // API routes
  if (path.startsWith(API_PREFIX)) {
    return handleApiRequest(request, path.slice(API_PREFIX.length), url);
  }

  // Non-API dashboard routes are handled by Bun.serve routes
  return new Response("Not found", { status: 404 });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(msg = "Not found"): Response {
  return json({ error: msg }, 404);
}

function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

// Parse path segments after the API prefix: /kv/MY_NS/mykey -> ["kv", "MY_NS", "mykey"]
function segments(apiPath: string): string[] {
  return apiPath.split("/").filter(Boolean);
}

function seg(parts: string[], index: number): string {
  return decodeURIComponent(parts[index] ?? "");
}

async function handleApiRequest(request: Request, apiPath: string, url: URL): Promise<Response> {
  const parts = segments(apiPath);
  const method = request.method;
  const section = parts[0] ?? "";

  try {
    if (section === "overview" && method === "GET") return handleOverview();
    if (section === "kv") return handleKv(method, parts.slice(1), url);
    if (section === "r2") return handleR2(method, parts.slice(1), url);
    if (section === "queue") return handleQueue(method, parts.slice(1), url);
    if (section === "do") return handleDo(method, parts.slice(1));
    if (section === "workflows") return handleWorkflows(method, parts.slice(1), url, request);
    if (section === "d1") return handleD1(method, parts.slice(1), request);
    if (section === "cache") return handleCache(method, parts.slice(1), url);
    return notFound("Unknown API route");
  } catch (err) {
    console.error("[bunflare dashboard] API error:", err);
    return json({ error: String(err) }, 500);
  }
}

// Helper to run parameterized queries with dynamic params
function queryAll(db: Database, sql: string, params: SQLQueryBindings[]): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

// ─── Overview ────────────────────────────────────────────────────────
function handleOverview(): Response {
  const db = getDatabase();

  const d1Dir = join(getDataDir(), "d1");
  let d1Count = 0;
  if (existsSync(d1Dir)) {
    d1Count = readdirSync(d1Dir).filter(f => f.endsWith(".sqlite")).length;
  }

  // Merge DB-discovered with configured bindings
  const dbKv = new Set(db.query<{ namespace: string }, []>("SELECT DISTINCT namespace FROM kv").all().map(r => r.namespace));
  const dbR2 = new Set(db.query<{ bucket: string }, []>("SELECT DISTINCT bucket FROM r2_objects").all().map(r => r.bucket));
  const dbQueue = new Set(db.query<{ queue: string }, []>("SELECT DISTINCT queue FROM queue_messages").all().map(r => r.queue));
  const dbDo = new Set(db.query<{ namespace: string }, []>("SELECT DISTINCT namespace FROM do_storage").all().map(r => r.namespace));
  const dbWorkflows = new Set(db.query<{ workflow_name: string }, []>("SELECT DISTINCT workflow_name FROM workflow_instances").all().map(r => r.workflow_name));

  if (_config) {
    for (const ns of _config.kv_namespaces ?? []) dbKv.add(ns.binding);
    for (const b of _config.r2_buckets ?? []) dbR2.add(b.bucket_name);
    for (const p of _config.queues?.producers ?? []) dbQueue.add(p.queue);
    for (const b of _config.durable_objects?.bindings ?? []) dbDo.add(b.class_name);
    for (const w of _config.workflows ?? []) dbWorkflows.add(w.binding);
    d1Count = Math.max(d1Count, (_config.d1_databases ?? []).length);
  }

  return json({
    kv: dbKv.size,
    r2: dbR2.size,
    queue: dbQueue.size,
    do: dbDo.size,
    workflows: dbWorkflows.size,
    d1: d1Count,
    cache: db.query<{ count: number }, []>("SELECT COUNT(DISTINCT cache_name) as count FROM cache_entries").get()?.count ?? 0,
  });
}

// ─── KV ──────────────────────────────────────────────────────────────
function handleKv(method: string, parts: string[], url: URL): Response {
  const db = getDatabase();

  if (parts.length === 0 && method === "GET") {
    const rows = db.query<{ namespace: string; count: number }, []>(
      "SELECT namespace, COUNT(*) as count FROM kv GROUP BY namespace ORDER BY namespace"
    ).all();
    const rowMap = new Map(rows.map(r => [r.namespace, r]));
    // Add configured but empty namespaces
    for (const ns of _config?.kv_namespaces ?? []) {
      if (!rowMap.has(ns.binding)) {
        rows.push({ namespace: ns.binding, count: 0 });
      }
    }
    rows.sort((a, b) => a.namespace.localeCompare(b.namespace));
    return json(rows);
  }

  const ns = seg(parts, 0);

  if (parts.length === 1 && method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50");
    const cursor = url.searchParams.get("cursor") ?? "";
    const prefix = url.searchParams.get("prefix") ?? "";

    let query = "SELECT key, LENGTH(value) as size, metadata, expiration FROM kv WHERE namespace = ?";
    const params: SQLQueryBindings[] = [ns];

    if (prefix) { query += " AND key LIKE ?"; params.push(prefix + "%"); }
    if (cursor) { query += " AND key > ?"; params.push(cursor); }
    query += " ORDER BY key LIMIT ?";
    params.push(limit + 1);

    const rows = queryAll(db, query, params) as { key: string; size: number; metadata: string | null; expiration: number | null }[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return json({ items, cursor: hasMore && last ? last.key : null });
  }

  if (parts.length === 2 && method === "GET") {
    const key = seg(parts, 1);
    const row = db.query<{ value: Buffer; metadata: string | null; expiration: number | null }, [string, string]>(
      "SELECT value, metadata, expiration FROM kv WHERE namespace = ? AND key = ?"
    ).get(ns, key);
    if (!row) return notFound("Key not found");

    let valueStr: string;
    try { valueStr = new TextDecoder().decode(row.value); }
    catch { valueStr = `<binary: ${row.value.length} bytes>`; }

    return json({
      key,
      value: valueStr,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      expiration: row.expiration,
    });
  }

  if (parts.length === 2 && method === "DELETE") {
    const key = seg(parts, 1);
    db.prepare("DELETE FROM kv WHERE namespace = ? AND key = ?").run(ns, key);
    return json({ ok: true });
  }

  return notFound();
}

// ─── R2 ──────────────────────────────────────────────────────────────
function handleR2(method: string, parts: string[], url: URL): Response {
  const db = getDatabase();

  if (parts.length === 0 && method === "GET") {
    const rows = db.query<{ bucket: string; count: number; total_size: number }, []>(
      "SELECT bucket, COUNT(*) as count, COALESCE(SUM(size),0) as total_size FROM r2_objects GROUP BY bucket ORDER BY bucket"
    ).all();
    const rowMap = new Map(rows.map(r => [r.bucket, r]));
    for (const b of _config?.r2_buckets ?? []) {
      if (!rowMap.has(b.bucket_name)) {
        rows.push({ bucket: b.bucket_name, count: 0, total_size: 0 });
      }
    }
    rows.sort((a, b) => a.bucket.localeCompare(b.bucket));
    return json(rows);
  }

  const bucket = seg(parts, 0);

  if (parts.length === 1 && method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50");
    const cursor = url.searchParams.get("cursor") ?? "";
    const prefix = url.searchParams.get("prefix") ?? "";

    let query = "SELECT key, size, etag, uploaded, http_metadata, custom_metadata FROM r2_objects WHERE bucket = ?";
    const params: SQLQueryBindings[] = [bucket];

    if (prefix) { query += " AND key LIKE ?"; params.push(prefix + "%"); }
    if (cursor) { query += " AND key > ?"; params.push(cursor); }
    query += " ORDER BY key LIMIT ?";
    params.push(limit + 1);

    const rows = queryAll(db, query, params) as { key: string }[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return json({ items, cursor: hasMore && last ? last.key : null });
  }

  if (parts.length >= 2 && method === "DELETE") {
    const key = parts.slice(1).map(decodeURIComponent).join("/");
    db.prepare("DELETE FROM r2_objects WHERE bucket = ? AND key = ?").run(bucket, key);
    const filePath = join(getDataDir(), "r2", bucket, key);
    if (existsSync(filePath)) unlinkSync(filePath);
    return json({ ok: true });
  }

  return notFound();
}

// ─── Queue ───────────────────────────────────────────────────────────
function handleQueue(method: string, parts: string[], url: URL): Response {
  const db = getDatabase();

  if (parts.length === 0 && method === "GET") {
    const rows = db.query<{ queue: string; pending: number; acked: number; failed: number }, []>(
      `SELECT queue,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'acked' THEN 1 ELSE 0 END) as acked,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM queue_messages GROUP BY queue ORDER BY queue`
    ).all();
    const rowMap = new Map(rows.map(r => [r.queue, r]));
    for (const p of _config?.queues?.producers ?? []) {
      if (!rowMap.has(p.queue)) {
        rows.push({ queue: p.queue, pending: 0, acked: 0, failed: 0 });
      }
    }
    rows.sort((a, b) => a.queue.localeCompare(b.queue));
    return json(rows);
  }

  const queue = seg(parts, 0);

  if (parts.length === 1 && method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50");
    const status = url.searchParams.get("status");

    let query = "SELECT id, body, content_type, status, attempts, visible_at, created_at, completed_at FROM queue_messages WHERE queue = ?";
    const params: SQLQueryBindings[] = [queue];

    if (status) { query += " AND status = ?"; params.push(status); }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = queryAll(db, query, params);

    const items = rows.map(row => {
      let bodyStr: string;
      try { bodyStr = new TextDecoder().decode(row.body as BufferSource); }
      catch { bodyStr = `<binary>`; }
      return { ...row, body: bodyStr };
    });
    return json(items);
  }

  if (parts.length === 2 && method === "DELETE") {
    db.prepare("DELETE FROM queue_messages WHERE queue = ? AND id = ?").run(queue, seg(parts, 1));
    return json({ ok: true });
  }

  return notFound();
}

// ─── Durable Objects ─────────────────────────────────────────────────
function handleDo(method: string, parts: string[]): Response {
  const db = getDatabase();

  if (parts.length === 0 && method === "GET") {
    const rows = db.query<{ namespace: string; count: number }, []>(
      "SELECT namespace, COUNT(DISTINCT id) as count FROM do_storage GROUP BY namespace ORDER BY namespace"
    ).all();
    const rowMap = new Map(rows.map(r => [r.namespace, r]));
    for (const b of _config?.durable_objects?.bindings ?? []) {
      if (!rowMap.has(b.class_name)) {
        rows.push({ namespace: b.class_name, count: 0 });
      }
    }
    rows.sort((a, b) => a.namespace.localeCompare(b.namespace));
    return json(rows);
  }

  const ns = seg(parts, 0);

  if (parts.length === 1 && method === "GET") {
    const rows = db.query<{ id: string; key_count: number }, [string]>(
      "SELECT id, COUNT(*) as key_count FROM do_storage WHERE namespace = ? GROUP BY id ORDER BY id"
    ).all(ns);

    const alarms = db.query<{ id: string; alarm_time: number }, [string]>(
      "SELECT id, alarm_time FROM do_alarms WHERE namespace = ?"
    ).all(ns);
    const alarmMap = new Map(alarms.map(a => [a.id, a.alarm_time]));

    const items = rows.map(row => ({
      ...row,
      alarm: alarmMap.get(row.id) ?? null,
    }));
    return json(items);
  }

  if (parts.length === 2 && method === "GET") {
    const id = seg(parts, 1);
    const entries = db.query<{ key: string; value: string }, [string, string]>(
      "SELECT key, value FROM do_storage WHERE namespace = ? AND id = ? ORDER BY key"
    ).all(ns, id);

    const alarm = db.query<{ alarm_time: number }, [string, string]>(
      "SELECT alarm_time FROM do_alarms WHERE namespace = ? AND id = ?"
    ).get(ns, id);

    return json({ entries, alarm: alarm?.alarm_time ?? null });
  }

  if (parts.length === 3 && method === "DELETE") {
    db.prepare("DELETE FROM do_storage WHERE namespace = ? AND id = ? AND key = ?").run(ns, seg(parts, 1), seg(parts, 2));
    return json({ ok: true });
  }

  return notFound();
}

// ─── Workflows ───────────────────────────────────────────────────────
function handleWorkflows(method: string, parts: string[], url: URL, request: Request): Response | Promise<Response> {
  const db = getDatabase();

  if (parts.length === 0 && method === "GET") {
    const rows = db.query<{ workflow_name: string; status: string; count: number }, []>(
      "SELECT workflow_name, status, COUNT(*) as count FROM workflow_instances GROUP BY workflow_name, status ORDER BY workflow_name"
    ).all();

    const grouped = new Map<string, { total: number; byStatus: Record<string, number> }>();
    for (const row of rows) {
      let entry = grouped.get(row.workflow_name);
      if (!entry) {
        entry = { total: 0, byStatus: {} };
        grouped.set(row.workflow_name, entry);
      }
      entry.total += row.count;
      entry.byStatus[row.status] = row.count;
    }

    // Add configured but empty workflows
    for (const w of _config?.workflows ?? []) {
      if (!grouped.has(w.binding)) {
        grouped.set(w.binding, { total: 0, byStatus: {} });
      }
    }

    return json(Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([name, data]) => ({ name, ...data })));
  }

  const name = seg(parts, 0);

  if (parts.length === 1 && method === "GET") {
    const status = url.searchParams.get("status");
    let query = "SELECT id, status, params, output, error, created_at, updated_at FROM workflow_instances WHERE workflow_name = ?";
    const params: SQLQueryBindings[] = [name];

    if (status) { query += " AND status = ?"; params.push(status); }
    query += " ORDER BY created_at DESC LIMIT 100";

    return json(queryAll(db, query, params));
  }

  if (parts.length === 2 && method === "GET") {
    const id = seg(parts, 1);
    const instance = db.query<Record<string, unknown>, [string]>(
      "SELECT * FROM workflow_instances WHERE id = ?"
    ).get(id);
    if (!instance) return notFound("Workflow instance not found");

    const steps = db.query<Record<string, unknown>, [string]>(
      "SELECT step_name, output, completed_at FROM workflow_steps WHERE instance_id = ? ORDER BY completed_at"
    ).all(id);

    const events = db.query<Record<string, unknown>, [string]>(
      "SELECT id, event_type, payload, created_at FROM workflow_events WHERE instance_id = ? ORDER BY created_at"
    ).all(id);

    return json({ ...instance, steps, events });
  }

  if (parts.length === 3 && parts[2] === "terminate" && method === "POST") {
    const id = seg(parts, 1);
    db.prepare("UPDATE workflow_instances SET status = 'terminated', updated_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), id);
    return json({ ok: true });
  }

  return notFound();
}

// ─── D1 ──────────────────────────────────────────────────────────────
function handleD1(method: string, parts: string[], request: Request): Response | Promise<Response> {
  const d1Dir = join(getDataDir(), "d1");

  if (parts.length === 0 && method === "GET") {
    const databases: { name: string; tables: number }[] = [];
    const seen = new Set<string>();

    if (existsSync(d1Dir)) {
      const files = readdirSync(d1Dir).filter(f => f.endsWith(".sqlite"));
      for (const f of files) {
        const name = f.replace(".sqlite", "");
        seen.add(name);
        const d1db = new Database(join(d1Dir, f));
        try {
          const tables = d1db.query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
          ).all();
          databases.push({ name, tables: tables.length });
        } finally {
          d1db.close();
        }
      }
    }

    // Add configured but not-yet-created D1 databases
    for (const d of _config?.d1_databases ?? []) {
      if (!seen.has(d.database_name)) {
        databases.push({ name: d.database_name, tables: 0 });
      }
    }

    databases.sort((a, b) => a.name.localeCompare(b.name));
    return json(databases);
  }

  const dbName = seg(parts, 0);
  const dbPath = join(d1Dir, `${dbName}.sqlite`);
  if (!existsSync(dbPath)) return notFound("Database not found");

  const sub = parts[1] ?? "";

  if (parts.length === 2 && sub === "tables" && method === "GET") {
    const d1db = new Database(dbPath);
    try {
      const tables = d1db.query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all();

      const result = tables.map(t => {
        const row = d1db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM "${t.name}"`).get();
        return { name: t.name, sql: t.sql, rows: row?.count ?? 0 };
      });
      return json(result);
    } finally {
      d1db.close();
    }
  }

  if (parts.length === 2 && sub === "query" && method === "POST") {
    return (async () => {
      const body = await request.json() as { sql: string };
      if (!body.sql) return badRequest("Missing sql field");

      const d1db = new Database(dbPath);
      try {
        const stmt = d1db.prepare(body.sql);
        if (stmt.columnNames.length > 0) {
          const rows = stmt.all();
          return json({ columns: stmt.columnNames, rows, count: rows.length });
        } else {
          stmt.run();
          const changes = d1db.query<{ c: number }, []>("SELECT changes() as c").get()?.c ?? 0;
          return json({ columns: [], rows: [], count: changes, message: `${changes} row(s) affected` });
        }
      } catch (err) {
        return json({ error: String(err) }, 400);
      } finally {
        d1db.close();
      }
    })();
  }

  return notFound();
}

// ─── Cache ───────────────────────────────────────────────────────────
function handleCache(method: string, parts: string[], url: URL): Response {
  const db = getDatabase();

  if (parts.length === 0 && method === "GET") {
    const rows = db.query<{ cache_name: string; count: number }, []>(
      "SELECT cache_name, COUNT(*) as count FROM cache_entries GROUP BY cache_name ORDER BY cache_name"
    ).all();
    return json(rows);
  }

  const name = seg(parts, 0);

  if (parts.length === 1 && method === "GET") {
    const rows = db.query<{ url: string; status: number; headers: string; expires_at: number | null }, [string]>(
      "SELECT url, status, headers, expires_at FROM cache_entries WHERE cache_name = ? ORDER BY url"
    ).all(name);
    return json(rows);
  }

  if (parts.length === 1 && method === "DELETE") {
    const entryUrl = url.searchParams.get("url");
    if (!entryUrl) return badRequest("Missing url query parameter");
    db.prepare("DELETE FROM cache_entries WHERE cache_name = ? AND url = ?").run(name, entryUrl);
    return json({ ok: true });
  }

  return notFound();
}
