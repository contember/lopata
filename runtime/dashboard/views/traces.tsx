import { useState, useEffect, useRef, useCallback, useMemo } from "preact/hooks";
import { useMutation } from "../rpc/hooks";
import type { TraceSummary, SpanData, SpanEventData, TraceEvent, TraceErrorSummary } from "../rpc/types";
import { rpc } from "../rpc/client";
import { TraceWaterfall, TraceStatusBadge, EventLevelBadge, formatDuration, formatTimestamp } from "./trace-waterfall";

// ─── Types ───────────────────────────────────────────────────────────

type WsStatus = "connecting" | "live" | "error" | "disconnected";

interface AttributeFilter {
  key: string;
  value: string;
  type: "include" | "exclude";
}

type ViewTab = "traces" | "spans" | "logs";

// ─── Event bus for raw WS events (used by drawer for live updates) ───

type EventListener = (events: TraceEvent[]) => void;
const eventListeners = new Set<EventListener>();
function onTraceEvents(fn: EventListener): () => void {
  eventListeners.add(fn);
  return () => { eventListeners.delete(fn); };
}
function emitTraceEvents(events: TraceEvent[]): void {
  for (const fn of eventListeners) {
    try { fn(events); } catch {}
  }
}

// ─── WebSocket hook ──────────────────────────────────────────────────

interface TraceFilter {
  path?: string;
  status?: string;
  attributeFilters?: AttributeFilter[];
  sinceMs?: number;
}

interface TraceStreamState {
  traces: Map<string, TraceSummary>;
  filter: TraceFilter;
  setFilter: (f: TraceFilter) => void;
  wsStatus: WsStatus;
}

function useTraceStream(): TraceStreamState {
  const [traces, setTraces] = useState<Map<string, TraceSummary>>(new Map());
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const filterRef = useRef<TraceFilter>({ sinceMs: 15 * 60 * 1000 });
  const closedRef = useRef(false);

  const connect = useCallback(() => {
    if (closedRef.current) return;
    setWsStatus("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/__dashboard/api/traces/ws`);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "initial") {
        const map = new Map<string, TraceSummary>();
        for (const t of msg.traces as TraceSummary[]) {
          map.set(t.traceId, t);
        }
        setTraces(map);
      } else if (msg.type === "batch") {
        const events = msg.events as TraceEvent[];
        emitTraceEvents(events);
        setTraces(prev => {
          const next = new Map(prev);
          for (const event of events) {
            if (event.type === "span.start" && event.span.parentSpanId === null) {
              const s = event.span;
              next.set(s.traceId, {
                traceId: s.traceId,
                rootSpanName: s.name,
                workerName: s.workerName,
                status: s.status,
                statusMessage: s.statusMessage,
                startTime: s.startTime,
                durationMs: s.durationMs,
                spanCount: 1,
                errorCount: 0,
              });
            } else if (event.type === "span.end" && event.span.parentSpanId === null) {
              const s = event.span;
              const existing = next.get(s.traceId);
              if (existing) {
                next.set(s.traceId, { ...existing, status: s.status, statusMessage: s.statusMessage, durationMs: s.durationMs });
              }
            } else if (event.type === "span.start" && event.span.parentSpanId !== null) {
              const s = event.span;
              const existing = next.get(s.traceId);
              if (existing) {
                next.set(s.traceId, {
                  ...existing,
                  spanCount: existing.spanCount + 1,
                  errorCount: existing.errorCount + (s.status === "error" ? 1 : 0),
                });
              }
            } else if (event.type === "span.end" && event.span.parentSpanId !== null) {
              const s = event.span;
              const existing = next.get(s.traceId);
              if (existing && s.status === "error") {
                next.set(s.traceId, { ...existing, errorCount: existing.errorCount + 1 });
              }
            }
          }
          return next;
        });
      }
    };

    ws.onerror = () => {
      setWsStatus("error");
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (!closedRef.current) {
        setWsStatus("disconnected");
        setTimeout(connect, 2000);
      } else {
        setWsStatus("disconnected");
      }
    };

    ws.onopen = () => {
      setWsStatus("live");
      const f = filterRef.current;
      // Always send filter on connect to sync time range with server
      ws.send(JSON.stringify({ type: "filter", ...f }));
    };
  }, []);

  useEffect(() => {
    closedRef.current = false;
    connect();
    return () => {
      closedRef.current = true;
      wsRef.current?.close();
    };
  }, [connect]);

  const setFilter = useCallback((f: TraceFilter) => {
    filterRef.current = f;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "filter", ...f }));
    }
  }, []);

  return { traces, filter: filterRef.current, setFilter, wsStatus };
}

