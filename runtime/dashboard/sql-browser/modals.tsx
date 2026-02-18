import { useState } from "preact/hooks";
import type { ForeignKeyInfo } from "./types";
import { Modal } from "../components/modal";

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
    <Modal title="Row Detail" onClose={onClose}>
      <div class="overflow-y-auto flex-1 divide-y divide-border-row">
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
                <span class="font-mono text-xs font-medium text-text-secondary">{col}</span>
                {fk && <span class="text-[10px] font-semibold bg-blue-50 text-blue-600 px-1 py-0.5 rounded">FK</span>}
                {isJson && <span class="text-[10px] font-semibold bg-blue-50 text-blue-600 px-1 py-0.5 rounded">JSON</span>}
              </div>
              <div class="flex-1 min-w-0 flex items-start gap-2">
                {value === null ? (
                  <span class="text-text-dim italic text-xs">NULL</span>
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
                  class="opacity-0 group-hover:opacity-100 text-[10px] text-text-muted hover:text-text-data flex-shrink-0 px-1 py-0.5 rounded bg-panel-secondary hover:bg-panel-hover transition-all"
                >
                  {copied === col ? "ok" : "copy"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
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

  const titleContent = (
    <span>
      <span class="font-mono">{column}</span>
      {isJson && <span class="ml-2 text-[10px] font-semibold bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">JSON</span>}
    </span>
  );

  return (
    <Modal title={titleContent} onClose={onClose} maxWidth="max-w-xl">
      <div class="overflow-auto flex-1 p-5">
        <div class="flex justify-end mb-3">
          <button
            onClick={handleCopy}
            class="text-xs font-medium px-2 py-1 rounded bg-panel-hover text-text-secondary hover:bg-panel-active transition-colors"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <pre class={`text-xs font-mono whitespace-pre-wrap break-all ${value === null ? "text-text-dim italic" : ""}`}>{formatted}</pre>
      </div>
    </Modal>
  );
}
