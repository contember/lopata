import { EmptyState, PageHeader, StatusBadge, Table } from '../components'
import { useQuery } from '../rpc/hooks'

const TYPE_COLORS: Record<string, string> = {
	route: 'bg-emerald-500/15 text-emerald-500',
	host: 'bg-blue-500/15 text-blue-500',
	fallback: 'bg-panel-active text-text-data',
}

export function RoutesView() {
	const { data: routes } = useQuery('routes.list')

	return (
		<div class="p-4 sm:p-8">
			<PageHeader title="Routes" subtitle={`${routes?.length ?? 0} route(s)`} />
			{!routes?.length ? <EmptyState message="No routes configured" /> : (
				<Table
					headers={['Pattern', 'Worker', 'Type']}
					rows={routes.map(r => [
						<span class="font-mono text-xs font-medium">{r.pattern}</span>,
						<span class="text-text-secondary">{r.workerName}</span>,
						<StatusBadge status={r.isFallback ? 'fallback' : r.type === 'host' ? 'host' : 'route'} colorMap={TYPE_COLORS} />,
					])}
				/>
			)}
		</div>
	)
}
