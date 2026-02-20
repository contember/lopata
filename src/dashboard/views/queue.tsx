import { useState } from 'preact/hooks'
import {
	Breadcrumb,
	DeleteButton,
	EmptyState,
	Modal,
	PageHeader,
	PillButton,
	RefreshButton,
	ServiceInfo,
	StatusBadge,
	Table,
	TableLink,
} from '../components'
import { formatTime } from '../lib'
import { useMutation, useQuery } from '../rpc/hooks'

const QUEUE_STATUS_COLORS: Record<string, string> = {
	pending: 'bg-amber-500/15 text-amber-500',
	acked: 'bg-emerald-500/15 text-emerald-500',
	failed: 'bg-red-500/15 text-red-500',
}

export function QueueView({ route }: { route: string }) {
	const parts = route.split('/').filter(Boolean)
	if (parts.length === 1) return <QueueList />
	if (parts.length >= 2) return <QueueMessages name={decodeURIComponent(parts[1]!)} />
	return null
}

function QueueList() {
	const { data: queues, refetch } = useQuery('queue.listQueues')
	const { data: configGroups } = useQuery('config.forService', { type: 'queue' })

	const totalPending = queues?.reduce((s, q) => s + q.pending, 0) ?? 0
	const totalAcked = queues?.reduce((s, q) => s + q.acked, 0) ?? 0
	const totalFailed = queues?.reduce((s, q) => s + q.failed, 0) ?? 0

	return (
		<div class="p-8 max-w-6xl">
			<PageHeader title="Queues" subtitle={`${queues?.length ?? 0} queue(s)`} actions={<RefreshButton onClick={refetch} />} />
			<div class="flex gap-6 items-start">
				<div class="flex-1 min-w-0">
					{!queues?.length ? <EmptyState message="No queues found" /> : (
						<Table
							headers={['Queue', 'Pending', 'Acked', 'Failed']}
							rows={queues.map(q => [
								<TableLink href={`#/queue/${encodeURIComponent(q.queue)}`}>{q.queue}</TableLink>,
								<span class="tabular-nums">{q.pending}</span>,
								<span class="tabular-nums">{q.acked}</span>,
								<span class="tabular-nums">{q.failed}</span>,
							])}
						/>
					)}
				</div>
				<ServiceInfo
					description="Message queues for asynchronous task processing."
					stats={[
						{ label: 'Pending', value: totalPending.toLocaleString() },
						{ label: 'Processed', value: totalAcked.toLocaleString() },
						{ label: 'Failed', value: totalFailed.toLocaleString() },
						{ label: 'Queues', value: queues?.length ?? 0 },
					]}
					configGroups={configGroups}
					links={[
						{ label: 'Documentation', href: 'https://developers.cloudflare.com/queues/' },
						{ label: 'API Reference', href: 'https://developers.cloudflare.com/api/resources/queues/' },
					]}
				/>
			</div>
		</div>
	)
}

function PublishModal({ queue, onClose, onPublished }: { queue: string; onClose: () => void; onPublished: () => void }) {
	const [body, setBody] = useState('')
	const [contentType, setContentType] = useState('json')
	const [error, setError] = useState('')
	const publish = useMutation('queue.publishMessage')

	const handleSubmit = async () => {
		setError('')
		const result = await publish.mutate({ queue, body, contentType })
		if (result) {
			onClose()
			onPublished()
		} else if (publish.error) {
			setError(publish.error.message)
		}
	}

	return (
		<Modal title="Publish message" onClose={onClose}>
			<div class="p-5 space-y-3">
				<div class="flex gap-2">
					{['json', 'text'].map(ct => (
						<PillButton key={ct} onClick={() => setContentType(ct)} active={contentType === ct}>
							{ct.toUpperCase()}
						</PillButton>
					))}
				</div>
				<textarea
					value={body}
					onInput={e => setBody((e.target as HTMLTextAreaElement).value)}
					placeholder={contentType === 'json' ? '{"key": "value"}' : 'Message body...'}
					class="w-full bg-panel-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-border focus:ring-1 focus:ring-border transition-all resize-y min-h-[80px]"
					rows={3}
				/>
				{error && <div class="text-red-500 text-xs">{error}</div>}
			</div>
			<div class="flex justify-end gap-2 px-5 py-4 border-t border-border-subtle">
				<button
					onClick={onClose}
					class="rounded-md px-3 py-1.5 text-sm font-medium bg-panel border border-border text-text-secondary hover:bg-panel-hover transition-all"
				>
					Cancel
				</button>
				<button
					onClick={handleSubmit}
					disabled={publish.isLoading || !body.trim()}
					class="rounded-md px-4 py-1.5 text-sm font-medium bg-ink text-surface hover:opacity-80 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{publish.isLoading ? 'Publishing...' : 'Publish'}
				</button>
			</div>
		</Modal>
	)
}

function RequeueButton({ onClick }: { onClick: () => void }) {
	return (
		<button onClick={onClick} class="text-amber-500 hover:text-amber-400 text-xs font-medium rounded-md px-2 py-1 hover:bg-amber-500/10 transition-all">
			Requeue
		</button>
	)
}

function QueueMessages({ name }: { name: string }) {
	const [filter, setFilter] = useState('')
	const [showPublish, setShowPublish] = useState(false)
	const { data: messages, refetch } = useQuery('queue.listMessages', { queue: name, status: filter || undefined })
	const deleteMsg = useMutation('queue.deleteMessage')
	const requeueMsg = useMutation('queue.requeueMessage')

	const handleDelete = async (id: string) => {
		if (!confirm('Delete this message?')) return
		await deleteMsg.mutate({ queue: name, id })
		refetch()
	}

	const handleRequeue = async (id: string) => {
		await requeueMsg.mutate({ queue: name, id })
		refetch()
	}

	return (
		<div class="p-8">
			<Breadcrumb items={[{ label: 'Queues', href: '#/queue' }, { label: name }]} />
			<div class="mb-6 flex gap-2 items-center justify-between">
				<div class="flex gap-2">
					{['', 'pending', 'acked', 'failed'].map(s => (
						<PillButton key={s} onClick={() => setFilter(s)} active={filter === s}>
							{s || 'All'}
						</PillButton>
					))}
				</div>
				<div class="flex gap-2 items-center">
					<RefreshButton onClick={refetch} />
					<button
						onClick={() => setShowPublish(true)}
						class="rounded-md px-3 py-1.5 text-sm font-medium bg-ink text-surface hover:opacity-80 transition-all"
					>
						Publish message
					</button>
				</div>
			</div>
			{showPublish && (
				<PublishModal
					queue={name}
					onClose={() => setShowPublish(false)}
					onPublished={refetch}
				/>
			)}
			{!messages?.length ? <EmptyState message="No messages found" /> : (
				<Table
					headers={['ID', 'Body', 'Status', 'Attempts', 'Created', 'Completed', '']}
					rows={messages.map(m => [
						<span class="font-mono text-xs">{m.id.slice(0, 12)}...</span>,
						<pre class="text-xs max-w-md truncate font-mono">{m.body}</pre>,
						<StatusBadge status={m.status} colorMap={QUEUE_STATUS_COLORS} />,
						m.attempts,
						formatTime(m.created_at),
						m.completed_at ? formatTime(m.completed_at) : '—',
						<div class="flex gap-1">
							{m.status !== 'pending' && <RequeueButton onClick={() => handleRequeue(m.id)} />}
							<DeleteButton onClick={() => handleDelete(m.id)} />
						</div>,
					])}
				/>
			)}
		</div>
	)
}