// ─── Main View ───────────────────────────────────────────────────────

const TIME_RANGE_OPTIONS = [
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "15m", ms: 15 * 60 * 1000 },
  { label: "30m", ms: 30 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "All", ms: 0 },
];

export function TracesView() {
  const { traces, setFilter, wsStatus } = useTraceStream();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [pathFilter, setPathFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [timeRangeMs, setTimeRangeMs] = useState(15 * 60 * 1000);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<TraceSummary[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [attributeFilters, setAttributeFilters] = useState<AttributeFilter[]>([]);
  const [activeTab, setActiveTab] = useState<ViewTab>("traces");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTraces = useMutation("traces.clear");

  const buildFilter = (path: string, status: string, attrs: AttributeFilter[], sinceMs: number): TraceFilter => ({
    path: path || undefined,
    status: status === "all" ? undefined : status,
    attributeFilters: attrs,
    sinceMs: sinceMs || undefined,
  });

  const handleFilterChange = (path: string, status: string) => {
    setPathFilter(path);
    setStatusFilter(status);
    setFilter(buildFilter(path, status, attributeFilters, timeRangeMs));
  };

  const handleTimeRangeChange = (ms: number) => {
    setTimeRangeMs(ms);
    setFilter(buildFilter(pathFilter, statusFilter, attributeFilters, ms));
  };

  // Debounced search
  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!query.trim()) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    searchTimerRef.current = setTimeout(() => {
      rpc("traces.search", { query: query.trim(), limit: 50 }).then(data => {
        setSearchResults(data.items);
        setIsSearching(false);
      }).catch(() => setIsSearching(false));
    }, 300);
  };

  const addAttributeFilter = (key: string, value: string, type: "include" | "exclude") => {
    const next = [...attributeFilters, { key, value, type }];
    setAttributeFilters(next);
    setFilter(buildFilter(pathFilter, statusFilter, next, timeRangeMs));
  };

  const removeAttributeFilter = (index: number) => {
    const next = attributeFilters.filter((_, i) => i !== index);
    setAttributeFilters(next);
    setFilter(buildFilter(pathFilter, statusFilter, next, timeRangeMs));
  };

  const displayTraces = searchResults ?? Array.from(traces.values()).sort((a, b) => b.startTime - a.startTime);
  const maxDuration = useMemo(
    () => Math.max(...displayTraces.map(t => t.durationMs ?? 0), 1),
    [displayTraces],
  );

  return (
    <div class="p-8 h-full flex flex-col">
      <div class="flex items-center justify-between mb-6">
        <div class="flex items-center gap-3">
          <div>
            <h1 class="text-2xl font-bold text-ink">Traces</h1>
            <p class="text-sm text-gray-400 mt-1">{traces.size} trace(s)</p>
          </div>
          <ConnectionStatus status={wsStatus} />
        </div>
        <button
          onClick={() => { clearTraces.mutate(); setSelectedTraceId(null); }}
          class="rounded-md px-3 py-1.5 text-sm font-medium bg-white border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-all"
        >
          Clear all
        </button>
      </div>

      {/* Tabs */}
      <div class="flex border-b border-gray-200 mb-5">
        {(["traces", "spans", "logs"] as ViewTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            class={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? "border-ink text-ink"
                : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {activeTab === "traces" && (
        <>
          {/* Filters */}
          <div class="flex gap-3 mb-3 flex-wrap">
            <input
              type="text"
              placeholder="Search traces..."
              value={searchQuery}
              onInput={e => handleSearchChange((e.target as HTMLInputElement).value)}
              class="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all w-72"
            />
            <input
              type="text"
              placeholder="Filter by path (e.g. /api/*)"
              value={pathFilter}
              onInput={e => handleFilterChange((e.target as HTMLInputElement).value, statusFilter)}
              class="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all w-72"
            />
            <select
              value={statusFilter}
              onChange={e => handleFilterChange(pathFilter, (e.target as HTMLSelectElement).value)}
              class="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all"
            >
              <option value="all">All statuses</option>
              <option value="ok">OK</option>
              <option value="error">Error</option>
            </select>
            <div class="flex items-center bg-white border border-gray-200 rounded-lg overflow-hidden">
              {TIME_RANGE_OPTIONS.map(opt => (
                <button
                  key={opt.label}
                  onClick={() => handleTimeRangeChange(opt.ms)}
                  class={`px-2.5 py-2 text-xs font-medium transition-colors ${
                    timeRangeMs === opt.ms
                      ? "bg-gray-900 text-white"
                      : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Attribute filter pills */}
          {attributeFilters.length > 0 && (
            <div class="flex gap-2 mb-4 flex-wrap">
              {attributeFilters.map((f, i) => (
                <span
                  key={i}
                  class={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ${
                    f.type === "include" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
                  }`}
                >
                  {f.type === "include" ? "+" : "\u2212"} {f.key}={f.value}
                  <button
                    onClick={() => removeAttributeFilter(i)}
                    class="ml-1 hover:opacity-70"
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Trace list */}
          <div class="flex-1 overflow-y-auto scrollbar-thin">
            {isSearching ? (
              <div class="text-gray-400 font-medium text-center py-12">Searching...</div>
            ) : displayTraces.length === 0 ? (
              <div class="text-gray-400 font-medium text-center py-12">
                {searchQuery ? "No matching traces found." : "No traces yet. Make some requests to see them here."}
              </div>
            ) : (
              <div class="bg-white rounded-lg border border-gray-200 overflow-hidden">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-gray-100">
                      <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Status</th>
                      <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Name</th>
                      <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Worker</th>
                      <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium" style={{ minWidth: "140px" }}>Duration</th>
                      <th class="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">Spans</th>
                      <th class="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayTraces.map(trace => (
                      <tr
                        key={trace.traceId}
                        onClick={() => setSelectedTraceId(trace.traceId)}
                        class={`border-b border-gray-50 cursor-pointer transition-colors hover:bg-gray-50/50 ${
                          selectedTraceId === trace.traceId ? "bg-gray-50" : ""
                        }`}
                      >
                        <td class="px-4 py-2.5">
                          <TraceStatusBadge status={trace.status} />
                        </td>
                        <td class="px-4 py-2.5">
                          <span class="font-medium text-ink">{trace.rootSpanName}</span>
                          {trace.status === "error" && trace.statusMessage && (
                            <span class="ml-2 text-xs text-red-400">{trace.statusMessage}</span>
                          )}
                        </td>
                        <td class="px-4 py-2.5">
                          {trace.workerName && (
                            <span class="inline-flex px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-500">
                              {trace.workerName}
                            </span>
                          )}
                        </td>
                        <td class="px-4 py-2.5">
                          <DurationBar durationMs={trace.durationMs} maxDuration={maxDuration} />
                        </td>
                        <td class="px-4 py-2.5 text-right text-gray-500">
                          {trace.spanCount}
                          {trace.errorCount > 0 && (
                            <span class="ml-1 text-red-400">({trace.errorCount} err)</span>
                          )}
                        </td>
                        <td class="px-4 py-2.5 text-right font-mono text-xs text-gray-400">
                          {formatTimestamp(trace.startTime)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {activeTab === "spans" && <SpansListTab />}
      {activeTab === "logs" && <LogsListTab />}

      {/* Trace detail drawer */}
      {selectedTraceId && (
        <TraceDrawer
          traceId={selectedTraceId}
          onClose={() => setSelectedTraceId(null)}
          onAddAttributeFilter={addAttributeFilter}
        />
      )}
    </div>
  );
}

// ─── Spans List Tab ──────────────────────────────────────────────────

interface SpanRow {
  spanId: string;
  traceId: string;
  name: string;
  status: string;
  durationMs: number | null;
  startTime: number;
  workerName: string | null;
}

function SpansListTab() {
  const [spans, setSpans] = useState<SpanRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const loadSpans = (cur?: string) => {
    setIsLoading(true);
    rpc("traces.listSpans", { limit: 50, cursor: cur }).then(data => {
      if (cur) {
        setSpans(prev => [...prev, ...data.items]);
      } else {
        setSpans(data.items);
      }
      setCursor(data.cursor);
      setIsLoading(false);
    });
  };

  useEffect(() => { loadSpans(); }, []);

  return (
    <div class="flex-1 overflow-y-auto scrollbar-thin">
      {spans.length === 0 && !isLoading ? (
        <div class="text-gray-400 font-medium text-center py-12">No spans recorded yet.</div>
      ) : (
        <div class="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-100">
                <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Status</th>
                <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Name</th>
                <th class="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">Duration</th>
                <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Worker</th>
                <th class="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">Time</th>
                <th class="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">Trace</th>
              </tr>
            </thead>
            <tbody>
              {spans.map(span => (
                <tr key={span.spanId} class="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td class="px-4 py-2.5"><TraceStatusBadge status={span.status} /></td>
                  <td class="px-4 py-2.5 font-medium text-ink">{span.name}</td>
                  <td class="px-4 py-2.5 text-right font-mono text-xs text-gray-500">
                    {span.durationMs !== null ? formatDuration(span.durationMs) : "..."}
                  </td>
                  <td class="px-4 py-2.5">
                    {span.workerName && (
                      <span class="inline-flex px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-500">
                        {span.workerName}
                      </span>
                    )}
                  </td>
                  <td class="px-4 py-2.5 text-right font-mono text-xs text-gray-400">{formatTimestamp(span.startTime)}</td>
                  <td class="px-4 py-2.5 text-right">
                    <button
                      onClick={() => setSelectedTraceId(span.traceId)}
                      class="text-blue-500 hover:text-blue-700 text-xs font-mono"
                    >
                      {span.traceId.slice(0, 8)}...
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor && (
            <div class="p-4 text-center border-t border-gray-100">
              <button
                onClick={() => loadSpans(cursor)}
                disabled={isLoading}
                class="text-sm text-gray-500 hover:text-ink disabled:text-gray-300"
              >
                {isLoading ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
      {isLoading && spans.length === 0 && <div class="text-gray-400 text-sm text-center py-12">Loading spans...</div>}
      {selectedTraceId && (
        <TraceDrawer traceId={selectedTraceId} onClose={() => setSelectedTraceId(null)} onAddAttributeFilter={() => {}} />
      )}
    </div>
  );
}

// ─── Logs List Tab ───────────────────────────────────────────────────

interface LogRow {
  id: number;
  spanId: string;
  traceId: string;
  timestamp: number;
  name: string;
  level: string | null;
  message: string | null;
}

function LogsListTab() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadLogs = (cur?: string) => {
    setIsLoading(true);
    rpc("traces.listLogs", { limit: 50, cursor: cur }).then(data => {
      if (cur) {
        setLogs(prev => [...prev, ...data.items]);
      } else {
        setLogs(data.items);
      }
      setCursor(data.cursor);
      setIsLoading(false);
    });
  };

  useEffect(() => { loadLogs(); }, []);

  return (
    <div class="flex-1 overflow-y-auto scrollbar-thin">
      {logs.length === 0 && !isLoading ? (
        <div class="text-gray-400 font-medium text-center py-12">No log events recorded yet.</div>
      ) : (
        <div class="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-100">
                <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Level</th>
                <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Name</th>
                <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Message</th>
                <th class="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">Time</th>
                <th class="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">Span / Trace</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} class="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td class="px-4 py-2.5">
                    {log.level ? <EventLevelBadge level={log.level} /> : <span class="text-gray-300">-</span>}
                  </td>
                  <td class="px-4 py-2.5 font-medium text-ink">{log.name}</td>
                  <td class="px-4 py-2.5 text-gray-600 font-mono text-xs truncate max-w-[300px]">{log.message ?? ""}</td>
                  <td class="px-4 py-2.5 text-right font-mono text-xs text-gray-400">{formatTimestamp(log.timestamp)}</td>
                  <td class="px-4 py-2.5 text-right font-mono text-xs text-gray-400">
                    {log.traceId.slice(0, 8)}...
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor && (
            <div class="p-4 text-center border-t border-gray-100">
              <button
                onClick={() => loadLogs(cursor)}
                disabled={isLoading}
                class="text-sm text-gray-500 hover:text-ink disabled:text-gray-300"
              >
                {isLoading ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}
      {isLoading && logs.length === 0 && <div class="text-gray-400 text-sm text-center py-12">Loading logs...</div>}
    </div>
  );
}

// ─── Trace Detail Drawer ─────────────────────────────────────────────

const SOURCE_BADGE_COLORS: Record<string, string> = {
  fetch: "bg-blue-100 text-blue-700",
  scheduled: "bg-purple-100 text-purple-700",
  queue: "bg-orange-100 text-orange-700",
  alarm: "bg-yellow-100 text-yellow-700",
  workflow: "bg-emerald-100 text-emerald-700",
};

function TraceDrawer({ traceId, onClose, onAddAttributeFilter }: {
  traceId: string;
  onClose: () => void;
  onAddAttributeFilter: (key: string, value: string, type: "include" | "exclude") => void;
}) {
  const [spans, setSpans] = useState<SpanData[]>([]);
  const [events, setEvents] = useState<SpanEventData[]>([]);
  const [traceErrors, setTraceErrors] = useState<TraceErrorSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Initial load
  useEffect(() => {
    setIsLoading(true);
    rpc("traces.getTrace", { traceId }).then(data => {
      setSpans(data.spans);
      setEvents(data.events);
      setIsLoading(false);
    });
    rpc("traces.errors", { traceId }).then(setTraceErrors).catch(() => {});
  }, [traceId]);

  // Live updates via WS event bus
  useEffect(() => {
    return onTraceEvents((traceEvents) => {
      for (const ev of traceEvents) {
        if (ev.type === "span.start" && ev.span.traceId === traceId) {
          setSpans(prev => {
            if (prev.some(s => s.spanId === ev.span.spanId)) return prev;
            return [...prev, ev.span];
          });
        } else if (ev.type === "span.end" && ev.span.traceId === traceId) {
          setSpans(prev => prev.map(s => s.spanId === ev.span.spanId ? ev.span : s));
        } else if (ev.type === "span.event" && ev.event.traceId === traceId) {
          setEvents(prev => [...prev, ev.event as SpanEventData]);
        }
      }
    });
  }, [traceId]);

  return (
    <>
      {/* Backdrop */}
      <div
        class="fixed inset-0 bg-black/10 z-40"
        onClick={onClose}
      />
      {/* Drawer */}
      <div class="fixed right-0 top-0 bottom-0 w-[960px] max-w-[90vw] bg-white border-l border-gray-200 z-50 flex flex-col overflow-hidden animate-slide-in">
        {/* Header */}
        <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div>
            <div class="text-xs text-gray-400 font-mono">Trace {traceId.slice(0, 12)}...</div>
            <div class="text-sm font-medium text-ink mt-0.5">
              {spans.find(s => !s.parentSpanId)?.name ?? "Loading..."}
            </div>
          </div>
          <button onClick={onClose} class="w-7 h-7 flex items-center justify-center rounded-md hover:bg-gray-100 transition-colors text-gray-400 hover:text-ink">
            &times;
          </button>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto scrollbar-thin p-5">
          {isLoading ? (
            <div class="text-gray-400 text-sm">Loading trace...</div>
          ) : (
            <div>
              {/* Linked errors */}
              {traceErrors.length > 0 && (
                <div class="mb-4">
                  <div class="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Errors ({traceErrors.length})</div>
                  <div class="space-y-1">
                    {traceErrors.map(err => (
                      <a
                        key={err.id}
                        href={`#/errors/${err.id}`}
                        class="flex items-center gap-2 px-3 py-2 rounded-md bg-red-50 border border-red-100 text-xs no-underline hover:bg-red-100 transition-colors"
                      >
                        {err.source && (
                          <span class={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            SOURCE_BADGE_COLORS[err.source] ?? "bg-red-100 text-red-700"
                          }`}>
                            {err.source}
                          </span>
                        )}
                        <span class="font-medium text-red-700">{err.errorName}</span>
                        <span class="text-red-500 truncate">{err.errorMessage}</span>
                        <span class="text-red-400 font-mono ml-auto flex-shrink-0">{formatTimestamp(err.timestamp)}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <TraceWaterfall
                spans={spans}
                events={events}
                onAddAttributeFilter={onAddAttributeFilter}
              />
            </div>
          )}
        </div>
      </div>
      <style>{`
        @keyframes slide-in {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in {
          animation: slide-in 0.2s ease-out;
        }
      `}</style>
    </>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function ConnectionStatus({ status }: { status: WsStatus }) {
  const config: Record<WsStatus, { color: string; label: string }> = {
    live: { color: "bg-emerald-400", label: "Live" },
    connecting: { color: "bg-yellow-400 animate-pulse", label: "Connecting..." },
    error: { color: "bg-red-400", label: "Error" },
    disconnected: { color: "bg-gray-400", label: "Disconnected" },
  };
  const { color, label } = config[status];
  return (
    <div class="flex items-center gap-1.5 ml-3">
      <span class={`w-2 h-2 rounded-full ${color}`} />
      <span class="text-xs text-gray-500">{label}</span>
    </div>
  );
}

function DurationBar({ durationMs, maxDuration }: { durationMs: number | null; maxDuration: number }) {
  if (durationMs === null) {
    return <span class="text-xs text-gray-400 font-mono">...</span>;
  }
  const pct = Math.max((durationMs / maxDuration) * 100, 1);
  return (
    <div class="flex items-center gap-2">
      <div class="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div class="h-full bg-gray-400 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span class="text-xs text-gray-500 font-mono whitespace-nowrap w-14 text-right">{formatDuration(durationMs)}</span>
    </div>
  );
}

