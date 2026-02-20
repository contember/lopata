import { EmptyState, PageHeader, StatusBadge, Table, TableLink } from '../components'
import { useQuery } from '../rpc/hooks'

const TYPE_COLORS: Record<string, string> = {
	kv: 'bg-emerald-500/15 text-emerald-500',
	r2: 'bg-blue-500/15 text-blue-400',
	d1: 'bg-violet-500/15 text-violet-400',
	do: 'bg-amber-500/15 text-amber-500',
	queue: 'bg-rose-500/15 text-rose-400',
	workflow: 'bg-cyan-500/15 text-cyan-400',
	service: 'bg-panel-active text-text-data',
	images: 'bg-pink-500/15 text-pink-400',
}

export function WorkersView() {
	const { data: workers } = useQuery('workers.list')

	return (
		<div class="p-8">
			<PageHeader title="Workers" subtitle={`${workers?.length ?? 0} worker(s)`} />
			{!workers?.length ? <EmptyState message="No workers configured" /> : (
				<div class="space-y-8">
					{workers.map(w => (
						<div key={w.name}>
							<div class="flex items-center gap-3 mb-4">
								<span class="w-7 h-7 rounded-md bg-panel-hover flex items-center justify-center text-sm">⊡</span>
								<h2 class="text-lg font-bold text-ink">{w.name}</h2>
								{w.isMain && <span class="px-2 py-0.5 rounded-md text-xs font-medium bg-gray-900 text-white">main</span>}
								<span class="text-xs text-text-muted">{w.bindings.length} binding(s)</span>
							</div>
							{w.bindings.length === 0 ? <EmptyState message="No bindings configured" /> : (
								<Table
									headers={['Type', 'Binding', 'Target']}
									rows={w.bindings.map(b => [
										<StatusBadge status={b.type} colorMap={TYPE_COLORS} />,
										<span class="font-mono text-xs font-medium">{b.name}</span>,
										b.href
											? <TableLink href={b.href}>{b.target}</TableLink>
											: <span class="text-text-secondary">{b.target || '—'}</span>,
									])}
								/>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}
