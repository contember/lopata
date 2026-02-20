import { useState } from 'preact/hooks'
import { Breadcrumb, CodeBlock, EmptyState, Modal, PageHeader, RefreshButton, ServiceInfo, StatusBadge, Table, TableLink } from '../components'
import { formatTime } from '../lib'
import { useMutation, useQuery } from '../rpc/hooks'

const WORKFLOW_STATUS_COLORS: Record<string, string> = {
	running: 'bg-blue-500/15 text-blue-400',
	complete: 'bg-emerald-500/15 text-emerald-500',
	errored: 'bg-red-500/15 text-red-500',
	terminated: 'bg-panel-active text-text-data',
	waiting: 'bg-blue-500/15 text-blue-400',
	paused: 'bg-amber-500/15 text-amber-500',
	queued: 'bg-purple-500/15 text-purple-400',
}

export function WorkflowsView({ route }: { route: string }) {
	const parts = route.split('/').filter(Boolean)
	if (parts.length === 1) return <WorkflowList />
	if (parts.length === 2) return <WorkflowInstanceList name={decodeURIComponent(parts[1]!)} />
	if (parts.length >= 3) return <WorkflowInstanceDetail name={decodeURIComponent(parts[1]!)} id={decodeURIComponent(parts[2]!)} />
	return null
}

function WorkflowList() {
	const { data: workflows, refetch } = useQuery('workflows.list')
	const { data: configGroups } = useQuery('config.forService', { type: 'workflows' })

	const totalInstances = workflows?.reduce((s, w) => s + w.total, 0) ?? 0
	const totalRunning = workflows?.reduce((s, w) => s + (w.byStatus.running ?? 0), 0) ?? 0
	const totalErrored = workflows?.reduce((s, w) => s + (w.byStatus.errored ?? 0), 0) ?? 0

	return (
		<div class="p-4 sm:p-8 max-w-6xl">
			<PageHeader title="Workflows" subtitle={`${workflows?.length ?? 0} workflow(s)`} actions={<RefreshButton onClick={refetch} />} />
			<div class="flex flex-col lg:flex-row gap-6 items-start">
				<div class="flex-1 min-w-0">
					{!workflows?.length ? <EmptyState message="No workflow instances found" /> : (
						<Table
							headers={['Workflow', 'Total', 'Running', 'Complete', 'Errored']}
							rows={workflows.map(w => [
								<TableLink href={`#/workflows/${encodeURIComponent(w.name)}`}>{w.name}</TableLink>,
								<span class="tabular-nums">{w.total}</span>,
								w.byStatus.running ?? 0,
								w.byStatus.complete ?? 0,
								w.byStatus.errored ?? 0,
							])}
						/>
					)}
				</div>
				<ServiceInfo
					description="Durable execution engine for multi-step tasks."
					stats={[
						{ label: 'Instances', value: totalInstances.toLocaleString() },
						{ label: 'Running', value: totalRunning.toLocaleString() },
						{ label: 'Errored', value: totalErrored.toLocaleString() },
					]}
					configGroups={configGroups}
					links={[
						{ label: 'Documentation', href: 'https://developers.cloudflare.com/workflows/' },
						{ label: 'API Reference', href: 'https://developers.cloudflare.com/api/resources/workflows/' },
					]}
				/>
			</div>
		</div>
	)
}

function CreateWorkflowForm({ name, onCreated }: { name: string; onCreated: (id: string) => void }) {
	const [open, setOpen] = useState(false)
	const [params, setParams] = useState('{}')
	const [error, setError] = useState('')
	const create = useMutation('workflows.create')

	const handleSubmit = async () => {
		setError('')
		const result = await create.mutate({ name, params })
		if (result) {
			setParams('{}')
			setOpen(false)
			onCreated(result.id)
		} else if (create.error) {
			setError(create.error.message)
		}
	}

	const handleClose = () => {
		setOpen(false)
		setError('')
	}

	return (
		<>
			<button
				onClick={() => setOpen(true)}
				class="rounded-md px-3 py-1.5 text-sm font-medium bg-ink text-surface hover:opacity-80 transition-all"
			>
				Create instance
			</button>
			{open && (
				<Modal title="Create workflow instance" onClose={handleClose}>
					<div class="p-5">
						<textarea
							value={params}
							onInput={e => setParams((e.target as HTMLTextAreaElement).value)}
							placeholder='{"key": "value"}'
							class="w-full bg-panel-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-border focus:ring-1 focus:ring-border transition-all resize-y min-h-[80px]"
							rows={3}
						/>
						{error && <div class="text-red-500 text-xs mt-1">{error}</div>}
						<div class="flex justify-end mt-3">
							<button
								onClick={handleSubmit}
								disabled={create.isLoading || !params.trim()}
								class="rounded-md px-4 py-1.5 text-sm font-medium bg-ink text-surface hover:opacity-80 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{create.isLoading ? 'Creating...' : 'Create'}
							</button>
						</div>
					</div>
				</Modal>
			)}
		</>
	)
}

