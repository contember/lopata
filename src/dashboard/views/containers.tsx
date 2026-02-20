import { useState } from 'preact/hooks'
import { Breadcrumb, CodeBlock, DetailField, EmptyState, PageHeader, RefreshButton, ServiceInfo, StatusBadge, Table, TableLink } from '../components'
import { useMutation, useQuery } from '../rpc/hooks'

const CONTAINER_STATE_COLORS: Record<string, string> = {
	running: 'bg-emerald-500/15 text-emerald-500',
	healthy: 'bg-emerald-500/15 text-emerald-500',
	exited: 'bg-panel-active text-text-data',
	stopped: 'bg-panel-active text-text-data',
	created: 'bg-blue-500/15 text-blue-400',
	paused: 'bg-yellow-500/15 text-yellow-500',
	dead: 'bg-red-500/15 text-red-500',
}

export function ContainersView({ route }: { route: string }) {
	const parts = route.split('/').filter(Boolean)
	if (parts.length === 1) return <ContainerList />
	if (parts.length === 2) return <ContainerInstanceList className={decodeURIComponent(parts[1]!)} />
	if (parts.length >= 3) return <ContainerDetailView className={decodeURIComponent(parts[1]!)} id={decodeURIComponent(parts[2]!)} />
	return null
}

function ContainerList() {
	const { data: containers, refetch } = useQuery('containers.list')
	const { data: configGroups } = useQuery('config.forService', { type: 'containers' })

	const totalInstances = containers?.reduce((s, c) => s + c.instanceCount, 0) ?? 0
	const totalRunning = containers?.reduce((s, c) => s + c.runningCount, 0) ?? 0

	return (
		<div class="p-4 sm:p-8 max-w-6xl">
			<PageHeader title="Containers" subtitle={`${containers?.length ?? 0} container class(es)`} actions={<RefreshButton onClick={refetch} />} />
			<div class="flex flex-col lg:flex-row gap-6 items-start">
				<div class="flex-1 min-w-0">
					{!containers?.length ? <EmptyState message="No containers configured" /> : (
						<Table
							headers={['Class Name', 'Image', 'Max Instances', 'Instances', 'Running']}
							rows={containers.map(c => [
								<TableLink href={`#/containers/${encodeURIComponent(c.className)}`}>{c.className}</TableLink>,
								<span class="font-mono text-xs">{c.image}</span>,
								c.maxInstances ?? 'unlimited',
								<span class="tabular-nums">{c.instanceCount}</span>,
								<span class={`tabular-nums font-medium ${c.runningCount > 0 ? 'text-emerald-600' : ''}`}>{c.runningCount}</span>,
							])}
						/>
					)}
				</div>
				<ServiceInfo
					description="Docker-backed container instances managed as Durable Objects."
					stats={[
						{ label: 'Classes', value: String(containers?.length ?? 0) },
						{ label: 'Instances', value: String(totalInstances) },
						{ label: 'Running', value: String(totalRunning) },
					]}
					configGroups={configGroups}
					links={[
						{ label: 'Documentation', href: 'https://developers.cloudflare.com/containers/' },
					]}
				/>
			</div>
		</div>
	)
}

function ContainerInstanceList({ className }: { className: string }) {
	const { data: instances, refetch } = useQuery('containers.listInstances', { className })

	return (
		<div class="p-4 sm:p-8">
			<Breadcrumb items={[{ label: 'Containers', href: '#/containers' }, { label: className }]} />
			<div class="mb-6 flex justify-end">
				<RefreshButton onClick={refetch} />
			</div>
			{!instances?.length ? <EmptyState message="No container instances found" /> : (
				<Table
					headers={['Instance', 'Docker State', 'Ports']}
					rows={instances.map(inst => [
						<div>
							<TableLink href={`#/containers/${encodeURIComponent(className)}/${encodeURIComponent(inst.id)}`} mono>
								{inst.containerName}
							</TableLink>
							{inst.doName && <span class="text-text-muted text-xs ml-2">({inst.doName})</span>}
						</div>,
						<StatusBadge status={inst.state} colorMap={CONTAINER_STATE_COLORS} />,
						Object.keys(inst.ports).length > 0
							? <span class="font-mono text-xs">{Object.entries(inst.ports).map(([k, v]) => `${v}->${k}`).join(', ')}</span>
							: <span class="text-text-muted">—</span>,
					])}
				/>
			)}
		</div>
	)
}

