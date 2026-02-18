import { useState } from "preact/hooks";
import type { ForeignKeyInfo } from "./types";

// ─── RowDetailModal ──────────────────────────────────────────────────

export function RowDetailModal({ columns, row, fkMap, onClose, onNavigateFK }: {
  columns: string[];
  row: Record<string, unknown>;
  fkMap: Map<string, ForeignKeyInfo>;
  onClose: () => void;
  onNavigateFK?: (targetTable: string, targetColumn: string, value: unknown) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copyValue = (col: string, value: unknown) => {
    navigator.clipboard.writeText(value === null ? "NULL" : String(value));
    setCopied(col);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        <div class="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 class="text-sm font-bold text-ink">Row Detail</h3>
          <button onClick={onClose} class="text-gray-400 hover:text-gray-600 text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="overflow-y-auto flex-1 divide-y divide-gray-50">
          {columns.map(col => {
            const value = row[col];
            const fk = fkMap.get(col);
            const strVal = value === null ? "" : String(value);
            let formatted = strVal;
            let isJson = false;
            if (value !== null && strVal.length > 0) {
              try { formatted = JSON.stringify(JSON.parse(strVal), null, 2); isJson = true; } catch {}
            }
            return (
              <div key={col} class="px-5 py-3 flex gap-4 group">
                <div class="w-1/3 flex-shrink-0 flex items-start gap-1.5 pt-0.5">
                  <span class="font-mono text-xs font-medium text-gray-500">{col}</span>
                  {fk && <span class="text-[10px] font-semibold bg-blue-50 text-blue-600 px-1 py-0.5 rounded">FK</span>}
                  {isJson && <span class="text-[10px] font-semibold bg-blue-50 text-blue-600 px-1 py-0.5 rounded">JSON</span>}
                </div>
                <div class="flex-1 min-w-0 flex items-start gap-2">
                  {value === null ? (
                    <span class="text-gray-300 italic text-xs">NULL</span>
                  ) : fk && onNavigateFK ? (
                    <button
                      onClick={() => { onNavigateFK(fk.targetTable, fk.targetColumn, value); onClose(); }}
                      class="font-mono text-xs text-blue-600 hover:text-blue-800 hover:underline text-left"
                    >
                      {strVal} &rarr; {fk.targetTable}
                    </button>
                  ) : (
                    <pre class="font-mono text-xs whitespace-pre-wrap break-all flex-1 min-w-0">{formatted}</pre>
                  )}
                  <button
                    onClick={() => copyValue(col, value)}
                    class="opacity-0 group-hover:opacity-100 text-[10px] text-gray-400 hover:text-gray-600 flex-shrink-0 px-1 py-0.5 rounded bg-gray-50 hover:bg-gray-100 transition-all"
                  >
                    {copied === col ? "ok" : "copy"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── CellInspectorModal ─────────────────────────────────────────────

export function CellInspectorModal({ column, value, onClose }: {
  column: string;
  value: unknown;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const strValue = value === null ? "NULL" : String(value);

  let formatted = strValue;
  let isJson = false;
  if (value !== null) {
    try {
      formatted = JSON.stringify(JSON.parse(strValue), null, 2);
      isJson = true;
    } catch {}
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(strValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-xl mx-4 max-h-[80vh] flex flex-col">
        <div class="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 class="text-sm font-bold text-ink">
            <span class="font-mono">{column}</span>
            {isJson && <span class="ml-2 text-[10px] font-semibold bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">JSON</span>}
          </h3>
          <div class="flex items-center gap-2">
            <button
              onClick={handleCopy}
              class="text-xs font-medium px-2 py-1 rounded bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button onClick={onClose} class="text-gray-400 hover:text-gray-600 text-lg leading-none transition-colors">&times;</button>
          </div>
        </div>
        <div class="overflow-auto flex-1 p-5">
          <pre class={`text-xs font-mono whitespace-pre-wrap break-all ${value === null ? "text-gray-300 italic" : ""}`}>{formatted}</pre>
        </div>
      </div>
    </div>
  );
}
