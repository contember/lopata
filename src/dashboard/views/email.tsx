import { useState } from 'preact/hooks'
import { DeleteButton, EmptyState, Modal, PageHeader, PillButton, RefreshButton, ServiceInfo, StatusBadge, Table } from '../components'
import { formatTime } from '../lib'
import { useMutation, useQuery } from '../rpc/hooks'

const EMAIL_STATUS_COLORS: Record<string, string> = {
	sent: 'bg-blue-500/15 text-blue-500',
	received: 'bg-emerald-500/15 text-emerald-500',
	forwarded: 'bg-purple-500/15 text-purple-500',
	rejected: 'bg-red-500/15 text-red-500',
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function EmailView({ route }: { route: string }) {
	const parts = route.split('/').filter(Boolean)
	if (parts.length >= 2) return <EmailDetail id={parts[1]!} />
	return <EmailList />
}

function SendEmailModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
	const [from, setFrom] = useState('sender@example.com')
	const [to, setTo] = useState('recipient@example.com')
	const [subject, setSubject] = useState('')
	const [body, setBody] = useState('')
	const [error, setError] = useState('')
	const trigger = useMutation('email.trigger')

	const handleSubmit = async () => {
		setError('')
		const result = await trigger.mutate({ from, to, subject, body })
		if (result) {
			onClose()
			onSent()
		} else if (trigger.error) {
			setError(trigger.error.message)
		}
	}

	return (
		<Modal title="Send test email" onClose={onClose}>
			<div class="p-5 space-y-3">
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="block text-xs text-text-muted mb-1">From</label>
						<input
							value={from}
							onInput={e => setFrom((e.target as HTMLInputElement).value)}
							class="w-full bg-panel-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-border focus:ring-1 focus:ring-border transition-all"
						/>
					</div>
					<div>
						<label class="block text-xs text-text-muted mb-1">To</label>
						<input
							value={to}
							onInput={e => setTo((e.target as HTMLInputElement).value)}
							class="w-full bg-panel-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-border focus:ring-1 focus:ring-border transition-all"
						/>
					</div>
				</div>
				<div>
					<label class="block text-xs text-text-muted mb-1">Subject</label>
					<input
						value={subject}
						onInput={e => setSubject((e.target as HTMLInputElement).value)}
						placeholder="Test email"
						class="w-full bg-panel-secondary border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-border focus:ring-1 focus:ring-border transition-all"
					/>
				</div>
				<div>
					<label class="block text-xs text-text-muted mb-1">Body</label>
					<textarea
						value={body}
						onInput={e => setBody((e.target as HTMLTextAreaElement).value)}
						placeholder="Email body..."
						class="w-full bg-panel-secondary border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-border focus:ring-1 focus:ring-border transition-all resize-y min-h-[80px]"
						rows={3}
					/>
				</div>
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
					disabled={trigger.isLoading || !from.trim() || !to.trim()}
					class="rounded-md px-4 py-1.5 text-sm font-medium bg-ink text-surface hover:opacity-80 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{trigger.isLoading ? 'Sending...' : 'Send'}
				</button>
			</div>
		</Modal>
	)
}