function ActionButton(
	{ onClick, label, color = 'blue', disabled }: {
		onClick: () => void
		label: string
		color?: 'blue' | 'red' | 'amber' | 'emerald'
		disabled?: boolean
	},
) {
	const colors = {
		blue: 'text-blue-400 hover:text-blue-300 hover:bg-blue-500/10',
		red: 'text-red-400 hover:text-red-300 hover:bg-red-500/10',
		amber: 'text-amber-500 hover:text-amber-400 hover:bg-amber-500/10',
		emerald: 'text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10',
	}
	return (
		<button
			onClick={onClick}
			disabled={disabled}
			class={`text-xs font-medium rounded-md px-2 py-1 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${colors[color]}`}
		>
			{label}
		</button>
	)
}

function InstanceActions(
	{ name, id, status, refetch, onDuplicated }: { name: string; id: string; status: string; refetch: () => void; onDuplicated?: (id: string) => void },
) {
	const pause = useMutation('workflows.pause')
	const resume = useMutation('workflows.resume')
	const terminate = useMutation('workflows.terminate')
	const restart = useMutation('workflows.restart')
	const duplicate = useMutation('workflows.duplicate')

	const handlePause = async () => {
		await pause.mutate({ name, id })
		refetch()
	}
	const handleResume = async () => {
		await resume.mutate({ name, id })
		refetch()
	}
	const handleTerminate = async () => {
		if (!confirm('Terminate this workflow instance?')) return
		await terminate.mutate({ name, id })
		refetch()
	}
	const handleRestart = async () => {
		if (!confirm('Restart this workflow instance? All steps will re-execute.')) return
		await restart.mutate({ name, id })
		refetch()
	}
	const handleDuplicate = async () => {
		const result = await duplicate.mutate({ name, id })
		if (result && onDuplicated) onDuplicated(result.id)
		else refetch()
	}

	const isTerminal = ['complete', 'errored', 'terminated'].includes(status)

	return (
		<div class="flex gap-1">
			{(status === 'running' || status === 'waiting') && (
				<>
					<ActionButton onClick={handlePause} label="Pause" color="amber" />
					<ActionButton onClick={handleTerminate} label="Terminate" color="red" />
				</>
			)}
			{status === 'paused' && (
				<>
					<ActionButton onClick={handleResume} label="Resume" color="emerald" />
					<ActionButton onClick={handleTerminate} label="Terminate" color="red" />
				</>
			)}
			{status === 'queued' && <ActionButton onClick={handleTerminate} label="Terminate" color="red" />}
			{isTerminal && (
				<>
					<ActionButton onClick={handleRestart} label="Restart" color="blue" />
					<ActionButton onClick={handleDuplicate} label="Duplicate" color="blue" />
				</>
			)}
		</div>
	)
}

function WorkflowInstanceList({ name }: { name: string }) {
	const [statusFilter, setStatusFilter] = useState('')
	const { data: instances, refetch } = useQuery('workflows.listInstances', { name, status: statusFilter || undefined })

	const handleCreated = (_id: string) => {
		refetch()
	}
	const handleDuplicated = (id: string) => {
		location.hash = `#/workflows/${encodeURIComponent(name)}/${encodeURIComponent(id)}`
	}

	return (
		<div class="p-4 sm:p-8">
			<Breadcrumb items={[{ label: 'Workflows', href: '#/workflows' }, { label: name }]} />
			<div class="mb-6 flex gap-2 items-center justify-between">
				<select
					value={statusFilter}
					onChange={e => setStatusFilter((e.target as HTMLSelectElement).value)}
					class="bg-panel border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-border focus:ring-1 focus:ring-border transition-all appearance-none pr-10"
				>
					<option value="">All statuses</option>
					<option value="running">Running</option>
					<option value="waiting">Waiting</option>
					<option value="paused">Paused</option>
					<option value="queued">Queued</option>
					<option value="complete">Complete</option>
					<option value="errored">Errored</option>
					<option value="terminated">Terminated</option>
				</select>
				<div class="flex gap-2 items-center">
					<RefreshButton onClick={refetch} />
					<CreateWorkflowForm name={name} onCreated={handleCreated} />
				</div>
			</div>
			{!instances?.length ? <EmptyState message="No instances found" /> : (
				<Table
					headers={['Instance ID', 'Status', 'Created', 'Updated', '']}
					rows={instances.map(inst => [
						<TableLink href={`#/workflows/${encodeURIComponent(name)}/${encodeURIComponent(inst.id)}`} mono>{inst.id.slice(0, 16)}...</TableLink>,
						<StatusBadge status={inst.status} colorMap={WORKFLOW_STATUS_COLORS} />,
						formatTime(inst.created_at),
						formatTime(inst.updated_at),
						<InstanceActions name={name} id={inst.id} status={inst.status} refetch={refetch} onDuplicated={handleDuplicated} />,
					])}
				/>
			)}
		</div>
	)
}

