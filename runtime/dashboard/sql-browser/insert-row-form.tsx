import { useState } from "preact/hooks";
import type { TableSchema } from "./types";

export function InsertRowForm({ schema, displayCols, onSave, onCancel, hasCheckboxCol }: {
  schema: TableSchema;
  displayCols: string[];
  onSave: (values: Record<string, unknown>) => void;
  onCancel: () => void;
  hasCheckboxCol?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [nulls, setNulls] = useState<Record<string, boolean>>(() => {
    const n: Record<string, boolean> = {};
    for (const col of schema.columns) {
      // Default autoincrement PKs to NULL
      if (col.autoIncrement) n[col.name] = true;
    }
    return n;
  });

  const handleSave = () => {
    const result: Record<string, unknown> = {};
    for (const col of displayCols) {
      const colInfo = schema.columns.find(c => c.name === col);
      if (colInfo?.autoIncrement && nulls[col]) continue; // omit autoincrement columns set to NULL
      if (nulls[col]) {
        result[col] = null;
      } else {
        result[col] = values[col] ?? "";
      }
    }
    onSave(result);
  };

  return (
    <tr class="border-b border-emerald-100 bg-emerald-50/30">
      {hasCheckboxCol && <td class="w-10 px-3 py-2"></td>}
      {displayCols.map(col => {
        const colInfo = schema.columns.find(c => c.name === col);
        const isAutoInc = colInfo?.autoIncrement ?? false;
        const isNullVal = nulls[col] ?? false;
        return (
          <td key={col} class="px-4 py-2">
            <div class="flex items-center gap-1">
              <input
                type="text"
                value={isNullVal ? "" : (values[col] ?? "")}
                disabled={isNullVal}
                placeholder={isAutoInc ? "auto" : colInfo?.type ?? ""}
                onInput={e => setValues(v => ({ ...v, [col]: (e.target as HTMLInputElement).value }))}
                onKeyDown={e => { if (e.key === "Enter") handleSave(); else if (e.key === "Escape") onCancel(); }}
                class={`w-full bg-white border border-gray-200 rounded px-2 py-1 font-mono text-xs outline-none focus:border-ink focus:ring-1 focus:ring-gray-200 ${isNullVal ? "opacity-40" : ""}`}
              />
              <button
                onClick={() => setNulls(n => ({ ...n, [col]: !n[col] }))}
                title={isNullVal ? "Set to value" : "Set to NULL"}
                class={`flex-shrink-0 rounded px-1.5 py-1 text-xs font-bold transition-colors ${
                  isNullVal ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-400 hover:bg-gray-200"
                }`}
              >
                N
              </button>
            </div>
          </td>
        );
      })}
      <td class="px-4 py-2">
        <div class="flex items-center gap-1">
          <button
            onClick={handleSave}
            class="rounded px-2 py-1 text-xs font-medium bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
          >
            Save
          </button>
          <button
            onClick={onCancel}
            class="rounded px-2 py-1 text-xs font-medium text-gray-400 hover:text-gray-600 transition-colors"
          >
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}
