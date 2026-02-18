import type { D1Table } from "../rpc/types";

export function TableSidebar({ tables, selected, onSelect }: {
  tables?: D1Table[] | null;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  if (!tables?.length) {
    return (
      <div class="w-52 flex-shrink-0">
        <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-2">Tables</div>
        <div class="text-xs text-gray-400 px-2">No tables</div>
      </div>
    );
  }

  return (
    <div class="w-52 flex-shrink-0">
      <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-2">Tables</div>
      <div class="space-y-0.5">
        {tables.map(t => (
          <button
            key={t.name}
            onClick={() => onSelect(t.name)}
            class={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between ${
              selected === t.name
                ? "bg-ink text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            <span class="font-mono text-xs truncate">{t.name}</span>
            <span class={`text-xs tabular-nums ${selected === t.name ? "text-gray-300" : "text-gray-400"}`}>{t.rows}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
