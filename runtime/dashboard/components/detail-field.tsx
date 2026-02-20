export function DetailField({ label, value, children }: { label: string; value?: string; children?: any }) {
	return (
		<div class="bg-panel rounded-lg border border-border p-5">
			<div class="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{label}</div>
			{value ? <div class="font-mono text-sm font-medium">{value}</div> : children}
		</div>
	)
}