function ContainerDetailView({ className, id }: { className: string; id: string }) {
	const [tail, setTail] = useState(100)
	const { data: detail, refetch: refetchDetail } = useQuery('containers.getDetail', { className, id })
	const { data: logsData, refetch: refetchLogs } = useQuery('containers.getLogs', { className, id, tail })
	const stopMutation = useMutation('containers.stop')
	const destroyMutation = useMutation('containers.destroy')

	const refetch = () => {
		refetchDetail()
		refetchLogs()
	}

	if (!detail) return <div class="p-4 sm:p-8 text-text-muted font-medium">Loading...</div>

	const isRunning = detail.state === 'running' || detail.state === 'healthy'

	const handleStop = async () => {
		if (!confirm('Stop this container?')) return
		await stopMutation.mutate({ className, id })
		refetch()
	}

	const handleDestroy = async () => {
		if (!confirm('Force remove this container? This cannot be undone.')) return
		await destroyMutation.mutate({ className, id })
		refetch()
	}

	return (
		<div class="p-4 sm:p-8 max-w-5xl">
			<Breadcrumb
				items={[
					{ label: 'Containers', href: '#/containers' },
					{ label: className, href: `#/containers/${encodeURIComponent(className)}` },
					{ label: id.slice(0, 16) + '...' },
				]}
			/>

			{/* Status + Actions */}
			<div class="mb-6 flex items-center gap-4">
				<StatusBadge status={detail.state} colorMap={CONTAINER_STATE_COLORS} />
				{detail.exitCode !== null && (
					<span class="text-sm text-text-muted">
						Exit code: <span class="font-mono">{detail.exitCode}</span>
					</span>
				)}
				<div class="flex-1" />
				{isRunning && (
					<button
						onClick={handleStop}
						disabled={stopMutation.isLoading}
						class="px-3 py-1.5 text-sm rounded-md bg-yellow-500/15 text-yellow-500 hover:bg-yellow-500/25 border border-yellow-500/30 disabled:opacity-50"
					>
						{stopMutation.isLoading ? 'Stopping...' : 'Stop'}
					</button>
				)}
				<button
					onClick={handleDestroy}
					disabled={destroyMutation.isLoading}
					class="px-3 py-1.5 text-sm rounded-md bg-red-500/15 text-red-500 hover:bg-red-500/25 border border-red-500/30 disabled:opacity-50"
				>
					{destroyMutation.isLoading ? 'Removing...' : 'Force Remove'}
				</button>
				<RefreshButton onClick={refetch} />
			</div>

			{/* Info Grid */}
			<div class="grid grid-cols-2 gap-4 mb-8">
				<DetailField label="Container Name" value={detail.containerName} />
				<DetailField label="Instance ID">
					<span class="font-mono text-sm font-medium break-all">{detail.id}</span>
				</DetailField>
				<DetailField label="Image" value={detail.image || '—'} />
				<DetailField label="DO Name" value={detail.doName || '—'} />
				<DetailField label="Ports">
					{Object.keys(detail.ports).length > 0
						? <span class="font-mono text-sm">{Object.entries(detail.ports).map(([k, v]) => `${v} -> ${k}`).join(', ')}</span>
						: <span class="text-text-muted">No ports mapped</span>}
				</DetailField>
				<DetailField label="Default Port" value={String(detail.config.defaultPort)} />
				<DetailField label="Sleep After" value={detail.config.sleepAfter != null ? String(detail.config.sleepAfter) : 'disabled'} />
				<DetailField label="Internet" value={detail.config.enableInternet ? 'enabled' : 'disabled'} />
				<DetailField label="Ping Endpoint" value={detail.config.pingEndpoint} />
			</div>

			{/* Logs */}
			<div class="mb-4 flex items-center gap-3">
				<h3 class="text-lg font-semibold text-text-data">Logs</h3>
				<select
					value={tail}
					onChange={(e) => setTail(Number((e.target as HTMLSelectElement).value))}
					class="text-sm border border-border rounded px-2 py-1 bg-panel text-text-data"
				>
					<option value={50}>Last 50 lines</option>
					<option value={100}>Last 100 lines</option>
					<option value={500}>Last 500 lines</option>
					<option value={1000}>Last 1000 lines</option>
				</select>
				<RefreshButton onClick={refetchLogs} />
			</div>
			<CodeBlock>{logsData?.logs || '(no logs)'}</CodeBlock>
		</div>
	)
}
