import { useState } from 'preact/hooks'
import { DeleteButton, EmptyState, PageHeader, PillButton, RefreshButton, ServiceInfo, StatusBadge, Table } from '../components'
import { formatTime } from '../lib'
import { useMutation, useQuery } from '../rpc/hooks'

const AI_STATUS_COLORS: Record<string, string> = {
	ok: 'bg-emerald-100 text-emerald-700',
	error: 'bg-red-100 text-red-700',
}

export function AiView({ route }: { route: string }) {
	const parts = route.split('/').filter(Boolean)
	if (parts.length >= 2) return <AiDetail id={parts[1]!} />
	return <AiList />
}

function AiList() {
	const [modelFilter, setModelFilter] = useState('')
	const [statusFilter, setStatusFilter] = useState('')
	const { data: requests, refetch } = useQuery('ai.list', {
		model: modelFilter || undefined,
		status: statusFilter || undefined,
	})
	const { data: stats } = useQuery('ai.stats')
	const { data: models } = useQuery('ai.models')
	const { data: configGroups } = useQuery('config.forService', { type: 'ai' })
	const deleteReq = useMutation('ai.delete')

	const handleDelete = async (id: string) => {
		if (!confirm('Delete this AI request log?')) return
		await deleteReq.mutate({ id })
		refetch()
	}

	return (
		<div class="p-8 max-w-6xl">
			<PageHeader title="Workers AI" subtitle={`${stats?.total ?? 0} request(s)`} actions={<RefreshButton onClick={refetch} />} />
			<div class="flex gap-6 items-start">
				<div class="flex-1 min-w-0">
					<div class="mb-6 flex gap-2 items-center flex-wrap">
						<PillButton onClick={() => setStatusFilter('')} active={statusFilter === ''}>
							All
						</PillButton>
						<PillButton onClick={() => setStatusFilter('ok')} active={statusFilter === 'ok'}>
							OK
						</PillButton>
						<PillButton onClick={() => setStatusFilter('error')} active={statusFilter === 'error'}>
							Error
						</PillButton>
						{(models?.length ?? 0) > 0 && (
							<select
								value={modelFilter}
								onChange={e => setModelFilter((e.target as HTMLSelectElement).value)}
								class="ml-2 text-xs bg-panel-secondary border border-border rounded-md px-2 py-1 outline-none"
							>
								<option value="">All models</option>
								{models!.map(m => <option key={m} value={m}>{m}</option>)}
							</select>
						)}
					</div>
					{!requests?.length ? <EmptyState message="No AI requests found" /> : (
						<Table
							headers={['Model', 'Status', 'Duration', 'Stream', 'Time', '']}
							rows={requests.map(r => [
								<a href={`#/ai/${r.id}`} class="font-mono text-xs text-blue-600 hover:underline max-w-[200px] truncate block">{r.model}</a>,
								<StatusBadge status={r.status} colorMap={AI_STATUS_COLORS} />,
								<span class="text-xs text-text-muted tabular-nums">{r.duration_ms}ms</span>,
								r.is_streaming ? <span class="text-xs text-purple-500">yes</span> : <span class="text-xs text-text-dim">no</span>,
								<span class="text-xs text-text-muted">{formatTime(r.created_at)}</span>,
								<DeleteButton onClick={() => handleDelete(r.id)} />,
							])}
						/>
					)}
				</div>
				<ServiceInfo
					description="Workers AI binding — proxies requests to Cloudflare AI API."
					stats={[
						{ label: 'Total', value: stats?.total ?? 0 },
						{ label: 'Avg duration', value: `${stats?.avgDuration ?? 0}ms` },
						...(stats?.byStatus ? Object.entries(stats.byStatus).map(([k, v]) => ({ label: k, value: v })) : []),
					]}
					configGroups={configGroups}
					links={[
						{ label: 'Workers AI docs', href: 'https://developers.cloudflare.com/workers-ai/' },
						{ label: 'Models', href: 'https://developers.cloudflare.com/workers-ai/models/' },
					]}
				/>
			</div>
		</div>
	)
}

function AiDetail({ id }: { id: string }) {
	const { data } = useQuery('ai.get', { id })

	if (!data) {
		return (
			<div class="p-8">
				<a href="#/ai" class="text-sm text-blue-600 hover:underline mb-4 inline-block">Back to AI requests</a>
				<EmptyState message="Request not found" />
			</div>
		)
	}

	return (
		<div class="p-8 max-w-4xl">
			<a href="#/ai" class="text-sm text-blue-600 hover:underline mb-4 inline-block">Back to AI requests</a>
			<div class="bg-panel border border-border rounded-lg p-6">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-ink">AI Request Detail</h2>
					<StatusBadge status={data.status} colorMap={AI_STATUS_COLORS} />
				</div>
				<div class="grid grid-cols-2 gap-4 mb-4 text-sm">
					<div>
						<span class="text-text-muted">Model:</span> <span class="font-mono">{data.model}</span>
					</div>
					<div>
						<span class="text-text-muted">Duration:</span> <span class="tabular-nums">{data.duration_ms}ms</span>
					</div>
					<div>
						<span class="text-text-muted">Streaming:</span> {data.is_streaming ? 'Yes' : 'No'}
					</div>
					<div>
						<span class="text-text-muted">Time:</span> {formatTime(data.created_at)}
					</div>
					{data.error && (
						<div class="col-span-2">
							<span class="text-text-muted">Error:</span> <span class="text-red-600">{data.error}</span>
						</div>
					)}
				</div>
				<div class="mb-4">
					<div class="text-xs text-text-muted mb-2">Input</div>
					<pre class="bg-panel-secondary border border-border rounded-lg p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">{data.input_summary ?? "<empty>"}</pre>
				</div>
				<div>
					<div class="text-xs text-text-muted mb-2">Output</div>
					<pre class="bg-panel-secondary border border-border rounded-lg p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">{data.output_summary ?? "<empty>"}</pre>
				</div>
			</div>
		</div>
	)
}