function SkipSleepBanner(
	{ name, id, activeSleep, refetch }: { name: string; id: string; activeSleep: { stepName: string; until: number }; refetch: () => void },
) {
	const skipSleep = useMutation('workflows.skipSleep')
	const remaining = Math.max(0, activeSleep.until - Date.now())
	const label = activeSleep.stepName.replace(/^(sleep|sleepUntil):/, '')

	const formatRemaining = (ms: number) => {
		if (ms < 1000) return '< 1s'
		const s = Math.floor(ms / 1000)
		if (s < 60) return `${s}s`
		const m = Math.floor(s / 60)
		if (m < 60) return `${m}m ${s % 60}s`
		const h = Math.floor(m / 60)
		return `${h}h ${m % 60}m`
	}

	const handleSkip = async () => {
		await skipSleep.mutate({ name, id })
		refetch()
	}

	return (
		<div class="mb-6 bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex items-center justify-between">
			<div>
				<span class="text-sm font-semibold text-amber-500">Sleeping</span>
				<span class="text-sm text-amber-400 ml-2">
					step "{label}" — {formatRemaining(remaining)} remaining
				</span>
			</div>
			<button
				onClick={handleSkip}
				disabled={skipSleep.isLoading}
				class="rounded-md px-3 py-1.5 text-sm font-medium bg-amber-600 text-white hover:bg-amber-700 transition-all disabled:opacity-50"
			>
				{skipSleep.isLoading ? 'Skipping...' : 'Skip sleep'}
			</button>
		</div>
	)
}

function SendEventForm({ name, id, waitingForEvents, refetch }: { name: string; id: string; waitingForEvents: string[]; refetch: () => void }) {
	const [eventType, setEventType] = useState(waitingForEvents[0] ?? '')
	const [payload, setPayload] = useState('{}')
	const [error, setError] = useState('')
	const sendEvent = useMutation('workflows.sendEvent')

	const handleSend = async () => {
		setError('')
		try {
			JSON.parse(payload) // validate JSON
		} catch {
			setError('Invalid JSON payload')
			return
		}
		const result = await sendEvent.mutate({ name, id, type: eventType, payload })
		if (result) {
			setPayload('{}')
			refetch()
		} else if (sendEvent.error) {
			setError(sendEvent.error.message)
		}
	}

	return (
		<div class="mb-6 bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
			<div class="text-sm font-semibold text-blue-400 mb-3">
				Waiting for event{waitingForEvents.length > 0 && (
					<span class="font-normal text-link">
						{' '}— type: {waitingForEvents.map(t => `"${t}"`).join(', ')}
					</span>
				)}
			</div>
			<div class="flex gap-3 items-start">
				<div class="flex-1">
					<input
						type="text"
						value={eventType}
						onInput={e => setEventType((e.target as HTMLInputElement).value)}
						placeholder="Event type"
						class="w-full bg-panel-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-border focus:ring-1 focus:ring-border transition-all mb-2"
					/>
					<textarea
						value={payload}
						onInput={e => setPayload((e.target as HTMLTextAreaElement).value)}
						placeholder='{"key": "value"}'
						class="w-full bg-panel-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-border focus:ring-1 focus:ring-border transition-all resize-y min-h-[60px]"
						rows={2}
					/>
					{error && <div class="text-red-500 text-xs mt-1">{error}</div>}
				</div>
				<button
					onClick={handleSend}
					disabled={sendEvent.isLoading || !eventType.trim()}
					class="rounded-md px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
				>
					{sendEvent.isLoading ? 'Sending...' : 'Send event'}
				</button>
			</div>
		</div>
	)
}

