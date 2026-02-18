import type { D1Table } from "../rpc/types";
import { parseCreateTable } from "./utils";

export function SchemaBrowserTab({ tables }: { tables?: D1Table[] | null }) {
  if (!tables?.length) {
    return <div class="text-center py-16 text-text-muted text-sm font-medium">No tables found</div>;
  }

  return (
    <div class="space-y-4">
      {tables.map(t => {
        const schema = parseCreateTable(t.sql);
        return (
          <div key={t.name} class="bg-panel rounded-lg border border-border">
            <div class="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
              <div class="flex items-center gap-3">
                <span class="font-mono text-sm font-bold text-ink">{t.name}</span>
                <span class="text-xs text-text-muted tabular-nums">{t.rows} row(s)</span>
              </div>
              {schema.primaryKeys.length > 0 && (
                <span class="text-xs text-text-muted">
                  PK: <span class="font-mono text-text-secondary">{schema.primaryKeys.join(", ")}</span>
                </span>
              )}
            </div>
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border-row text-xs text-text-muted uppercase tracking-wider">
                  <th class="text-left px-4 py-2 font-medium">Column</th>
                  <th class="text-left px-4 py-2 font-medium">Type</th>
                  <th class="text-left px-4 py-2 font-medium">Nullable</th>
                  <th class="text-left px-4 py-2 font-medium">Default</th>
                </tr>
              </thead>
              <tbody>
                {schema.columns.map(col => (
                  <tr key={col.name} class="border-b border-border-row last:border-0">
                    <td class="px-4 py-2 font-mono text-xs font-medium text-ink">
                      {col.name}
                      {schema.primaryKeys.includes(col.name) && (
                        <span class="ml-1.5 text-[10px] font-semibold bg-panel-hover text-text-secondary px-1 py-0.5 rounded">PK</span>
                      )}
                      {col.autoIncrement && (
                        <span class="ml-1.5 text-[10px] font-semibold bg-amber-50 text-amber-600 px-1 py-0.5 rounded">AI</span>
                      )}
                      {col.foreignKey && (
                        <span class="ml-1.5 text-[10px] font-semibold bg-blue-50 text-blue-600 px-1 py-0.5 rounded" title={`${col.foreignKey.targetTable}(${col.foreignKey.targetColumn})`}>
                          FK &rarr; {col.foreignKey.targetTable}
                        </span>
                      )}
                    </td>
                    <td class="px-4 py-2 font-mono text-xs text-text-secondary">{col.type || "—"}</td>
                    <td class="px-4 py-2 text-xs text-text-muted">{col.notNull ? "NOT NULL" : "NULL"}</td>
                    <td class="px-4 py-2 font-mono text-xs text-text-muted">{col.defaultValue ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div class="px-4 py-2.5 border-t border-border-subtle bg-panel-hover/50">
              <pre class="text-xs text-text-muted font-mono whitespace-pre-wrap">{t.sql}</pre>
            </div>
          </div>
        );
      })}
    </div>
  );
}
