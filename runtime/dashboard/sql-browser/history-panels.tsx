import type { HistoryEntry, BrowserHistoryEntry } from "./types";

function formatTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return isToday ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// ─── HistoryPanel ────────────────────────────────────────────────────

export function HistoryPanel({ entries, onSelect, onClear }: {
  entries: HistoryEntry[];
  onSelect: (entry: HistoryEntry) => void;
  onClear: () => void;
}) {
  if (entries.length === 0) {
    return (
      <div class="bg-panel rounded-lg border border-border p-5 mb-6 text-center text-sm text-text-muted">
        No history yet
      </div>
    );
  }

  return (
    <div class="bg-panel rounded-lg border border-border mb-6 overflow-hidden">
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle bg-panel-hover/50">
        <span class="text-xs font-semibold text-text-muted uppercase tracking-wider">Query History</span>
        <button onClick={onClear} class="text-xs text-text-muted hover:text-red-500 transition-colors">Clear all</button>
      </div>
      <div class="max-h-64 overflow-y-auto divide-y divide-border-row">
        {entries.map((entry, i) => (
          <button
            key={i}
            onClick={() => onSelect(entry)}
            class="w-full text-left px-4 py-2.5 hover:bg-panel-hover transition-colors flex items-center gap-3 group"
          >
            <code class="flex-1 text-xs font-mono text-text-data truncate group-hover:text-ink transition-colors">{entry.sql}</code>
            <span class="text-[10px] text-text-dim tabular-nums flex-shrink-0">{formatTime(entry.ts)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── BrowserHistoryPanel ─────────────────────────────────────────────

export function BrowserHistoryPanel({ entries, currentTable, onSelect, onClear }: {
  entries: BrowserHistoryEntry[];
  currentTable: string;
  onSelect: (entry: BrowserHistoryEntry) => void;
  onClear: () => void;
}) {
  if (entries.length === 0) {
    return (
      <div class="bg-panel rounded-lg border border-border p-5 mb-4 text-center text-sm text-text-muted">
        No history yet — filter or sort a table to save an entry
      </div>
    );
  }

  const formatFilters = (filters: Record<string, string>) => {
    const parts = Object.entries(filters).filter(([, v]) => v.trim());
    if (parts.length === 0) return null;
    return parts.map(([col, val]) => `${col}: ${val}`).join(", ");
  };

  return (
    <div class="bg-panel rounded-lg border border-border mb-4 overflow-hidden">
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle bg-panel-hover/50">
        <span class="text-xs font-semibold text-text-muted uppercase tracking-wider">Browser History</span>
        <button onClick={onClear} class="text-xs text-text-muted hover:text-red-500 transition-colors">Clear all</button>
      </div>
      <div class="max-h-64 overflow-y-auto divide-y divide-border-row">
        {entries.map((entry, i) => {
          const filterStr = formatFilters(entry.filters);
          const isSameTable = entry.table === currentTable;
          return (
            <button
              key={i}
              onClick={() => onSelect(entry)}
              class="w-full text-left px-4 py-2.5 hover:bg-panel-hover transition-colors group"
            >
              <div class="flex items-center gap-2 mb-1">
                <span class={`font-mono text-xs font-semibold ${isSameTable ? "text-ink" : "text-accent-olive"}`}>{entry.table}</span>
                <span class="text-[10px] text-text-dim tabular-nums">{formatTime(entry.ts)}</span>
              </div>
              <div class="flex flex-wrap gap-x-3 gap-y-0.5">
                {filterStr && (
                  <span class="text-xs text-text-secondary">
                    <span class="text-text-muted">filter:</span>{" "}
                    <span class="font-mono">{filterStr}</span>
                  </span>
                )}
                {entry.sortCol && (
                  <span class="text-xs text-text-secondary">
                    <span class="text-text-muted">order:</span>{" "}
                    <span class="font-mono">{entry.sortCol} {entry.sortDir}</span>
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
