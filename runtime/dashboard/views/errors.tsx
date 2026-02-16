import { useState, useEffect } from "preact/hooks";
import { useMutation } from "../rpc/hooks";
import type { ErrorSummary, ErrorDetail } from "../rpc/types";
import { rpc } from "../rpc/client";

export function ErrorsView() {
  const [errors, setErrors] = useState<ErrorSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      setSelectedId(null);
    });
  };

  const handleDelete = (id: string) => {
    rpc("errors.delete", { id }).then(() => {
      setErrors(prev => prev.filter(e => e.id !== id));
      if (selectedId === id) setSelectedId(null);
    });
  };

  return (
    <div class="p-8 h-full flex flex-col">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-bold text-ink">Errors</h1>
          <p class="text-sm text-gray-400 mt-1">{errors.length} error(s)</p>
        </div>
        {errors.length > 0 && (
          <button
            onClick={handleClear}
            class="rounded-md px-3 py-1.5 text-sm font-medium bg-white border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-all"
          >
            Clear all
          </button>
        )}
      </div>

      <div class="flex-1 overflow-y-auto scrollbar-thin">
        {errors.length === 0 && !isLoading ? (
          <div class="text-gray-400 font-medium text-center py-12">No errors recorded yet.</div>
        ) : (
          <div class="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-gray-100">
                  <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Source</th>
                  <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Error</th>
                  <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Message</th>
                  <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Context</th>
                  <th class="text-left px-4 py-2.5 text-xs text-gray-400 font-medium">Worker</th>
                  <th class="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">Trace</th>
                  <th class="text-right px-4 py-2.5 text-xs text-gray-400 font-medium">Time</th>
                  <th class="text-right px-4 py-2.5 text-xs text-gray-400 font-medium w-10"></th>
                </tr>
              </thead>
              <tbody>
                {errors.map(err => (
                  <tr
                    key={err.id}
                    onClick={() => setSelectedId(err.id)}
                    class={`border-b border-gray-50 cursor-pointer transition-colors hover:bg-gray-50/50 ${
                      selectedId === err.id ? "bg-gray-50" : ""
                    }`}
                  >
                    <td class="px-4 py-2.5">
                      <SourceBadge source={err.source} />
                    </td>
                    <td class="px-4 py-2.5 font-medium text-ink">{err.errorName}</td>
                    <td class="px-4 py-2.5 text-gray-600 truncate max-w-[250px]">{err.errorMessage}</td>
                    <td class="px-4 py-2.5 text-gray-500 font-mono text-xs">
                      {err.requestMethod && err.requestUrl ? (
                        <span>
                          <span class="font-medium">{err.requestMethod}</span>{" "}
                          {truncateUrl(err.requestUrl)}
                        </span>
                      ) : (
                        <span class="text-gray-300">-</span>
                      )}
                    </td>
                    <td class="px-4 py-2.5">
                      {err.workerName && (
                        <span class="inline-flex px-2 py-0.5 rounded-md text-xs font-medium bg-gray-100 text-gray-500">
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
                        <span class="text-gray-300 text-xs">-</span>
                      )}
                    </td>
                    <td class="px-4 py-2.5 text-right font-mono text-xs text-gray-400">
                      {formatTimestamp(err.timestamp)}
                    </td>
                    <td class="px-4 py-2.5 text-right">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(err.id); }}
                        class="text-gray-300 hover:text-red-500 transition-colors"
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
              <div class="p-4 text-center border-t border-gray-100">
                <button
                  onClick={() => loadErrors(cursor)}
                  disabled={isLoading}
                  class="text-sm text-gray-500 hover:text-ink disabled:text-gray-300"
                >
                  {isLoading ? "Loading..." : "Load more"}
                </button>
              </div>
            )}
          </div>
        )}
        {isLoading && errors.length === 0 && (
          <div class="text-gray-400 text-sm text-center py-12">Loading errors...</div>
        )}
      </div>

      {selectedId && (
        <ErrorDrawer
          errorId={selectedId}
          onClose={() => setSelectedId(null)}
          onDelete={(id) => handleDelete(id)}
        />
      )}
    </div>
  );
}

