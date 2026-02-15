import { useState, useEffect, useRef, useCallback, useMemo } from "preact/hooks";
import { useMutation } from "../rpc/hooks";
import type { TraceSummary, SpanData, SpanEventData, TraceEvent } from "../rpc/types";
import { rpc } from "../rpc/client";

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

interface TraceStreamState {
  traces: Map<string, TraceSummary>;
  filter: { path?: string; status?: string; attributeFilters?: AttributeFilter[] };
  setFilter: (f: { path?: string; status?: string; attributeFilters?: AttributeFilter[] }) => void;
  wsStatus: WsStatus;
}

function useTraceStream(): TraceStreamState {
  const [traces, setTraces] = useState<Map<string, TraceSummary>>(new Map());
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const filterRef = useRef<{ path?: string; status?: string; attributeFilters?: AttributeFilter[] }>({});
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
      if (f.path || f.status || (f.attributeFilters && f.attributeFilters.length > 0)) {
        ws.send(JSON.stringify({ type: "filter", ...f }));
      }
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

  const setFilter = useCallback((f: { path?: string; status?: string; attributeFilters?: AttributeFilter[] }) => {
    filterRef.current = f;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "filter", ...f }));
    }
  }, []);

  return { traces, filter: filterRef.current, setFilter, wsStatus };
}

// ─── Main View ───────────────────────────────────────────────────────

