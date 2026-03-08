import { useEffect, useRef, useState } from 'preact/hooks'
import { EmptyState, PageHeader, StatusBadge, Table } from '../components'
import { useQuery } from '../rpc/hooks'

const STATUS_COLORS: Record<string, string> = {
	ok: 'bg-emerald-500/15 text-emerald-500',
	missing: 'bg-red-500/15 text-red-500',
	wrong_address: 'bg-red-500/15 text-red-500',
	wildcard: 'bg-yellow-500/15 text-yellow-500',
}

const STATUS_LABELS: Record<string, string> = {
	ok: 'ok',
	missing: 'missing',
	wrong_address: 'wrong address',
	wildcard: 'wildcard',
}

function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false)
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current)
		}
	}, [])

	const handleCopy = () => {
		navigator.clipboard.writeText(text).then(() => {
			setCopied(true)
			if (timerRef.current) clearTimeout(timerRef.current)
			timerRef.current = setTimeout(() => setCopied(false), 2000)
		})
	}

	return (
		<button
			onClick={handleCopy}
			class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded-md border border-border bg-panel hover:bg-panel-hover text-text-secondary hover:text-ink transition-colors"
		>
			{copied
				? (
					<>
						<svg class="w-3.5 h-3.5 text-emerald-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M3 8.5l3 3 7-7" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
						Copied!
					</>
				)
				: (
					<>
						<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
							<rect x="5" y="5" width="8" height="8" rx="1" stroke-linecap="round" stroke-linejoin="round" />
							<path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
						{label}
					</>
				)}
		</button>
	)
}

export function HostsView() {
	const { data } = useQuery('hosts.check')

	const results = data?.results ?? []
	const failing = results.filter(r => r.status === 'missing' || r.status === 'wrong_address')
	const missingHostnames = [...new Set(failing.map(r => r.hostname))]

	const hostsLine = `127.0.0.1  ${missingHostnames.join(' ')}`
	const fixCommand = data?.hostsFilePath
		? `sudo sh -c 'echo "${hostsLine}" >> ${data.hostsFilePath}'`
		: ''

	return (
		<div class="p-4 sm:p-8">
			<PageHeader title="Hosts Check" subtitle={data?.hostsFilePath ? `Reading ${data.hostsFilePath}` : 'Checking host routing setup'} />

			{data?.error
				? <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{data.error}</div>
				: !results.length
				? <EmptyState message="No host routing configured. Add hosts to workers in lopata.config.ts." />
				: (
					<>
						<Table
							headers={['Hostname', 'Worker', 'Address', 'Status']}
							rows={results.map(r => [
								<span class="font-mono text-xs font-medium">{r.hostname}</span>,
								<span class="text-text-secondary">{r.workerName}</span>,
								<span class="font-mono text-xs text-text-secondary">
									{r.status === 'ok' ? r.address : r.status === 'wrong_address' ? r.address : '\u2014'}
								</span>,
								<StatusBadge status={STATUS_LABELS[r.status] ?? r.status} colorMap={STATUS_COLORS} />,
							])}
						/>

						{missingHostnames.length > 0 && (
							<div class="mt-6 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
								<div class="text-sm font-medium text-yellow-500 mb-2">Missing hosts file entries</div>
								<div class="text-xs text-text-secondary mb-3">
									Modifying the hosts file requires root privileges. Copy the command below and run it in your terminal:
								</div>
								<div class="flex items-stretch gap-2">
									<pre class="flex-1 text-xs font-mono bg-surface p-3 rounded border border-border select-all overflow-x-auto">{fixCommand}</pre>
									<CopyButton text={fixCommand} label="Copy command" />
								</div>
								<div class="mt-3 text-[11px] text-text-muted">
									Or manually add this line to {data?.hostsFilePath}:
								</div>
								<div class="flex items-stretch gap-2 mt-1">
									<pre class="flex-1 text-xs font-mono bg-surface p-3 rounded border border-border select-all">{hostsLine}</pre>
									<CopyButton text={hostsLine} label="Copy line" />
								</div>
							</div>
						)}
					</>
				)}
		</div>
	)
}