function WorkflowInstanceDetail({ name, id }: { name: string; id: string }) {
	const { data, refetch } = useQuery('workflows.getInstance', { name, id })
	const restartFromStep = useMutation('workflows.restart')

	const handleDuplicated = (newId: string) => {
		location.hash = `#/workflows/${encodeURIComponent(name)}/${encodeURIComponent(newId)}`
	}

	const handleRestartFromStep = async (stepName: string) => {
		if (!confirm(`Restart from step "${stepName}"? This step and all subsequent steps will re-execute.`)) return
		await restartFromStep.mutate({ name, id, fromStep: stepName })
		refetch()
	}

	if (!data) return <div class="p-4 sm:p-8 text-text-muted font-medium">Loading...</div>

	const isTerminal = ['complete', 'errored', 'terminated'].includes(data.status)

	return (
		<div class="p-4 sm:p-8">
			<Breadcrumb
				items={[
					{ label: 'Workflows', href: '#/workflows' },
					{ label: name, href: `#/workflows/${encodeURIComponent(name)}` },
					{ label: id.slice(0, 16) + '...' },
				]}
			/>

			<div class="flex items-center gap-4 mb-8">
				<StatusBadge status={data.status} colorMap={WORKFLOW_STATUS_COLORS} />
				<span class="text-sm text-text-muted font-medium">Created: {formatTime(data.created_at)}</span>
				<InstanceActions name={name} id={id} status={data.status} refetch={refetch} onDuplicated={handleDuplicated} />
				<RefreshButton onClick={refetch} />
			</div>

			{data.activeSleep && <SkipSleepBanner name={name} id={id} activeSleep={data.activeSleep} refetch={refetch} />}

			{data.status === 'waiting' && <SendEventForm name={name} id={id} waitingForEvents={data.waitingForEvents} refetch={refetch} />}

			{data.params && (
				<div class="mb-6 bg-panel rounded-lg border border-border p-5">
					<h3 class="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Parameters</h3>
					<CodeBlock>{data.params}</CodeBlock>
				</div>
			)}

			{data.output && (
				<div class="mb-6 bg-panel rounded-lg border border-border p-5">
					<h3 class="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Output</h3>
					<CodeBlock>{data.output}</CodeBlock>
				</div>
			)}

			{data.error && (
				<div class="mb-6 bg-panel rounded-lg border border-border p-5">
					<h3 class="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Error</h3>
					<pre class="bg-red-500/10 rounded-lg p-4 text-xs text-red-400 overflow-x-auto font-mono">{data.error}</pre>
				</div>
			)}

			<div class="mb-6">
				<h3 class="text-sm font-semibold text-ink mb-4">Steps ({data.steps.length})</h3>
				{data.steps.length === 0 && data.stepAttempts.length === 0
					? <div class="text-text-muted text-sm font-medium">No steps completed yet</div>
					: (
						<Table
							headers={['Step', 'Output', 'Completed', ...(isTerminal ? [''] : [])]}
							rows={[
								...data.steps.map(s => {
									const row = [
										<span class="font-mono text-xs font-medium">{s.step_name}</span>,
										s.output ? <pre class="text-xs max-w-md truncate font-mono">{s.output}</pre> : '\u2014',
										formatTime(s.completed_at),
									]
									if (isTerminal) {
										row.push(
											<ActionButton onClick={() => handleRestartFromStep(s.step_name)} label="Restart from here" color="blue" />,
										)
									}
									return row
								}),
								...data.stepAttempts.map(a => {
									const errorContent = a.last_error
										? (
											a.last_error_id
												? (
													<a
														href={`#/errors/${encodeURIComponent(a.last_error_id)}`}
														class="text-xs max-w-md truncate font-mono text-red-600 dark:text-red-400 hover:underline block"
														title={a.last_error}
													>
														{a.last_error_name ? `${a.last_error_name}: ` : ''}
														{a.last_error}
													</a>
												)
												: (
													<pre class="text-xs max-w-md truncate font-mono text-red-600 dark:text-red-400" title={a.last_error}>
                      {a.last_error_name ? `${a.last_error_name}: ` : ""}{a.last_error}
													</pre>
												)
										)
										: '\u2014'
									const row = [
										<span class="font-mono text-xs font-medium">
											{a.step_name}
											<span class="ml-2 text-amber-600 dark:text-amber-400 text-[10px] font-semibold uppercase">retrying ({a.failed_attempts}x failed)</span>
										</span>,
										errorContent,
										a.updated_at ? formatTime(a.updated_at) : '\u2014',
									]
									if (isTerminal) {
										row.push('')
									}
									return row
								}),
							]}
						/>
					)}
			</div>

			{data.events.length > 0 && (
				<div>
					<h3 class="text-sm font-semibold text-ink mb-4">Events ({data.events.length})</h3>
					<Table
						headers={['Type', 'Payload', 'Time']}
						rows={data.events.map(e => [
							<span class="font-mono text-xs font-medium">{e.event_type}</span>,
							e.payload ? <pre class="text-xs max-w-md truncate font-mono">{e.payload}</pre> : '\u2014',
							formatTime(e.created_at),
						])}
					/>
				</div>
			)}
		</div>
	)
}
