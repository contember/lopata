export function KeyValueTable({ data }: { data: Record<string, string> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return <div class="px-4 py-3 text-sm text-text-muted">No entries</div>;
  }

  return (
    <table class="w-full text-sm">
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key} class="border-b border-border-subtle last:border-0 hover:bg-panel-hover/50 transition-colors">
            <td class="px-4 py-2 font-medium text-text-secondary whitespace-nowrap align-top font-mono" style="width: 1%;">
              {key}
            </td>
            <td class="px-4 py-2 text-ink break-all font-mono">
              {value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