// ─── Error Detail Drawer ──────────────────────────────────────────────

function ErrorDrawer({ errorId, onClose, onDelete }: {
  errorId: string;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  const [detail, setDetail] = useState<ErrorDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    rpc("errors.get", { id: errorId }).then(data => {
      setDetail(data as ErrorDetail);
      setIsLoading(false);
    }).catch(() => setIsLoading(false));
  }, [errorId]);

  return (
    <>
      <div class="fixed inset-0 bg-black/10 z-40" onClick={onClose} />
      <div class="fixed right-0 top-0 bottom-0 w-[720px] max-w-[90vw] bg-white border-l border-gray-200 z-50 flex flex-col overflow-hidden animate-slide-in">
        {/* Header */}
        <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-xs">
              <span class="text-gray-400 font-mono">Error {errorId.slice(0, 12)}...</span>
              {detail?.source && <SourceBadge source={detail.source} />}
              {detail?.traceId && (
                <a
                  href={`#/traces?trace=${detail.traceId}`}
                  class="text-blue-500 hover:text-blue-700 font-mono"
                >
                  Trace {detail.traceId.slice(0, 8)}...
                </a>
              )}
            </div>
            <div class="text-sm font-medium text-red-600 mt-0.5 truncate">
              {detail?.data.error.name ?? "Loading..."}: {detail?.data.error.message ? truncate(detail.data.error.message, 60) : ""}
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0 ml-3">
            <button
              onClick={() => { onDelete(errorId); onClose(); }}
              class="px-2 py-1 text-xs rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              Delete
            </button>
            <button onClick={onClose} class="w-7 h-7 flex items-center justify-center rounded-md hover:bg-gray-100 transition-colors text-gray-400 hover:text-ink">
              &times;
            </button>
          </div>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-y-auto scrollbar-thin p-5 space-y-6">
          {isLoading ? (
            <div class="text-gray-400 text-sm">Loading error details...</div>
          ) : detail ? (
            <>
              {/* Error section */}
              <Section title="Error">
                <div class="space-y-3">
                  <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    <span class="text-gray-400">Name:</span>
                    <span class="text-red-600 font-medium">{detail.data.error.name}</span>
                    <span class="text-gray-400">Message:</span>
                    <span class="text-ink">{detail.data.error.message}</span>
                    <span class="text-gray-400">Time:</span>
                    <span class="text-ink font-mono">{new Date(detail.timestamp).toLocaleString()}</span>
                    {detail.source && (
                      <>
                        <span class="text-gray-400">Source:</span>
                        <span class="text-ink">{detail.source}</span>
                      </>
                    )}
                    {detail.traceId && (
                      <>
                        <span class="text-gray-400">Trace:</span>
                        <a href={`#/traces?trace=${detail.traceId}`} class="text-blue-500 hover:text-blue-700 font-mono">
                          {detail.traceId}
                        </a>
                      </>
                    )}
                  </div>

                  {/* Stack trace with source preview */}
                  {detail.data.error.frames.length > 0 && (
                    <div>
                      <div class="text-xs text-gray-400 mb-2">Stack Trace:</div>
                      <div class="space-y-2">
                        {detail.data.error.frames.map((frame, i) => (
                          <div key={i} class="text-xs">
                            <div class="flex items-baseline gap-2 text-gray-600">
                              <span class="font-medium text-ink">{frame.function}</span>
                              <span class="text-gray-400 font-mono text-[11px] truncate">
                                {frame.file}:{frame.line}:{frame.column}
                              </span>
                            </div>
                            {frame.source && (
                              <pre class="mt-1 bg-gray-900 text-gray-300 p-3 rounded-md overflow-x-auto text-[11px] leading-5">
                                {frame.source.map((line, j) => (
                                  <div key={j} class={j === frame.sourceLine ? "bg-red-900/40 text-white -mx-3 px-3" : ""}>
                                    <span class="inline-block w-8 text-right mr-3 text-gray-500 select-none">
                                      {(frame.line - (frame.sourceLine ?? 0) + j)}
                                    </span>
                                    {line}
                                  </div>
                                ))}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Raw stack */}
                  {detail.data.error.frames.length === 0 && detail.data.error.stack && (
                    <div>
                      <div class="text-xs text-gray-400 mb-1">Stack:</div>
                      <pre class="text-[11px] text-gray-600 bg-gray-50 p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
                        {detail.data.error.stack}
                      </pre>
                    </div>
                  )}
                </div>
              </Section>

              {/* Request section — only show if there's actual request data */}
              {detail.data.request.method && detail.data.request.url && (
                <Section title="Request">
                  <div class="space-y-2 text-xs">
                    <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                      <span class="text-gray-400">Method:</span>
                      <span class="font-medium text-ink">{detail.data.request.method}</span>
                      <span class="text-gray-400">URL:</span>
                      <span class="text-ink font-mono break-all">{detail.data.request.url}</span>
                    </div>
                    {Object.keys(detail.data.request.headers).length > 0 && (
                      <div>
                        <div class="text-gray-400 mb-1">Headers:</div>
                        <table class="w-full">
                          <tbody>
                            {Object.entries(detail.data.request.headers).map(([k, v]) => (
                              <tr key={k}>
                                <td class="py-0.5 pr-3 text-gray-400 font-mono whitespace-nowrap align-top">{k}</td>
                                <td class="py-0.5 font-mono text-ink break-all">{v}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </Section>
              )}

              {/* Environment section */}
              {Object.keys(detail.data.env).length > 0 && (
                <Section title="Environment">
                  <table class="w-full text-xs">
                    <tbody>
                      {Object.entries(detail.data.env).map(([k, v]) => (
                        <tr key={k}>
                          <td class="py-0.5 pr-3 text-gray-400 font-mono whitespace-nowrap align-top">{k}</td>
                          <td class="py-0.5 font-mono text-ink break-all">{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Bindings section */}
              {detail.data.bindings.length > 0 && (
                <Section title="Bindings">
                  <div class="flex flex-wrap gap-2">
                    {detail.data.bindings.map(b => (
                      <span key={b.name} class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs bg-gray-50 border border-gray-100">
                        <span class="text-gray-400">{b.type}</span>
                        <span class="font-medium text-ink">{b.name}</span>
                      </span>
                    ))}
                  </div>
                </Section>
              )}

              {/* Runtime section */}
              <Section title="Runtime">
                <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <span class="text-gray-400">Bun:</span>
                  <span class="text-ink font-mono">{detail.data.runtime.bunVersion}</span>
                  <span class="text-gray-400">Platform:</span>
                  <span class="text-ink">{detail.data.runtime.platform} / {detail.data.runtime.arch}</span>
                  {detail.data.runtime.workerName && (
                    <>
                      <span class="text-gray-400">Worker:</span>
                      <span class="text-ink">{detail.data.runtime.workerName}</span>
                    </>
                  )}
                  {detail.data.runtime.configName && (
                    <>
                      <span class="text-gray-400">Config:</span>
                      <span class="text-ink">{detail.data.runtime.configName}</span>
                    </>
                  )}
                </div>
              </Section>
            </>
          ) : (
            <div class="text-gray-400 text-sm">Error not found.</div>
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

const SOURCE_COLORS: Record<string, string> = {
  fetch: "bg-blue-50 text-blue-700",
  scheduled: "bg-purple-50 text-purple-700",
  queue: "bg-orange-50 text-orange-700",
  alarm: "bg-yellow-50 text-yellow-700",
  workflow: "bg-emerald-50 text-emerald-700",
};

function SourceBadge({ source }: { source: string | null }) {
  const label = source ?? "unknown";
  const color = SOURCE_COLORS[label] ?? "bg-red-50 text-red-700";
  return (
    <span class={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div>
      <h3 class="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">{title}</h3>
      <div class="bg-gray-50 border border-gray-100 rounded-lg p-4">
        {children}
      </div>
    </div>
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

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len) + "..." : s;
}