export function TracesView() {
  const { traces, setFilter, wsStatus } = useTraceStream();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [pathFilter, setPathFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<TraceSummary[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [attributeFilters, setAttributeFilters] = useState<AttributeFilter[]>([]);
  const [activeTab, setActiveTab] = useState<ViewTab>("traces");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTraces = useMutation("traces.clear");

  const handleFilterChange = (path: string, status: string) => {
    setPathFilter(path);
    setStatusFilter(status);
    setFilter({ path: path || undefined, status: status === "all" ? undefined : status, attributeFilters });
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
    setFilter({ path: pathFilter || undefined, status: statusFilter === "all" ? undefined : statusFilter, attributeFilters: next });
  };

  const removeAttributeFilter = (index: number) => {
    const next = attributeFilters.filter((_, i) => i !== index);
    setAttributeFilters(next);
    setFilter({ path: pathFilter || undefined, status: statusFilter === "all" ? undefined : statusFilter, attributeFilters: next });
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
          class="rounded-full px-5 py-2 text-sm font-medium bg-surface-raised text-gray-500 hover:bg-red-50 hover:text-red-600 transition-all"
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
            class={`px-4 py-2 text-sm font-medium border-b-2 transition-all ${
              activeTab === tab
                ? "border-blue-500 text-blue-600"
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
              class="bg-surface-raised border-none rounded-2xl px-5 py-3 text-sm outline-none focus:bg-white focus:shadow-focus transition-all w-72"
            />
            <input
              type="text"
              placeholder="Filter by path (e.g. /api/*)"
              value={pathFilter}
              onInput={e => handleFilterChange((e.target as HTMLInputElement).value, statusFilter)}
              class="bg-surface-raised border-none rounded-2xl px-5 py-3 text-sm outline-none focus:bg-white focus:shadow-focus transition-all w-72"
            />
            <select
              value={statusFilter}
              onChange={e => handleFilterChange(pathFilter, (e.target as HTMLSelectElement).value)}
              class="bg-surface-raised border-none rounded-2xl px-5 py-3 text-sm outline-none focus:bg-white focus:shadow-focus transition-all"
            >
              <option value="all">All statuses</option>
              <option value="ok">OK</option>
              <option value="error">Error</option>
            </select>
          </div>

          {/* Attribute filter pills */}
          {attributeFilters.length > 0 && (
            <div class="flex gap-2 mb-4 flex-wrap">
              {attributeFilters.map((f, i) => (
                <span
                  key={i}
                  class={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium ${
                    f.type === "include" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                  }`}
                >
                  {f.type === "include" ? "+" : "−"} {f.key}={f.value}
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
              <div class="bg-white rounded-card shadow-card overflow-hidden">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-gray-100">
                      <th class="text-left px-5 py-3 text-xs text-gray-400 font-semibold">Status</th>
                      <th class="text-left px-5 py-3 text-xs text-gray-400 font-semibold">Name</th>
                      <th class="text-left px-5 py-3 text-xs text-gray-400 font-semibold">Worker</th>
                      <th class="text-left px-5 py-3 text-xs text-gray-400 font-semibold" style={{ minWidth: "140px" }}>Duration</th>
                      <th class="text-right px-5 py-3 text-xs text-gray-400 font-semibold">Spans</th>
                      <th class="text-right px-5 py-3 text-xs text-gray-400 font-semibold">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayTraces.map(trace => (
                      <tr
                        key={trace.traceId}
                        onClick={() => setSelectedTraceId(trace.traceId)}
                        class={`border-b border-gray-50 cursor-pointer transition-all hover:bg-surface-raised ${
                          selectedTraceId === trace.traceId ? "bg-accent-lime/10" : ""
                        }`}
                      >
                        <td class="px-5 py-3">
                          <TraceStatusBadge status={trace.status} />
                        </td>
                        <td class="px-5 py-3">
                          <span class="font-semibold text-ink">{trace.rootSpanName}</span>
                          {trace.status === "error" && trace.statusMessage && (
                            <span class="ml-2 text-xs text-red-400">{trace.statusMessage}</span>
                          )}
                        </td>
                        <td class="px-5 py-3">
                          {trace.workerName && (
                            <span class="inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium bg-surface-raised text-gray-500">
                              {trace.workerName}
                            </span>
                          )}
                        </td>
                        <td class="px-5 py-3">
                          <DurationBar durationMs={trace.durationMs} maxDuration={maxDuration} />
                        </td>
                        <td class="px-5 py-3 text-right text-gray-500">
                          {trace.spanCount}
                          {trace.errorCount > 0 && (
                            <span class="ml-1 text-red-400">({trace.errorCount} err)</span>
                          )}
                        </td>
                        <td class="px-5 py-3 text-right font-mono text-xs text-gray-400">
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
        <div class="bg-white rounded-card shadow-card overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-100">
                <th class="text-left px-5 py-3 text-xs text-gray-400 font-semibold">Status</th>
                <th class="text-left px-5 py-3 text-xs text-gray-400 font-semibold">Name</th>
                <th class="text-right px-5 py-3 text-xs text-gray-400 font-semibold">Duration</th>
                <th class="text-left px-5 py-3 text-xs text-gray-400 font-semibold">Worker</th>
                <th class="text-right px-5 py-3 text-xs text-gray-400 font-semibold">Time</th>
                <th class="text-right px-5 py-3 text-xs text-gray-400 font-semibold">Trace</th>
              </tr>
            </thead>
            <tbody>
              {spans.map(span => (
                <tr key={span.spanId} class="border-b border-gray-50 hover:bg-surface-raised transition-all">
                  <td class="px-5 py-3"><TraceStatusBadge status={span.status} /></td>
                  <td class="px-5 py-3 font-semibold text-ink">{span.name}</td>
                  <td class="px-5 py-3 text-right font-mono text-xs text-gray-500">
                    {span.durationMs !== null ? formatDuration(span.durationMs) : "..."}
                  </td>
                  <td class="px-5 py-3">
                    {span.workerName && (
                      <span class="inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium bg-surface-raised text-gray-500">
                        {span.workerName}
                      </span>
                    )}
                  </td>
                  <td class="px-5 py-3 text-right font-mono text-xs text-gray-400">{formatTimestamp(span.startTime)}</td>
                  <td class="px-5 py-3 text-right">
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
            <div class="p-4 text-center">
              <button
                onClick={() => loadSpans(cursor)}
                disabled={isLoading}
                class="text-sm text-blue-500 hover:text-blue-700 disabled:text-gray-300"
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
        <div class="bg-white rounded-card shadow-card overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-gray-100">
                <th class="text-left px-5 py-3 text-xs text-gray-400 font-semibold">Level</th>
                <th class="text-left px-5 py-3 text-xs text-gray-400 font-semibold">Name</th>
                <th class="text-left px-5 py-3 text-xs text-gray-400 font-semibold">Message</th>
                <th class="text-right px-5 py-3 text-xs text-gray-400 font-semibold">Time</th>
                <th class="text-right px-5 py-3 text-xs text-gray-400 font-semibold">Span / Trace</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} class="border-b border-gray-50 hover:bg-surface-raised transition-all">
                  <td class="px-5 py-3">
                    {log.level ? <EventLevelBadge level={log.level} /> : <span class="text-gray-300">-</span>}
                  </td>
                  <td class="px-5 py-3 font-semibold text-ink">{log.name}</td>
                  <td class="px-5 py-3 text-gray-600 font-mono text-xs truncate max-w-[300px]">{log.message ?? ""}</td>
                  <td class="px-5 py-3 text-right font-mono text-xs text-gray-400">{formatTimestamp(log.timestamp)}</td>
                  <td class="px-5 py-3 text-right font-mono text-xs text-gray-400">
                    {log.traceId.slice(0, 8)}...
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor && (
            <div class="p-4 text-center">
              <button
                onClick={() => loadLogs(cursor)}
                disabled={isLoading}
                class="text-sm text-blue-500 hover:text-blue-700 disabled:text-gray-300"
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

function TraceDrawer({ traceId, onClose, onAddAttributeFilter }: {
  traceId: string;
  onClose: () => void;
  onAddAttributeFilter: (key: string, value: string, type: "include" | "exclude") => void;
}) {
  const [spans, setSpans] = useState<SpanData[]>([]);
  const [events, setEvents] = useState<SpanEventData[]>([]);
  const [expandedSpan, setExpandedSpan] = useState<string | null>(null);
  const [collapsedSpans, setCollapsedSpans] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);

  // Initial load
  useEffect(() => {
    setIsLoading(true);
    setExpandedSpan(null);
    setCollapsedSpans(new Set());
    rpc("traces.getTrace", { traceId }).then(data => {
      setSpans(data.spans);
      setEvents(data.events);
      setIsLoading(false);
    });
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

  // Compute waterfall layout
  const traceStart = spans.length > 0 ? Math.min(...spans.map(s => s.startTime)) : 0;
  const traceEnd = spans.length > 0 ? Math.max(...spans.map(s => (s.endTime ?? Date.now()))) : 0;
  const traceDuration = traceEnd - traceStart || 1;

  // Build tree structure
  const spanMap = new Map(spans.map(s => [s.spanId, s]));
  const childMap = new Map<string | null, SpanData[]>();
  for (const s of spans) {
    const key = s.parentSpanId;
    if (!childMap.has(key)) childMap.set(key, []);
    childMap.get(key)!.push(s);
  }

  // Auto-expand: first 2 levels OR spans with >10% duration
  const getAutoExpanded = (): Set<string> => {
    const autoCollapsed = new Set<string>();
    function walk(parentId: string | null, depth: number) {
      const children = childMap.get(parentId) ?? [];
      for (const child of children) {
        const hasChildren = (childMap.get(child.spanId) ?? []).length > 0;
        if (hasChildren) {
          const spanDur = child.durationMs ?? 0;
          const significantDuration = spanDur > traceDuration * 0.1;
          if (depth >= 2 && !significantDuration) {
            autoCollapsed.add(child.spanId);
          }
        }
        walk(child.spanId, depth + 1);
      }
    }
    walk(null, 0);
    return autoCollapsed;
  };

  // Initialize collapsed state on load
  useEffect(() => {
    if (!isLoading && spans.length > 0) {
      setCollapsedSpans(getAutoExpanded());
    }
  }, [isLoading]);

  const toggleCollapse = (spanId: string) => {
    setCollapsedSpans(prev => {
      const next = new Set(prev);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  };

  function flattenTree(parentId: string | null, depth: number): Array<{ span: SpanData; depth: number }> {
    const children = childMap.get(parentId) ?? [];
    const result: Array<{ span: SpanData; depth: number }> = [];
    for (const child of children) {
      result.push({ span: child, depth });
      if (!collapsedSpans.has(child.spanId)) {
        result.push(...flattenTree(child.spanId, depth + 1));
      }
    }
    return result;
  }

  const flatSpans = flattenTree(null, 0);

  // Get parent span attributes for filtering inherited attrs
  const getParentAttributes = (span: SpanData): Record<string, unknown> => {
    if (!span.parentSpanId) return {};
    const parent = spanMap.get(span.parentSpanId);
    return parent?.attributes ?? {};
  };

  return (
    <>
      {/* Backdrop */}
      <div
        class="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />
      {/* Drawer */}
      <div class="fixed right-0 top-0 bottom-0 w-[720px] max-w-[90vw] bg-white shadow-2xl z-50 flex flex-col overflow-hidden animate-slide-in">
        {/* Header */}
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <div class="text-xs text-gray-400 font-mono">Trace {traceId.slice(0, 12)}...</div>
            <div class="text-sm font-semibold text-ink mt-0.5">
              {spans.find(s => !s.parentSpanId)?.name ?? "Loading..."}
            </div>
          </div>
          <button onClick={onClose} class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-raised transition-all text-gray-400 hover:text-ink">
            &times;
          </button>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto scrollbar-thin p-6">
          {isLoading ? (
            <div class="text-gray-400 text-sm">Loading trace...</div>
          ) : (
            <div>
              {/* Timeline header */}
              <div class="flex items-center justify-between mb-4">
                <span class="text-xs text-gray-400 font-mono">0ms</span>
                <span class="text-xs text-gray-400 font-mono">{formatDuration(traceDuration)}</span>
              </div>

              {/* Waterfall */}
              <div class="space-y-1">
                {flatSpans.map(({ span, depth }) => {
                  const offset = ((span.startTime - traceStart) / traceDuration) * 100;
                  const width = (((span.endTime ?? Date.now()) - span.startTime) / traceDuration) * 100;
                  const spanEvents = events.filter(e => e.spanId === span.spanId);
                  const isExpanded = expandedSpan === span.spanId;
                  const hasChildren = (childMap.get(span.spanId) ?? []).length > 0;
                  const isCollapsed = collapsedSpans.has(span.spanId);
                  const parentAttrs = getParentAttributes(span);

                  // Key attributes to show in the bar (feature 6)
                  const keyAttrs = width > 5 ? getKeyAttributes(span.attributes, 2) : [];

                  return (
                    <div key={span.spanId}>
                      <div
                        class="flex items-center cursor-pointer hover:bg-surface-raised rounded-lg py-1 px-1 transition-all"
                        onClick={() => setExpandedSpan(isExpanded ? null : span.spanId)}
                      >
                        {/* Span name with collapse toggle */}
                        <div class="w-[200px] flex-shrink-0 truncate text-xs text-ink flex items-center" style={{ paddingLeft: `${depth * 16}px` }}>
                          {hasChildren && (
                            <span
                              class="inline-block w-4 text-gray-400 cursor-pointer select-none flex-shrink-0"
                              onClick={(e) => { e.stopPropagation(); toggleCollapse(span.spanId); }}
                            >
                              {isCollapsed ? "\u25B6" : "\u25BC"}
                            </span>
                          )}
                          {!hasChildren && <span class="inline-block w-4 flex-shrink-0" />}
                          <span class="truncate">{span.name}</span>
                        </div>
                        {/* Bar area */}
                        <div class="flex-1 h-6 relative bg-surface-raised rounded">
                          <div
                            class={`absolute top-0.5 bottom-0.5 rounded flex items-center overflow-hidden ${
                              span.status === "error" ? "bg-red-400" :
                              span.status === "ok" ? "bg-emerald-400" :
                              "bg-gray-300 animate-pulse"
                            }`}
                            style={{ left: `${offset}%`, width: `${Math.max(width, 0.5)}%` }}
                          >
                            {/* Key attributes inside bar */}
                            {keyAttrs.length > 0 && (
                              <span class="text-[9px] text-white/80 px-1 truncate whitespace-nowrap">
                                {keyAttrs.map(([k, v]) => `${k}=${String(v)}`).join(" ")}
                              </span>
                            )}
                            {/* Event markers */}
                            {spanEvents.map(ev => {
                              const evOffset = ((ev.timestamp - span.startTime) / ((span.endTime ?? Date.now()) - span.startTime || 1)) * 100;
                              return (
                                <div
                                  key={ev.id}
                                  class={`absolute top-0 w-1.5 h-full rounded-full ${ev.name === "exception" ? "bg-red-600" : "bg-gray-500"}`}
                                  style={{ left: `${Math.min(evOffset, 100)}%` }}
                                  title={ev.message ?? ev.name}
                                />
                              );
                            })}
                          </div>
                          {/* Duration label */}
                          <span
                            class="absolute top-0.5 text-[10px] text-gray-500 whitespace-nowrap"
                            style={{ left: `${offset + width + 1}%` }}
                          >
                            {span.durationMs !== null ? formatDuration(span.durationMs) : "..."}
                          </span>
                        </div>
                      </div>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div class="bg-surface-raised rounded-lg p-4 mt-1 mb-2" style={{ marginLeft: `${200 + depth * 16}px` }}>
                          <div class="text-xs space-y-2">
                            {/* Timing section */}
                            <div class="grid grid-cols-2 gap-x-4 gap-y-1">
                              <div><span class="text-gray-400">Kind:</span> <span class="text-ink">{span.kind}</span></div>
                              <div><span class="text-gray-400">Status:</span> <TraceStatusBadge status={span.status} /></div>
                              <div><span class="text-gray-400">Start:</span> <span class="text-ink font-mono">{formatTimestamp(span.startTime)}</span></div>
                              <div><span class="text-gray-400">End:</span> <span class="text-ink font-mono">{span.endTime ? formatTimestamp(span.endTime) : "..."}</span></div>
                              <div><span class="text-gray-400">Duration:</span> <span class="text-ink font-mono">{span.durationMs !== null ? formatDuration(span.durationMs) : "..."}</span></div>
                              <div><span class="text-gray-400">Trace ID:</span> <span class="text-ink font-mono">{span.traceId.slice(0, 16)}...</span></div>
                              {span.parentSpanId && (
                                <div><span class="text-gray-400">Parent:</span> <span class="text-ink font-mono">{span.parentSpanId.slice(0, 16)}...</span></div>
                              )}
                            </div>
                            {span.statusMessage && (
                              <div>
                                <span class="text-gray-400">Error:</span>
                                <span class="ml-2 text-red-500">{span.statusMessage}</span>
                              </div>
                            )}
                            {/* Attributes (filtered: inherited removed) */}
                            {Object.keys(span.attributes).length > 0 && (
                              <div>
                                <div class="text-gray-400 mb-1">Attributes:</div>
                                <table class="w-full">
                                  <tbody>
                                    {Object.entries(span.attributes)
                                      .filter(([k, v]) => {
                                        const parentVal = parentAttrs[k];
                                        return parentVal === undefined || JSON.stringify(parentVal) !== JSON.stringify(v);
                                      })
                                      .map(([k, v]) => (
                                      <tr key={k} class="group">
                                        <td class="py-0.5 pr-3 text-gray-400 font-mono align-top whitespace-nowrap">
                                          {k}
                                          {/* Quick filter buttons */}
                                          <span class="invisible group-hover:visible ml-1">
                                            <button
                                              onClick={(e) => { e.stopPropagation(); onAddAttributeFilter(k, String(v), "include"); }}
                                              class="text-emerald-500 hover:text-emerald-700 px-0.5"
                                              title="Include filter"
                                            >+</button>
                                            <button
                                              onClick={(e) => { e.stopPropagation(); onAddAttributeFilter(k, String(v), "exclude"); }}
                                              class="text-red-500 hover:text-red-700 px-0.5"
                                              title="Exclude filter"
                                            >−</button>
                                          </span>
                                        </td>
                                        <td class="py-0.5 font-mono break-all"><AttributeValue value={v} /></td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                            {/* Events */}
                            {spanEvents.length > 0 && (
                              <div>
                                <div class="text-gray-400 mb-1">Events:</div>
                                {spanEvents.map(ev => (
                                  <div key={ev.id} class={`py-1 px-2 rounded mb-1 ${ev.name === "exception" ? "bg-red-50" : "bg-gray-50"}`}>
                                    <div class="flex items-center gap-2">
                                      <span class="font-semibold">{ev.name}</span>
                                      {ev.level && <EventLevelBadge level={ev.level} />}
                                      <span class="text-gray-400 font-mono ml-auto">
                                        +{Math.round(ev.timestamp - span.startTime)}ms
                                      </span>
                                    </div>
                                    {ev.message && <div class="text-gray-600 mt-0.5 font-mono break-all">{ev.message}</div>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
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

// ─── Smart Attribute Rendering ───────────────────────────────────────

const URL_REGEX = /^https?:\/\/[^\s]+$/;

function AttributeValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span class="text-gray-400 italic">null</span>;
  }
  if (typeof value === "boolean") {
    return <span class="text-orange-600">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span class="text-purple-600">{value}</span>;
  }
  if (typeof value === "object") {
    return (
      <pre class="text-gray-800 bg-gray-100 p-1.5 rounded overflow-x-auto text-[11px] max-h-40">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  const str = String(value);
  if (URL_REGEX.test(str)) {
    return <a href={str} target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline break-all">{str}</a>;
  }
  // Try JSON
  if ((str.startsWith("{") || str.startsWith("[")) && str.length > 2) {
    try {
      const parsed = JSON.parse(str);
      return (
        <pre class="text-gray-800 bg-gray-100 p-1.5 rounded overflow-x-auto text-[11px] max-h-40">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    } catch {}
  }
  // Multiline
  if (str.includes("\n")) {
    return <pre class="text-ink bg-gray-100 p-1.5 rounded overflow-x-auto text-[11px] max-h-40 whitespace-pre-wrap">{str}</pre>;
  }
  return <span class="text-ink">{str}</span>;
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
        <div class="h-full bg-blue-400 rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span class="text-xs text-gray-500 font-mono whitespace-nowrap w-14 text-right">{formatDuration(durationMs)}</span>
    </div>
  );
}

function EventLevelBadge({ level }: { level: string }) {
  const upper = level.toUpperCase();
  const colors: Record<string, string> = {
    ERROR: "bg-red-100 text-red-700",
    WARN: "bg-orange-100 text-orange-700",
    WARNING: "bg-orange-100 text-orange-700",
    INFO: "bg-blue-100 text-blue-700",
    DEBUG: "bg-gray-100 text-gray-500",
  };
  return (
    <span class={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ${colors[upper] ?? "bg-gray-100 text-gray-500"}`}>
      {upper}
    </span>
  );
}

function TraceStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ok: "bg-emerald-100 text-emerald-700",
    error: "bg-red-100 text-red-700",
    unset: "bg-gray-100 text-gray-500",
  };
  return (
    <span class={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${colors[status] ?? colors.unset} ${status === "unset" ? "animate-pulse" : ""}`}>
      {status === "unset" ? "running" : status}
    </span>
  );
}

function getKeyAttributes(attrs: Record<string, unknown>, max: number): [string, unknown][] {
  const priorityKeys = ["http.method", "http.status_code", "http.url", "http.route", "db.system", "db.operation", "rpc.method"];
  const entries = Object.entries(attrs);
  const result: [string, unknown][] = [];
  for (const key of priorityKeys) {
    if (result.length >= max) break;
    const entry = entries.find(([k]) => k === key);
    if (entry) result.push(entry);
  }
  if (result.length < max) {
    for (const entry of entries) {
      if (result.length >= max) break;
      if (!result.some(([k]) => k === entry[0]) && typeof entry[1] !== "object") {
        result.push(entry);
      }
    }
  }
  return result;
}

function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}
