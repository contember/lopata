import { useCallback, useEffect, useState } from 'preact/hooks'
import { EmptyState, PageHeader, StatusBadge } from '../components'
import { rpc } from '../rpc/client'
import { useMutation, useQuery } from '../rpc/hooks'
import type { GenerationDetail, GenerationInfo, GenerationsData } from '../rpc/types'

const STATE_COLORS: Record<string, string> = {
	active: 'bg-emerald-500/15 text-emerald-500',
	draining: 'bg-yellow-500/15 text-yellow-500',
	stopped: 'bg-gray-500/15 text-gray-400',
}

const STATE_DESCRIPTIONS: Record<string, string> = {
	active: 'Receiving new requests',
	draining: 'Finishing in-flight requests, no new requests accepted',
	stopped: 'All work finished, will be removed shortly',
}

function formatRelativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp
	if (diff < 1000) return 'just now'
	if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
	return `${Math.floor(diff / 3_600_000)}h ago`
}

function GenerationCard({ gen, onReload, onStop }: {
	gen: GenerationInfo
	onReload: () => void
	onStop: (id: number) => void
}) {
	const [detail, setDetail] = useState<GenerationDetail | null>(null)
	const [expanded, setExpanded] = useState(false)

	useEffect(() => {
		if (!expanded) return
		rpc('generations.detail', { id: gen.id, workerName: gen.workerName }).then(setDetail).catch(() => {})
	}, [expanded, gen.id])

	return (
		<div class="bg-panel rounded-lg border border-border p-4">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<span class="text-lg font-bold font-mono text-ink">#{gen.id}</span>
					<span title={STATE_DESCRIPTIONS[gen.state]}>
						<StatusBadge status={gen.state} colorMap={STATE_COLORS} />
					</span>
					{gen.workerName && (
						<span class="inline-flex px-2 py-0.5 rounded-md text-xs font-medium bg-panel-hover text-text-secondary">
							{gen.workerName}
						</span>
					)}
				</div>
				<div class="flex items-center gap-2">
					{gen.state === 'active' && (
						<button
							onClick={onReload}
							class="rounded-md px-3 py-1.5 text-xs font-medium bg-panel border border-border text-text-secondary hover:bg-panel-hover transition-all"
						>
							Reload
						</button>
					)}
					{gen.state === 'draining' && (
						<button
							onClick={() => onStop(gen.id)}
							class="rounded-md px-3 py-1.5 text-xs font-medium bg-panel border border-border text-text-secondary btn-danger transition-all"
						>
							Force Stop
						</button>
					)}
				</div>
			</div>
			<div class="mt-3 flex items-center gap-4 text-xs text-text-muted">
				<span title={new Date(gen.createdAt).toLocaleString()}>Loaded {formatRelativeTime(gen.createdAt)}</span>
				<span title="Number of HTTP requests currently being processed by this generation">
					{gen.activeRequests} in-flight request{gen.activeRequests !== 1 ? 's' : ''}
				</span>
			</div>

			{/* DO summary */}
			{gen.durableObjects && gen.durableObjects.length > 0 && (
				<div class="mt-3 flex flex-wrap gap-2">
					{gen.durableObjects.map(d => (
						<span
							key={d.namespace}
							class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-panel-hover text-text-secondary"
							title={`Durable Object class "${d.namespace}": ${d.activeInstances} active instance(s), ${d.totalWebSockets} WebSocket connection(s)`}
						>
							{d.namespace}:
							<span class="font-medium text-ink">{d.activeInstances}</span> instance{d.activeInstances !== 1 ? 's' : ''}
							{d.totalWebSockets > 0 && <span class="text-text-muted">({d.totalWebSockets} ws)</span>}
						</span>
					))}
				</div>
			)}

			{/* Expandable detail */}
			<button
				onClick={() => setExpanded(!expanded)}
				class="mt-2 text-xs text-text-muted hover:text-ink transition-colors"
			>
				{expanded ? 'Hide DO instances' : 'Show DO instances'}
			</button>
			{expanded && detail && (
				<div class="mt-3 border-t border-border pt-3">
					{detail.doNamespaces.length === 0
						? <div class="text-xs text-text-muted">No active Durable Object instances in this generation</div>
						: detail.doNamespaces.map(ns => (
							<div key={ns.namespace} class="mb-3">
								<div class="text-xs font-medium text-text-secondary mb-1">{ns.namespace}</div>
								{ns.instances.length === 0
									? <div class="text-xs text-text-muted ml-2">No active instances</div>
									: (
										<div class="ml-2 space-y-0.5">
											{ns.instances.map(inst => (
												<div key={inst.id} class="text-xs font-mono text-text-data flex items-center gap-2">
													<span class="truncate max-w-[200px]" title={inst.id}>{inst.id}</span>
													{inst.wsCount > 0 && <span class="text-text-muted" title="Active WebSocket connections">{inst.wsCount} ws</span>}
												</div>
											))}
										</div>
									)}
							</div>
						))}
				</div>
			)}
		</div>
	)
}

