import { useState, useEffect } from "preact/hooks";
import type { SpanData, SpanEventData } from "../rpc/types";

// ─── Types ───────────────────────────────────────────────────────────

export interface TraceWaterfallProps {
  spans: SpanData[];
  events: SpanEventData[];
  highlightSpanId?: string | null;
  onAddAttributeFilter?: (key: string, value: string, type: "include" | "exclude") => void;
}

// ─── Component ───────────────────────────────────────────────────────

export function TraceWaterfall({ spans, events, highlightSpanId, onAddAttributeFilter }: TraceWaterfallProps) {
  const [expandedSpan, setExpandedSpan] = useState<string | null>(null);
  const [collapsedSpans, setCollapsedSpans] = useState<Set<string>>(new Set());

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

  // Initialize collapsed state when spans change
  useEffect(() => {
    if (spans.length > 0) {
      setCollapsedSpans(getAutoExpanded());
      setExpandedSpan(null);
    }
  }, [spans]);

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
    <div>
      {/* Timeline header */}
      <div class="flex items-center justify-between mb-3">
        <span class="text-xs text-gray-400 font-mono">0ms</span>
        <span class="text-xs text-gray-400 font-mono">{formatDuration(traceDuration)}</span>
      </div>

      {/* Waterfall */}
      <div class="space-y-0.5">
        {flatSpans.map(({ span, depth }) => {
          const offset = ((span.startTime - traceStart) / traceDuration) * 100;
          const width = (((span.endTime ?? Date.now()) - span.startTime) / traceDuration) * 100;
          const spanEvents = events.filter(e => e.spanId === span.spanId);
          const isExpanded = expandedSpan === span.spanId;
          const hasChildren = (childMap.get(span.spanId) ?? []).length > 0;
          const isCollapsed = collapsedSpans.has(span.spanId);
          const parentAttrs = getParentAttributes(span);
          const isHighlighted = highlightSpanId === span.spanId;

          // Key attributes to show in the bar
          const keyAttrs = width > 5 ? getKeyAttributes(span.attributes, 2) : [];

          return (
            <div key={span.spanId}>
              <div
                class={`flex items-center cursor-pointer hover:bg-gray-50 rounded-md py-1 px-1 transition-colors ${
                  isHighlighted ? "ring-2 ring-red-400 ring-inset bg-red-50/50" : ""
                }`}
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
                <div class="flex-1 h-6 relative bg-gray-50 rounded">
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
                <div class="bg-gray-50 border border-gray-100 rounded-lg p-4 mt-1 mb-2" style={{ marginLeft: `${200 + depth * 16}px` }}>
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
                                  {/* Quick filter buttons — only when handler provided */}
                                  {onAddAttributeFilter && (
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
                                      >{"\u2212"}</button>
                                    </span>
                                  )}
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
                          <div key={ev.id} class={`py-1 px-2 rounded-md mb-1 ${ev.name === "exception" ? "bg-red-50" : "bg-white border border-gray-100"}`}>
                            <div class="flex items-center gap-2">
                              <span class="font-medium">{ev.name}</span>
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
  );
}

// ─── Smart Attribute Rendering ───────────────────────────────────────

const URL_REGEX = /^https?:\/\/[^\s]+$/;

export function AttributeValue({ value }: { value: unknown }) {
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
      <pre class="text-gray-800 bg-gray-50 border border-gray-100 p-1.5 rounded-md overflow-x-auto text-[11px] max-h-40">
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
        <pre class="text-gray-800 bg-gray-50 border border-gray-100 p-1.5 rounded-md overflow-x-auto text-[11px] max-h-40">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    } catch {}
  }
  // Multiline
  if (str.includes("\n")) {
    return <pre class="text-ink bg-gray-50 border border-gray-100 p-1.5 rounded-md overflow-x-auto text-[11px] max-h-40 whitespace-pre-wrap">{str}</pre>;
  }
  return <span class="text-ink">{str}</span>;
}

// ─── Shared Helpers ──────────────────────────────────────────────────

export function EventLevelBadge({ level }: { level: string }) {
  const upper = level.toUpperCase();
  const colors: Record<string, string> = {
    ERROR: "bg-red-50 text-red-700",
    WARN: "bg-orange-50 text-orange-700",
    WARNING: "bg-orange-50 text-orange-700",
    INFO: "bg-blue-50 text-blue-700",
    DEBUG: "bg-gray-50 text-gray-500",
  };
  return (
    <span class={`inline-flex px-1.5 py-0.5 rounded-md text-[10px] font-medium ${colors[upper] ?? "bg-gray-50 text-gray-500"}`}>
      {upper}
    </span>
  );
}

export function TraceStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ok: "bg-emerald-50 text-emerald-700",
    error: "bg-red-50 text-red-700",
    unset: "bg-gray-100 text-gray-500",
  };
  return (
    <span class={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${colors[status] ?? colors.unset} ${status === "unset" ? "animate-pulse" : ""}`}>
      {status === "unset" ? "running" : status}
    </span>
  );
}

export function getKeyAttributes(attrs: Record<string, unknown>, max: number): [string, unknown][] {
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

export function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}
