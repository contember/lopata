export function Table({ headers, rows }: { headers: string[]; rows: unknown[][] }) {
  return (
    <div class="bg-panel rounded-lg border border-border overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border-subtle">
            {headers.map(h => (
              <th key={h} class="text-left px-4 py-3 font-medium text-xs text-text-muted uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} class="group border-b border-border-row last:border-0 hover:bg-panel-hover/50 transition-colors">
              {row.map((cell, j) => (
                <td key={j} class="px-4 py-3">
                  {cell as any}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
