import type { Database } from "bun:sqlite";
import { getTracingDatabase } from "./db";
import type { SpanData, SpanEventData, TraceEvent, TraceSummary, TraceDetail } from "./types";

type Listener = (event: TraceEvent) => void;

const TRACE_CAP = 10_000;
const PRUNE_BATCH = 100;
const STALE_SPAN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STALE_CLEANUP_INTERVAL_MS = 60 * 1000; // run every minute

export class TraceStore {
  private db: Database;
  private listeners = new Set<Listener>();
  private startTimeCache = new Map<string, number>();
  private rootSpanCount: number;

  private staleCleanupTimer: ReturnType<typeof setInterval>;
  private insertSpanStmt;
  private endSpanStmt;
  private getSpanStmt;
  private insertEventStmt;
  private updateAttributesStmt;

  constructor(db?: Database) {
    this.db = db ?? getTracingDatabase();

    this.insertSpanStmt = this.db.prepare<void, [string, string, string | null, string, string, string, string | null, number, number | null, number | null, string, string | null]>(
      `INSERT INTO spans (span_id, trace_id, parent_span_id, name, kind, status, status_message, start_time, end_time, duration_ms, attributes, worker_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.endSpanStmt = this.db.prepare<void, [number, number, string, string | null, string]>(
      `UPDATE spans SET end_time = ?, duration_ms = ?, status = ?, status_message = ? WHERE span_id = ?`
    );

    this.getSpanStmt = this.db.prepare<Record<string, unknown>, [string]>(
      `SELECT * FROM spans WHERE span_id = ?`
    );

    this.insertEventStmt = this.db.prepare<void, [string, string, number, string, string | null, string | null, string]>(
      `INSERT INTO span_events (span_id, trace_id, timestamp, name, level, message, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    this.updateAttributesStmt = this.db.prepare<void, [string, string]>(
      `UPDATE spans SET attributes = json_patch(COALESCE(attributes, '{}'), ?) WHERE span_id = ?`
    );

    // Init root span counter from DB
    this.rootSpanCount = this.db.prepare<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM spans WHERE parent_span_id IS NULL"
    ).get()?.cnt ?? 0;

    // Periodically evict stale entries from startTimeCache (spans that never ended)
    this.staleCleanupTimer = setInterval(() => this.evictStaleSpans(), STALE_CLEANUP_INTERVAL_MS);
    this.staleCleanupTimer.unref();
  }

  insertSpan(span: SpanData): void {
    this.startTimeCache.set(span.spanId, span.startTime);
    this.insertSpanStmt.run(
      span.spanId, span.traceId, span.parentSpanId, span.name, span.kind,
      span.status, span.statusMessage, span.startTime, span.endTime,
      span.durationMs, JSON.stringify(span.attributes), span.workerName,
    );
    this.broadcast({ type: "span.start", span });
    if (!span.parentSpanId) {
      this.rootSpanCount++;
      this.enforceTraceCap();
    }
  }

  endSpan(spanId: string, endTime: number, status: "ok" | "error", statusMessage?: string): void {
    const startTime = this.startTimeCache.get(spanId);
    if (startTime === undefined) return;

    const durationMs = endTime - startTime;
    this.endSpanStmt.run(endTime, durationMs, status, statusMessage ?? null, spanId);
    this.startTimeCache.delete(spanId);

    const span = this.rowToSpan(this.getSpanStmt.get(spanId));
    if (span) {
      this.broadcast({ type: "span.end", span });
    }
  }

  getSpanStatus(spanId: string): string | null {
    return this.db.prepare<{ status: string }, [string]>("SELECT status FROM spans WHERE span_id = ?").get(spanId)?.status ?? null;
  }

  setSpanStatus(spanId: string, status: "ok" | "error", statusMessage: string | null): void {
    this.db.prepare("UPDATE spans SET status = ?, status_message = ? WHERE span_id = ?").run(status, statusMessage, spanId);
  }

  updateAttributes(spanId: string, attrs: Record<string, unknown>): void {
    this.updateAttributesStmt.run(JSON.stringify(attrs), spanId);
  }

  addEvent(event: Omit<SpanEventData, "id">): void {
    this.insertEventStmt.run(
      event.spanId, event.traceId, event.timestamp,
      event.name, event.level, event.message, JSON.stringify(event.attributes),
    );
    const id = this.db.prepare<{ id: number }, []>("SELECT last_insert_rowid() as id").get()?.id;
    this.broadcast({ type: "span.event", event: { ...event, id } });
  }

  listTraces(opts: { limit?: number; cursor?: string }): { items: TraceSummary[]; cursor: string | null } {
    const limit = opts.limit ?? 50;
    const { time: cursorTime, id: cursorId } = parseCursor(opts.cursor);

    const rows = this.db.prepare<Record<string, unknown>, [number, number, string, number]>(`
      SELECT
        s.trace_id,
        s.name as root_span_name,
        s.worker_name,
        s.status,
        s.status_message,
        s.start_time,
        s.duration_ms,
        COUNT(c.span_id) as span_count,
        SUM(CASE WHEN c.status = 'error' THEN 1 ELSE 0 END) as error_count
      FROM spans s
      LEFT JOIN spans c ON c.trace_id = s.trace_id
      WHERE s.parent_span_id IS NULL AND (s.start_time < ? OR (s.start_time = ? AND s.trace_id < ?))
      GROUP BY s.trace_id
      ORDER BY s.start_time DESC, s.trace_id DESC
      LIMIT ?
    `).all(cursorTime, cursorTime, cursorId, limit + 1);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(r => ({
      traceId: r.trace_id as string,
      rootSpanName: r.root_span_name as string,
      workerName: r.worker_name as string | null,
      status: r.status as "ok" | "error" | "unset",
      statusMessage: r.status_message ? String(r.status_message).slice(0, 80) : null,
      startTime: r.start_time as number,
      durationMs: r.duration_ms as number | null,
      spanCount: r.span_count as number,
      errorCount: r.error_count as number,
    }));

    const last = items[items.length - 1];
    const cursor = hasMore && last ? buildCursor(last.startTime, last.traceId) : null;
    return { items, cursor };
  }

  getTrace(traceId: string): TraceDetail {
    const spanRows = this.db.prepare<Record<string, unknown>, [string]>(
      "SELECT * FROM spans WHERE trace_id = ? ORDER BY start_time ASC"
    ).all(traceId);

    const eventRows = this.db.prepare<Record<string, unknown>, [string]>(
      "SELECT * FROM span_events WHERE trace_id = ? ORDER BY timestamp ASC"
    ).all(traceId);

    return {
      spans: spanRows.map(r => this.rowToSpan(r)!),
      events: eventRows.map(r => ({
        id: r.id as number,
        spanId: r.span_id as string,
        traceId: r.trace_id as string,
        timestamp: r.timestamp as number,
        name: r.name as string,
        level: r.level as string | null,
        message: r.message as string | null,
        attributes: r.attributes ? JSON.parse(r.attributes as string) : {},
      })),
    };
  }

  getRecentTraces(since: number, limit: number): TraceSummary[] {
    const rows = this.db.prepare<Record<string, unknown>, [number, number]>(`
      SELECT
        s.trace_id,
        s.name as root_span_name,
        s.worker_name,
        s.status,
        s.status_message,
        s.start_time,
        s.duration_ms,
        COUNT(c.span_id) as span_count,
        SUM(CASE WHEN c.status = 'error' THEN 1 ELSE 0 END) as error_count
      FROM spans s
      LEFT JOIN spans c ON c.trace_id = s.trace_id
      WHERE s.parent_span_id IS NULL AND s.start_time >= ?
      GROUP BY s.trace_id
      ORDER BY s.start_time DESC
      LIMIT ?
    `).all(since, limit);

    return rows.map(r => ({
      traceId: r.trace_id as string,
      rootSpanName: r.root_span_name as string,
      workerName: r.worker_name as string | null,
      status: r.status as "ok" | "error" | "unset",
      statusMessage: r.status_message ? String(r.status_message).slice(0, 80) : null,
      startTime: r.start_time as number,
      durationMs: r.duration_ms as number | null,
      spanCount: r.span_count as number,
      errorCount: r.error_count as number,
    }));
  }

  searchTraces(query: string, limit: number = 50): { items: TraceSummary[]; cursor: string | null } {
    const like = `%${query}%`;
    const rows = this.db.prepare<Record<string, unknown>, [string, string, string, string, number]>(`
      SELECT DISTINCT
        s.trace_id,
        s.name as root_span_name,
        s.worker_name,
        s.status,
        s.status_message,
        s.start_time,
        s.duration_ms,
        (SELECT COUNT(*) FROM spans WHERE trace_id = s.trace_id) as span_count,
        (SELECT COUNT(*) FROM spans WHERE trace_id = s.trace_id AND status = 'error') as error_count
      FROM spans s
      LEFT JOIN span_events ev ON ev.trace_id = s.trace_id
      WHERE s.parent_span_id IS NULL
        AND (s.name LIKE ? OR s.attributes LIKE ? OR s.status_message LIKE ? OR ev.message LIKE ?)
      ORDER BY s.start_time DESC
      LIMIT ?
    `).all(like, like, like, like, limit);

    return {
      items: rows.map(r => ({
        traceId: r.trace_id as string,
        rootSpanName: r.root_span_name as string,
        workerName: r.worker_name as string | null,
        status: r.status as "ok" | "error" | "unset",
        statusMessage: r.status_message ? String(r.status_message).slice(0, 80) : null,
        startTime: r.start_time as number,
        durationMs: r.duration_ms as number | null,
        spanCount: r.span_count as number,
        errorCount: r.error_count as number,
      })),
      cursor: null,
    };
  }

  listAllSpans(opts: { limit?: number; cursor?: string }): { items: Array<{ spanId: string; traceId: string; name: string; status: string; durationMs: number | null; startTime: number; workerName: string | null }>; cursor: string | null } {
    const limit = opts.limit ?? 50;
    const { time: cursorTime, id: cursorId } = parseCursor(opts.cursor);

    const rows = this.db.prepare<Record<string, unknown>, [number, number, string, number]>(`
      SELECT span_id, trace_id, name, status, duration_ms, start_time, worker_name
      FROM spans
      WHERE start_time < ? OR (start_time = ? AND span_id < ?)
      ORDER BY start_time DESC, span_id DESC
      LIMIT ?
    `).all(cursorTime, cursorTime, cursorId, limit + 1);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(r => ({
      spanId: r.span_id as string,
      traceId: r.trace_id as string,
      name: r.name as string,
      status: r.status as string,
      durationMs: r.duration_ms as number | null,
      startTime: r.start_time as number,
      workerName: r.worker_name as string | null,
    }));

    const last = items[items.length - 1];
    const cursor = hasMore && last ? buildCursor(last.startTime, last.spanId) : null;
    return { items, cursor };
  }

  listAllLogs(opts: { limit?: number; cursor?: string }): { items: Array<{ id: number; spanId: string; traceId: string; timestamp: number; name: string; level: string | null; message: string | null }>; cursor: string | null } {
    const limit = opts.limit ?? 50;
    const cursorId = opts.cursor ? parseInt(opts.cursor, 10) : Number.MAX_SAFE_INTEGER;

    const rows = this.db.prepare<Record<string, unknown>, [number, number]>(`
      SELECT id, span_id, trace_id, timestamp, name, level, message
      FROM span_events
      WHERE id < ?
      ORDER BY id DESC
      LIMIT ?
    `).all(cursorId, limit + 1);

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(r => ({
      id: r.id as number,
      spanId: r.span_id as string,
      traceId: r.trace_id as string,
      timestamp: r.timestamp as number,
      name: r.name as string,
      level: r.level as string | null,
      message: r.message as string | null,
    }));

    const cursor = hasMore && items.length > 0 ? String(items[items.length - 1]!.id) : null;
    return { items, cursor };
  }

  clearTraces(): void {
    this.db.run("DELETE FROM span_events");
    this.db.run("DELETE FROM spans");
    this.rootSpanCount = 0;
    this.startTimeCache.clear();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private evictStaleSpans(): void {
    const cutoff = Date.now() - STALE_SPAN_TTL_MS;
    for (const [spanId, startTime] of this.startTimeCache) {
      if (startTime < cutoff) {
        this.startTimeCache.delete(spanId);
      }
    }
  }

  private broadcast(event: TraceEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  private enforceTraceCap(): void {
    if (this.rootSpanCount <= TRACE_CAP) return;

    const oldest = this.db.prepare<{ trace_id: string }, [number]>(
      "SELECT trace_id FROM spans WHERE parent_span_id IS NULL ORDER BY start_time ASC LIMIT ?"
    ).all(PRUNE_BATCH);

    if (oldest.length === 0) return;

    const ids = oldest.map(r => r.trace_id);
    const placeholders = ids.map(() => "?").join(",");

    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM span_events WHERE trace_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM spans WHERE trace_id IN (${placeholders})`).run(...ids);
    })();

    this.rootSpanCount -= oldest.length;
  }

  private rowToSpan(row: Record<string, unknown> | null): SpanData | null {
    if (!row) return null;
    return {
      spanId: row.span_id as string,
      traceId: row.trace_id as string,
      parentSpanId: row.parent_span_id as string | null,
      name: row.name as string,
      kind: row.kind as SpanData["kind"],
      status: row.status as SpanData["status"],
      statusMessage: row.status_message as string | null,
      startTime: row.start_time as number,
      endTime: row.end_time as number | null,
      durationMs: row.duration_ms as number | null,
      attributes: row.attributes ? JSON.parse(row.attributes as string) : {},
      workerName: row.worker_name as string | null,
    };
  }
}

function buildCursor(time: number, id: string): string {
  return `${time}:${id}`;
}

function parseCursor(cursor?: string): { time: number; id: string } {
  if (!cursor) return { time: Number.MAX_SAFE_INTEGER, id: "\uffff" };
  const sep = cursor.indexOf(":");
  if (sep === -1) {
    // Backwards-compatible: old numeric-only cursors
    return { time: parseInt(cursor, 10), id: "\uffff" };
  }
  return { time: parseInt(cursor.substring(0, sep), 10), id: cursor.substring(sep + 1) };
}

let defaultStore: TraceStore | null = null;

export function getTraceStore(): TraceStore {
  if (!defaultStore) {
    defaultStore = new TraceStore();
  }
  return defaultStore;
}