export function GenerationsView() {
	const { data, refetch } = useQuery('generations.list')
	const reload = useMutation('generations.reload')
	const drain = useMutation('generations.drain')
	const configMutation = useMutation('generations.config')

	const [gracePeriod, setGracePeriod] = useState<string>('')

	useEffect(() => {
		if (data?.gracePeriodMs != null && gracePeriod === '') {
			setGracePeriod(String(data.gracePeriodMs))
		}
	}, [data?.gracePeriodMs])

	// Auto-refresh every 2s
	useEffect(() => {
		const timer = setInterval(refetch, 2000)
		return () => clearInterval(timer)
	}, [refetch])

	const handleReload = useCallback(async (workerName?: string) => {
		await reload.mutate(workerName ? { workerName } : undefined as any)
		refetch()
	}, [reload, refetch])

	const handleStop = useCallback(async (workerName?: string) => {
		await drain.mutate(workerName ? { workerName } : undefined as any)
		refetch()
	}, [drain, refetch])

	const handleGracePeriodSave = useCallback(() => {
		const ms = parseInt(gracePeriod, 10)
		if (Number.isNaN(ms) || ms < 0) return
		configMutation.mutate({ gracePeriodMs: ms })
	}, [gracePeriod, configMutation])

	if (!data) {
		return (
			<div class="p-4 sm:p-8">
				<PageHeader title="Generations" />
				<div class="text-text-muted text-sm text-center py-12">Loading...</div>
			</div>
		)
	}

	const generations = data.generations

	return (
		<div class="p-4 sm:p-8">
			<PageHeader
				title="Generations"
				subtitle={`${generations.length} generation(s)`}
				actions={
					<div class="flex items-center gap-2">
						<div class="flex items-center gap-1" title="How long to wait for in-flight requests to finish before force-stopping an old generation">
							<label class="text-xs text-text-muted">Grace period (ms):</label>
							<input
								type="number"
								value={gracePeriod}
								onInput={e => setGracePeriod((e.target as HTMLInputElement).value)}
								onBlur={handleGracePeriodSave}
								class="bg-panel border border-border rounded-md px-2 py-1 text-xs w-24 outline-none focus:border-border focus:ring-1 focus:ring-border"
							/>
						</div>
						<button
							onClick={() => handleReload()}
							disabled={reload.isLoading}
							class="rounded-md px-3 py-1.5 text-sm font-medium bg-accent-lime text-surface hover:bg-accent-lime/90 disabled:opacity-50 transition-all"
						>
							{reload.isLoading ? 'Reloading...' : 'Reload'}
						</button>
					</div>
				}
			/>

			<p class="text-xs text-text-muted mb-6 max-w-xl leading-relaxed">
				A generation is a snapshot of your worker code at a point in time. When code changes, a new generation is created and the old one is drained
				(finishes in-flight work, then stops). Each request and Durable Object is tied to the generation that was active when it started. The{' '}
				<span class="font-mono">Gen</span> column in Traces shows which generation handled each request.
			</p>

			{generations.length === 0
				? <EmptyState message="No generations yet. Start your dev server to see generations here." />
				: (
					<div class="space-y-4">
						{generations.map(gen => (
							<GenerationCard
								key={gen.id}
								gen={gen}
								onReload={() => handleReload()}
								onStop={(id) => handleStop()}
							/>
						))}
					</div>
				)}

			{/* Multi-worker section */}
			{data.workers && data.workers.length > 0 && (
				<div class="mt-8">
					<h2 class="text-lg font-bold text-ink mb-1">Per-Worker Generations</h2>
					<p class="text-xs text-text-muted mb-4">
						In multi-worker mode, each worker has its own independent generation lifecycle.
					</p>
					{data.workers.map(w => (
						<div key={w.workerName} class="mb-6">
							<div class="flex items-center gap-3 mb-3">
								<h3 class="text-sm font-bold text-ink">{w.workerName}</h3>
								<span class="text-xs text-text-muted">{w.generations.length} generation(s)</span>
								<button
									onClick={() => handleReload(w.workerName)}
									class="rounded-md px-2 py-1 text-xs font-medium bg-panel border border-border text-text-secondary hover:bg-panel-hover transition-all"
								>
									Reload
								</button>
							</div>
							<div class="space-y-3">
								{w.generations.map(gen => (
									<GenerationCard
										key={gen.id}
										gen={gen}
										onReload={() => handleReload(w.workerName)}
										onStop={() => handleStop(w.workerName)}
									/>
								))}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	)
}
