import { useRef } from "preact/hooks";
import { Modal } from "../components/modal";

export function FilterRow({ columns, filters, onFilterChange, onClearAll, hasCheckboxCol }: {
  columns: string[];
  filters: Record<string, string>;
  onFilterChange: (col: string, value: string) => void;
  onClearAll: () => void;
  hasCheckboxCol?: boolean;
}) {
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const hasAny = Object.values(filters).some(v => v.trim());

  const handleInput = (col: string, value: string) => {
    clearTimeout(debounceRef.current[col]);
    debounceRef.current[col] = setTimeout(() => {
      onFilterChange(col, value);
    }, 400);
  };

  return (
    <tr class="border-b border-border-subtle bg-panel-hover/50">
      {hasCheckboxCol && <th class="w-10 px-3 py-1.5"></th>}
      {columns.map(col => (
        <th key={col} class="px-4 py-1.5">
          <input
            type="text"
            placeholder="filter..."
            defaultValue={filters[col] ?? ""}
            onInput={e => handleInput(col, (e.target as HTMLInputElement).value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                clearTimeout(debounceRef.current[col]);
                onFilterChange(col, (e.target as HTMLInputElement).value);
              }
            }}
            class="w-full bg-panel border border-border rounded px-2 py-1 font-mono text-xs font-normal outline-none focus:border-border focus:ring-1 focus:ring-border transition-all"
          />
        </th>
      ))}
      <th class="px-4 py-1.5">
        {hasAny && (
          <button
            onClick={onClearAll}
            class="text-xs text-text-muted hover:text-text-data transition-colors whitespace-nowrap"
            title="Clear all filters"
          >
            clear
          </button>
        )}
      </th>
    </tr>
  );
}

// ─── FilterHelpModal ─────────────────────────────────────────────────

const FILTER_HELP: { expr: string; desc: string; example: string }[] = [
  { expr: "text", desc: "Contains (case-insensitive match)", example: "alice" },
  { expr: "=value", desc: "Exact match", example: "=pending" },
  { expr: "!value", desc: "Not equal", example: "!cancelled" },
  { expr: ">value", desc: "Greater than", example: ">100" },
  { expr: "<value", desc: "Less than", example: "<50" },
  { expr: ">=value", desc: "Greater or equal", example: ">=10.5" },
  { expr: "<=value", desc: "Less or equal", example: "<=99" },
  { expr: "%pat%", desc: "LIKE pattern (% = any, _ = one char)", example: "%@example%" },
  { expr: "NULL", desc: "Value is NULL", example: "NULL" },
  { expr: "!NULL", desc: "Value is not NULL", example: "!NULL" },
];

export function FilterHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Filter Syntax" onClose={onClose} maxWidth="max-w-md">
      <div class="px-5 py-3">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs text-text-muted uppercase tracking-wider">
              <th class="text-left py-1.5 font-medium">Expression</th>
              <th class="text-left py-1.5 font-medium">Description</th>
              <th class="text-left py-1.5 font-medium">Example</th>
            </tr>
          </thead>
          <tbody>
            {FILTER_HELP.map(h => (
              <tr key={h.expr} class="border-t border-border-row">
                <td class="py-1.5 pr-3"><code class="text-xs font-mono bg-panel-secondary px-1.5 py-0.5 rounded text-ink">{h.expr}</code></td>
                <td class="py-1.5 pr-3 text-xs text-text-secondary">{h.desc}</td>
                <td class="py-1.5"><code class="text-xs font-mono text-text-muted">{h.example}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="px-5 py-3 border-t border-border-subtle text-xs text-text-muted">
        Filters apply per column. Multiple column filters combine with AND.
      </div>
    </Modal>
  );
}
