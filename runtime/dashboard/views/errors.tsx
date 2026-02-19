import { useState, useEffect } from "preact/hooks";
import { useMutation } from "../rpc/hooks";
import type { ErrorSummary, ErrorDetail, SpanData } from "../rpc/types";
import { rpc } from "../rpc/client";
import { navigate } from "../lib";
import { formatDuration } from "./trace-waterfall";
import { KeyValueTable } from "../components/key-value-table";

export function ErrorsView({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  // /errors → list, /errors/{id} → detail
  if (parts.length >= 2) return <ErrorDetailPage errorId={decodeURIComponent(parts[1]!)} />;
  return <ErrorList />;
}

// ─── Error List ──────────────────────────────────────────────────────

function ErrorList() {
  const [errors, setErrors] = useState<ErrorSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const clearErrors = useMutation("errors.clear");

  const loadErrors = (cur?: string) => {
    setIsLoading(true);
    rpc("errors.list", { limit: 50, cursor: cur }).then(data => {
      if (cur) {
        setErrors(prev => [...prev, ...data.items]);
      } else {
        setErrors(data.items);
      }
      setCursor(data.cursor);
      setIsLoading(false);
    });
  };

  useEffect(() => { loadErrors(); }, []);

  const handleClear = () => {
    clearErrors.mutate().then(() => {
      setErrors([]);
      setCursor(null);
    });
  };

  const handleDelete = (id: string, e: Event) => {
    e.stopPropagation();
    rpc("errors.delete", { id }).then(() => {
      setErrors(prev => prev.filter(err => err.id !== id));
    });
  };

  return (
    <div class="p-8 h-full flex flex-col">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-ink">Errors</h1>
          <p class="text-sm text-text-muted mt-1">{errors.length} error(s)</p>
        </div>
        {errors.length > 0 && (
          <button
            onClick={handleClear}
            class="rounded-md px-3 py-1.5 text-sm font-medium bg-panel border border-border text-text-secondary hover:bg-red-950/30 hover:text-red-400 hover:border-red-800 transition-all"
          >
            Clear all
          </button>
        )}
      </div>

      <div class="flex-1 overflow-y-auto scrollbar-thin">
        {errors.length === 0 && !isLoading ? (
          <div class="text-text-muted font-medium text-center py-12">No errors recorded yet.</div>
        ) : (
          <div class="bg-panel rounded-lg border border-border overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border-subtle">
                  <th class="text-left px-4 py-2.5 text-xs text-text-muted font-medium">Source</th>
                  <th class="text-left px-4 py-2.5 text-xs text-text-muted font-medium">Error</th>
                  <th class="text-left px-4 py-2.5 text-xs text-text-muted font-medium">Message</th>
                  <th class="text-left px-4 py-2.5 text-xs text-text-muted font-medium">Context</th>
                  <th class="text-left px-4 py-2.5 text-xs text-text-muted font-medium">Worker</th>
                  <th class="text-right px-4 py-2.5 text-xs text-text-muted font-medium">Trace</th>
                  <th class="text-right px-4 py-2.5 text-xs text-text-muted font-medium">Time</th>
                  <th class="text-right px-4 py-2.5 text-xs text-text-muted font-medium w-10"></th>
                </tr>
              </thead>
              <tbody>
                {errors.map(err => (
                  <tr
                    key={err.id}
                    onClick={() => navigate(`/errors/${err.id}`)}
                    class="border-b border-border-row cursor-pointer transition-colors hover:bg-panel-hover/50"
                  >
                    <td class="px-4 py-2.5">
                      <SourceBadge source={err.source} />
                    </td>
                    <td class="px-4 py-2.5 font-medium text-ink">{err.errorName}</td>
                    <td class="px-4 py-2.5 text-text-data truncate max-w-[250px]">{err.errorMessage}</td>
                    <td class="px-4 py-2.5 text-text-secondary font-mono text-xs">
                      {err.requestMethod && err.requestUrl ? (
                        <span>
                          <span class="font-medium">{err.requestMethod}</span>{" "}
                          {truncateUrl(err.requestUrl)}
                        </span>
                      ) : (
                        <span class="text-text-dim">-</span>
                      )}
                    </td>
                    <td class="px-4 py-2.5">
                      {err.workerName && (
                        <span class="inline-flex px-2 py-0.5 rounded-md text-xs font-medium bg-panel-hover text-text-secondary">
                          {err.workerName}
                        </span>
                      )}
                    </td>
                    <td class="px-4 py-2.5 text-right">
                      {err.traceId ? (
                        <a
                          href={`#/traces?trace=${err.traceId}`}
                          onClick={(e) => e.stopPropagation()}
                          class="text-blue-500 hover:text-blue-700 text-xs font-mono"
                        >
                          {err.traceId.slice(0, 8)}...
                        </a>
                      ) : (
                        <span class="text-text-dim text-xs">-</span>
                      )}
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs text-text-muted">
                      {formatTimestamp(err.timestamp)}
                    </td>
                    <td class="px-4 py-2.5 text-right">
                      <button
                        onClick={(e) => handleDelete(err.id, e)}
                        class="text-text-dim hover:text-red-500 transition-colors"
                        title="Delete error"
                      >
                        &times;
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cursor && (
              <div class="p-4 text-center border-t border-border-subtle">
                <button
                  onClick={() => loadErrors(cursor)}
                  disabled={isLoading}
                  class="text-sm text-text-secondary hover:text-ink disabled:text-text-dim"
                >
                  {isLoading ? "Loading..." : "Load more"}
                </button>
              </div>
            )}
          </div>
        )}
        {isLoading && errors.length === 0 && (
          <div class="text-text-muted text-sm text-center py-12">Loading errors...</div>
        )}
      </div>
    </div>
  );
}

// ─── Error Detail Page ───────────────────────────────────────────────

function ErrorDetailPage({ errorId }: { errorId: string }) {
  const [detail, setDetail] = useState<ErrorDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [traceSpans, setTraceSpans] = useState<SpanData[] | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setTraceSpans(null);
    rpc("errors.get", { id: errorId }).then(data => {
      const d = data as ErrorDetail;
      setDetail(d);
      setIsLoading(false);
      if (d.traceId) {
        rpc("traces.getTrace", { traceId: d.traceId }).then(trace => {
          setTraceSpans(trace.spans);
        }).catch(() => {});
      }
    }).catch(() => setIsLoading(false));
  }, [errorId]);

  const handleDelete = () => {
    rpc("errors.delete", { id: errorId }).then(() => {
      navigate("/errors");
    });
  };

  if (isLoading) {
    return <div class="p-8 text-text-muted text-sm">Loading error details...</div>;
  }

  if (!detail) {
    return <div class="p-8 text-text-muted text-sm">Error not found.</div>;
  }

  const { data } = detail;

  return (
    <div class="p-6 max-w-6xl flex flex-col gap-4">
      {/* Breadcrumb + actions */}
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 text-sm text-text-muted">
          <a href="#/errors" class="text-text-secondary hover:text-ink no-underline font-medium transition-colors">Errors</a>
          <span class="text-text-dim">/</span>
          <span class="text-ink font-semibold">{errorId.slice(0, 12)}...</span>
        </div>
        <button
          onClick={handleDelete}
          class="rounded-md px-3 py-1.5 text-sm font-medium bg-panel border border-border text-text-secondary hover:bg-red-950/30 hover:text-red-400 hover:border-red-800 transition-all"
        >
          Delete
        </button>
      </div>

      {/* Error header */}
      <div class="bg-panel rounded-lg border border-border overflow-hidden border-l-4 border-l-red-500">
        <div class="px-5 py-4">
          <div class="flex items-center gap-2.5 mb-1.5">
            <span class="w-6 h-6 rounded-md bg-red-950/40 flex items-center justify-center text-red-400 text-xs font-bold">!</span>
            <span class="text-xs font-semibold uppercase tracking-wider text-red-500">{data.error.name}</span>
            {detail.source && <SourceBadge source={detail.source} />}
          </div>
          <CollapsibleMessage message={data.error.message} />
        </div>
      </div>

      {/* Source Code */}
      {data.error.frames.length > 0 && (
        <Section title="Source Code" open>
          <FrameList frames={data.error.frames} />
        </Section>
      )}

      {/* Stack Trace */}
      <Section title="Stack Trace">
        <div class="px-4 py-3 overflow-x-auto scrollbar-thin">
          <pre class="text-xs text-text-secondary leading-5 m-0 whitespace-pre-wrap break-words font-mono">
            {data.error.stack}
          </pre>
        </div>
      </Section>

      {/* Trace */}
      {traceSpans && traceSpans.length > 0 && (
        <Section title="Trace" open>
          <SimpleTraceWaterfall spans={traceSpans} highlightSpanId={detail.spanId} />
        </Section>
      )}

      {/* Request */}
      {data.request.method && data.request.url && (
        <Section title="Request" open>
          <div class="px-4 py-2.5 border-b border-border-subtle">
            <span class="inline-block px-2 py-0.5 rounded-md bg-panel-hover text-xs font-bold mr-2">{data.request.method}</span>
            <span class="text-sm break-all font-mono">{data.request.url}</span>
          </div>
          <KeyValueTable data={data.request.headers} />
        </Section>
      )}

      {/* Environment */}
      {Object.keys(data.env).length > 0 && (
        <Section title="Environment">
          <KeyValueTable data={data.env} />
        </Section>
      )}

      {/* Bindings */}
      {data.bindings.length > 0 && (
        <Section title="Bindings">
          {data.bindings.length === 0 ? (
            <div class="px-4 py-3 text-sm text-text-muted">No bindings configured</div>
          ) : (
            <table class="w-full text-sm">
              <tbody>
                {data.bindings.map((b) => (
                  <tr key={b.name} class="border-b border-border-subtle last:border-0 hover:bg-panel-hover/50 transition-colors">
                    <td class="px-4 py-2 font-medium text-text-secondary whitespace-nowrap font-mono">
                      {b.name}
                    </td>
                    <td class="px-4 py-2">
                      <span class="inline-block px-2 py-0.5 rounded-md bg-panel-hover text-xs font-medium text-text-data">{b.type}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {/* Runtime */}
      <Section title="Runtime">
        <KeyValueTable
          data={{
            "Bun": data.runtime.bunVersion,
            "Platform": `${data.runtime.platform} / ${data.runtime.arch}`,
            ...(data.runtime.workerName ? { "Worker": data.runtime.workerName } : {}),
            ...(data.runtime.configName ? { "Config": data.runtime.configName } : {}),
          }}
        />
      </Section>
    </div>
  );
}

// ─── Simplified Trace Waterfall (matches standalone error page) ──────

function SimpleTraceWaterfall({ spans, highlightSpanId }: { spans: SpanData[]; highlightSpanId: string | null }) {
  if (spans.length === 0) return null;

  const traceStart = Math.min(...spans.map(s => s.startTime));
  const traceEnd = Math.max(...spans.map(s => s.endTime ?? Date.now()));
  const traceDuration = traceEnd - traceStart || 1;

  const childMap = new Map<string | null, SpanData[]>();
  for (const s of spans) {
    const key = s.parentSpanId;
    if (!childMap.has(key)) childMap.set(key, []);
    childMap.get(key)!.push(s);
  }

  function flatten(parentId: string | null, depth: number): Array<{ span: SpanData; depth: number }> {
    const children = childMap.get(parentId) ?? [];
    const result: Array<{ span: SpanData; depth: number }> = [];
    for (const child of children) {
      result.push({ span: child, depth });
      result.push(...flatten(child.spanId, depth + 1));
    }
    return result;
  }

  const flatSpans = flatten(null, 0);

  return (
    <div class="px-4 py-3">
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs text-text-muted font-mono">0ms</span>
        <span class="text-xs text-text-muted font-mono">{formatDuration(traceDuration)}</span>
      </div>
      <div class="space-y-0.5">
        {flatSpans.map(({ span, depth }) => {
          const offset = ((span.startTime - traceStart) / traceDuration) * 100;
          const width = (((span.endTime ?? Date.now()) - span.startTime) / traceDuration) * 100;
          const isHighlighted = highlightSpanId === span.spanId;

          return (
            <div
              key={span.spanId}
              class={`flex items-center py-1 px-1 rounded-md ${isHighlighted ? "bg-red-950/40 ring-1 ring-red-700" : ""}`}
            >
              <div
                class="w-[180px] flex-shrink-0 truncate text-xs text-ink font-mono"
                style={{ paddingLeft: `${depth * 14}px` }}
              >
                {span.name}
              </div>
              <div class="flex-1 h-5 relative bg-panel-secondary rounded">
                <div
                  class={`absolute top-0.5 bottom-0.5 rounded ${
                    span.status === "error" ? "bg-red-500" :
                    span.status === "ok" ? "bg-emerald-700" :
                    "bg-gray-300"
                  }`}
                  style={{ left: `${offset}%`, width: `${Math.max(width, 0.5)}%` }}
                />
                <span
                  class="absolute top-0.5 text-[10px] text-text-secondary whitespace-nowrap font-mono"
                  style={{ left: `${offset + width + 1}%` }}
                >
                  {span.durationMs != null ? formatDuration(span.durationMs) : "..."}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Shared Components (matching standalone error page style) ────────

function Section({ title, open, children }: { title: string; open?: boolean; children: any }) {
  return (
    <details open={open} class="bg-panel rounded-lg border border-border overflow-hidden">
      <summary class="px-5 py-3 cursor-pointer select-none text-sm font-semibold text-ink hover:bg-panel-hover transition-colors">
        {title}
      </summary>
      <div class="border-t border-border-subtle">
        {children}
      </div>
    </details>
  );
}

type FrameData = ErrorDetail["data"]["error"]["frames"][0];

const LIBRARY_PATH_RE = /\/node_modules\//;

function isLibraryFrame(frame: FrameData): boolean {
  return LIBRARY_PATH_RE.test(frame.file);
}

const HL_RE = /(\/\/.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|(\b(?:const|let|var|function|return|if|else|for|while|do|class|new|import|export|from|default|async|await|throw|try|catch|finally|switch|case|break|continue|typeof|instanceof|in|of|yield|static|extends|super|void|delete|enum|interface|type|as|declare|readonly)\b)|(\b(?:true|false|null|undefined|this|NaN|Infinity)\b)/g;

function highlightLine(line: string) {
  const parts: preact.ComponentChildren[] = [];
  let last = 0;
  for (const m of line.matchAll(HL_RE)) {
    if (m.index! > last) parts.push(line.slice(last, m.index));
    const t = m[0];
    const c = m[1] ? "#6b7280" : m[2] ? "#16a34a" : m[3] ? "#d97706" : m[4] ? "#7c3aed" : m[5] ? "#2563eb" : undefined;
    parts.push(c ? <span style={{ color: c }}>{t}</span> : t);
    last = m.index! + t.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts.length > 0 ? parts : line;
}

function FrameList({ frames }: { frames: FrameData[] }) {
  return (
    <div class="divide-y divide-border-subtle">
      {frames.map((frame, i) => (
        <CodeBlock key={i} frame={frame} defaultOpen={!isLibraryFrame(frame)} />
      ))}
    </div>
  );
}

function CodeBlock({ frame, defaultOpen }: { frame: FrameData; defaultOpen: boolean }) {
  if (!frame.source || frame.source.length === 0) return null;
  const startLine = frame.line - (frame.sourceLine ?? 0);

  return (
    <details open={defaultOpen}>
      <summary class="px-4 py-2 bg-panel-secondary text-xs font-medium text-text-secondary font-mono cursor-pointer select-none hover:bg-panel-hover transition-colors">
        {frame.file}:{frame.line}:{frame.column}
        {frame.function && <span class="ml-2 text-text-muted">in {frame.function}</span>}
      </summary>
      <div class="overflow-x-auto scrollbar-thin">
        <pre class="text-xs leading-5 m-0 font-mono">
          {frame.source.map((line, i) => {
            const lineNum = startLine + i;
            const isError = i === frame.sourceLine;
            return (
              <div
                key={i}
                class={isError ? "bg-red-950/40 border-l-4 border-red-500" : "border-l-4 border-transparent hover:bg-panel-hover"}
              >
                <span class={`inline-block w-12 text-right pr-3 select-none ${isError ? "text-red-500 font-bold" : "text-text-muted"}`}>
                  {lineNum}
                </span>
                <span class={`text-ink${isError ? " font-medium" : ""}`}>{highlightLine(line)}</span>
              </div>
            );
          })}
        </pre>
      </div>
    </details>
  );
}


const MAX_COLLAPSED_LINES = 10;

function CollapsibleMessage({ message }: { message: string }) {
  const [expanded, setExpanded] = useState(false);
  const nlIndex = message.indexOf("\n");

  if (nlIndex === -1) {
    return <h1 class="text-lg font-bold text-ink m-0 leading-snug break-words">{message}</h1>;
  }

  const firstLine = message.slice(0, nlIndex);
  const rest = message.slice(nlIndex + 1);
  const restLines = rest.split("\n");
  const needsCollapse = restLines.length > MAX_COLLAPSED_LINES;

  return (
    <>
      <h1 class="text-lg font-bold text-ink m-0 leading-snug break-words">{firstLine}</h1>
      <div class="relative mt-2">
        <pre
          class="text-xs text-text-secondary m-0 whitespace-pre-wrap break-words leading-5 overflow-hidden transition-all font-mono"
          style={{
            maxHeight: !expanded && needsCollapse ? `${MAX_COLLAPSED_LINES * 1.25}rem` : "none",
          }}
        >
          {rest}
        </pre>
        {needsCollapse && !expanded && (
          <div
            class="absolute bottom-0 left-0 right-0 h-16 flex items-end justify-center pb-2 cursor-pointer"
            style="background: linear-gradient(to bottom, transparent, var(--color-panel));"
            onClick={() => setExpanded(true)}
          >
            <span class="text-xs font-medium text-text-muted hover:text-ink transition-colors">
              Show all ({restLines.length} lines)
            </span>
          </div>
        )}
        {needsCollapse && expanded && (
          <button
            class="mt-1 text-xs font-medium text-text-muted hover:text-ink transition-colors"
            onClick={() => setExpanded(false)}
          >
            Collapse
          </button>
        )}
      </div>
    </>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  fetch: "bg-blue-950/40 text-blue-400",
  scheduled: "bg-purple-950/40 text-purple-400",
  queue: "bg-orange-950/40 text-orange-400",
  alarm: "bg-yellow-950/40 text-yellow-400",
  workflow: "bg-emerald-950/40 text-emerald-400",
};

function SourceBadge({ source }: { source: string | null }) {
  const label = source ?? "unknown";
  const color = SOURCE_COLORS[label] ?? "bg-red-950/40 text-red-400";
  return (
    <span class={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}

function truncateUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return path.length > 50 ? path.slice(0, 50) + "..." : path;
  } catch {
    return url.length > 50 ? url.slice(0, 50) + "..." : url;
  }
}
