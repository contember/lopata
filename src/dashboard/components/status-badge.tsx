export function StatusBadge({ status, colorMap }: { status: string; colorMap: Record<string, string> }) {
	return (
		<span class={`inline-flex px-2 py-0.5 rounded-md text-xs font-semibold ${colorMap[status] ?? 'bg-panel-hover text-text-data'}`}>
			{status}
		</span>
	)
}