function EmailList() {
	const [filter, setFilter] = useState('')
	const [formOpen, setFormOpen] = useState(false)
	const { data: emails, refetch } = useQuery('email.list', { status: filter || undefined })
	const { data: stats } = useQuery('email.stats')
	const { data: configGroups } = useQuery('config.forService', { type: 'email' })
	const deleteEmail = useMutation('email.delete')

	const handleDelete = async (id: string) => {
		if (!confirm('Delete this email?')) return
		await deleteEmail.mutate({ id })
		refetch()
	}

	return (
		<div class="p-4 sm:p-8">
			<PageHeader title="Email" subtitle={`${stats?.total ?? 0} email(s)`} actions={<RefreshButton onClick={refetch} />} />
			<div class="flex flex-col lg:flex-row gap-6 items-start">
				<div class="flex-1 min-w-0">
					<div class="mb-6 flex gap-2 items-center justify-between">
						<div class="flex gap-2">
							{['', 'received', 'sent', 'forwarded', 'rejected'].map(s => (
								<PillButton key={s} onClick={() => setFilter(s)} active={filter === s}>
									{s || 'All'}
								</PillButton>
							))}
						</div>
						<button
							onClick={() => setFormOpen(true)}
							class="rounded-md px-3 py-1.5 text-sm font-medium bg-ink text-surface hover:opacity-80 transition-all"
						>
							Send test email
						</button>
					</div>
					{formOpen && <SendEmailModal onClose={() => setFormOpen(false)} onSent={refetch} />}
					{!emails?.length ? <EmptyState message="No emails found" /> : (
						<Table
							headers={['From', 'To', 'Status', 'Size', 'Binding', 'Time', '']}
							rows={emails.map(e => [
								<a href={`#/email/${e.id}`} class="font-mono text-xs text-link hover:underline">{e.from_addr}</a>,
								<span class="font-mono text-xs">{e.to_addr}</span>,
								<StatusBadge status={e.status} colorMap={EMAIL_STATUS_COLORS} />,
								<span class="text-xs text-text-muted tabular-nums">{formatBytes(e.raw_size)}</span>,
								<span class="text-xs text-text-muted font-mono">
									{e.binding === '_incoming' ? 'incoming' : e.binding === '_forward' ? 'forward' : e.binding === '_reply' ? 'reply' : e.binding}
								</span>,
								<span class="text-xs text-text-muted">{formatTime(e.created_at)}</span>,
								<DeleteButton onClick={() => handleDelete(e.id)} />,
							])}
						/>
					)}
				</div>
				<ServiceInfo
					description="Email handler for processing incoming emails and send_email bindings for sending."
					stats={[
						{ label: 'Total', value: stats?.total ?? 0 },
						...(stats?.byStatus ? Object.entries(stats.byStatus).map(([k, v]) => ({ label: k, value: v })) : []),
					]}
					configGroups={configGroups}
					links={[
						{ label: 'Email Workers', href: 'https://developers.cloudflare.com/email-routing/email-workers/' },
						{ label: 'Send Email', href: 'https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/' },
					]}
				/>
			</div>
		</div>
	)
}

function EmailDetail({ id }: { id: string }) {
	const { data } = useQuery('email.get', { id })

	if (!data) {
		return (
			<div class="p-4 sm:p-8">
				<a href="#/email" class="text-sm text-link hover:underline mb-4 inline-block">Back to emails</a>
				<EmptyState message="Email not found" />
			</div>
		)
	}

	const { record, raw } = data

	return (
		<div class="p-4 sm:p-8 max-w-4xl">
			<a href="#/email" class="text-sm text-link hover:underline mb-4 inline-block">Back to emails</a>
			<div class="bg-panel border border-border rounded-lg p-6">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-ink">Email Detail</h2>
					<StatusBadge status={record.status} colorMap={EMAIL_STATUS_COLORS} />
				</div>
				<div class="grid grid-cols-2 gap-4 mb-4 text-sm">
					<div>
						<span class="text-text-muted">From:</span> <span class="font-mono">{record.from_addr}</span>
					</div>
					<div>
						<span class="text-text-muted">To:</span> <span class="font-mono">{record.to_addr}</span>
					</div>
					<div>
						<span class="text-text-muted">Binding:</span> <span class="font-mono">{record.binding}</span>
					</div>
					<div>
						<span class="text-text-muted">Size:</span> <span class="tabular-nums">{formatBytes(record.raw_size)}</span>
					</div>
					<div>
						<span class="text-text-muted">Time:</span> {formatTime(record.created_at)}
					</div>
					{record.reject_reason && (
						<div>
							<span class="text-text-muted">Reject reason:</span> <span class="text-red-600">{record.reject_reason}</span>
						</div>
					)}
				</div>
				<div>
					<div class="text-xs text-text-muted mb-2">Raw content</div>
					<pre class="bg-panel-secondary border border-border rounded-lg p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">{raw}</pre>
				</div>
			</div>
		</div>
	)
}
