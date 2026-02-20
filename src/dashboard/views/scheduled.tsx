import { useState } from 'preact/hooks'
import { EmptyState, PageHeader, RefreshButton, ServiceInfo, Table } from '../components'
import { useMutation, useQuery } from '../rpc/hooks'

export function ScheduledView({ route }: { route: string }) {
	return <ScheduledList />
}

function ScheduledList() {
	const { data: triggers, refetch } = useQuery('scheduled.listTriggers')
	const { data: configGroups } = useQuery('config.forService', { type: 'scheduled' })
	const runNow = useMutation('scheduled.trigger')
	const [runningCron, setRunningCron] = useState<string | null>(null)
	const [lastResult, setLastResult] = useState<{ cron: string; ok: boolean; error?: string } | null>(null)

	const handleRun = async (cron: string, workerName: string | null) => {
		setRunningCron(cron)
		setLastResult(null)
		const result = await runNow.mutate({ cron, workerName })
		setRunningCron(null)
		if (result) {
			setLastResult({ cron, ok: true })
		} else if (runNow.error) {
			setLastResult({ cron, ok: false, error: runNow.error.message })
		}
	}

	return (
		<div class="p-8 max-w-6xl">
			<PageHeader title="Scheduled" subtitle={`${triggers?.length ?? 0} cron trigger(s)`} actions={<RefreshButton onClick={refetch} />} />

			{lastResult && (
				<div
					class={`mb-6 px-4 py-3 rounded-lg text-sm font-medium ${
						lastResult.ok
							? 'bg-emerald-500/10 text-emerald-500'
							: 'bg-red-500/10 text-red-500'
					}`}
				>
					{lastResult.ok
						? `Triggered "${lastResult.cron}" successfully`
						: `Failed to trigger "${lastResult.cron}": ${lastResult.error}`}
				</div>
			)}

			<div class="flex gap-6 items-start">
				<div class="flex-1 min-w-0">
					{!triggers?.length ? <EmptyState message="No scheduled triggers configured" /> : (
						<Table
							headers={['Cron Expression', 'Schedule', ...(triggers.some(t => t.workerName) ? ['Worker'] : []), '']}
							rows={triggers.map(t => {
								const row = [
									<span class="font-mono text-xs font-medium">{t.expression}</span>,
									<span class="text-sm text-text-secondary">{t.description}</span>,
								]
								if (triggers.some(t => t.workerName)) {
									row.push(
										<span class="text-xs text-text-muted font-mono">{t.workerName ?? 'main'}</span>,
									)
								}
								row.push(
									<button
										onClick={() => handleRun(t.expression, t.workerName)}
										disabled={runningCron === t.expression}
										class="rounded-md px-3 py-1.5 text-xs font-medium bg-ink text-surface hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
									>
										{runningCron === t.expression ? 'Running...' : 'Trigger'}
									</button>,
								)
								return row
							})}
						/>
					)}
				</div>
				<ServiceInfo
					description="Cron-based scheduled triggers. Each expression defines when the worker's scheduled handler is invoked."
					stats={[
						{ label: 'Triggers', value: triggers?.length ?? 0 },
					]}
					configGroups={configGroups}
					links={[
						{ label: 'Cron Triggers', href: 'https://developers.cloudflare.com/workers/configuration/cron-triggers/' },
						{ label: 'Crontab Guru', href: 'https://crontab.guru/' },
					]}
				/>
			</div>
		</div>
	)
}
