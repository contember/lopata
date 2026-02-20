import { BindingIcon, StatusBadge } from '../components'
import type { BindingIconType } from '../components/binding-icon'
import { useQuery } from '../rpc/hooks'
import type { OverviewData, WorkerInfo } from '../rpc/types'

/* ── Inventory items ── */

const INVENTORY: readonly { key: string; label: string; path: string; icon: BindingIconType }[] = [
	{ key: 'kv', label: 'KV', path: '/kv', icon: 'kv' },
	{ key: 'r2', label: 'R2', path: '/r2', icon: 'r2' },
	{ key: 'd1', label: 'D1', path: '/d1', icon: 'd1' },
	{ key: 'cache', label: 'Cache', path: '/cache', icon: 'cache' },
	{ key: 'do', label: 'DO', path: '/do', icon: 'do' },
	{ key: 'workflows', label: 'Workflows', path: '/workflows', icon: 'workflows' },
	{ key: 'containers', label: 'Containers', path: '/containers', icon: 'containers' },
	{ key: 'scheduled', label: 'Scheduled', path: '/scheduled', icon: 'scheduled' },
	{ key: 'queue', label: 'Queues', path: '/queue', icon: 'queue' },
	{ key: 'email', label: 'Email', path: '/email', icon: 'email' },
	{ key: 'ai', label: 'AI', path: '/ai', icon: 'ai' },
]

const BINDING_COLORS: Record<string, string> = {
	kv: 'bg-blue-500/15 text-blue-400',
	r2: 'bg-violet-500/15 text-violet-400',
	d1: 'bg-cyan-500/15 text-cyan-400',
	do: 'bg-emerald-500/15 text-emerald-400',
	queue: 'bg-yellow-500/15 text-yellow-400',
	workflow: 'bg-amber-500/15 text-amber-400',
	service: 'bg-neutral-500/15 text-neutral-400',
	images: 'bg-pink-500/15 text-pink-400',
	container: 'bg-indigo-500/15 text-indigo-400',
	ai: 'bg-purple-500/15 text-purple-400',
}

/* ── Formatters ── */

function fmtBytes(b: number): string {
	if (b < 1024) return `${b} B`
	if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
	if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`
	return `${(b / 1073741824).toFixed(2)} GB`
}

function fmtUptime(s: number): string {
	const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60)
	const p: string[] = []
	if (d) p.push(`${d}d`)
	if (h) p.push(`${h}h`)
	if (m) p.push(`${m}m`)
	p.push(`${sec}s`)
	return p.join(' ')
}

function fmtMicros(us: number): string {
	if (us < 1000) return `${us}µs`
	if (us < 1_000_000) return `${(us / 1000).toFixed(1)}ms`
	return `${(us / 1_000_000).toFixed(2)}s`
}

/* ── Gauge with semantic color ── */

function gaugeColor(pct: number): string {
	if (pct > 90) return 'bg-red-500'
	if (pct > 70) return 'bg-amber-500'
	return 'bg-blue-500'
}

function MiniGauge({ value, max, label }: { value: number; max: number; label: string }) {
	const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
	return (
		<div>
			<div class="flex justify-between items-baseline mb-1.5">
				<span class="text-xs text-text-muted">{label}</span>
				<span class="text-xs font-mono tabular-nums text-ink">{fmtBytes(value)}</span>
			</div>
			<div class="h-2 rounded-full bg-bar overflow-hidden">
				<div class={`h-full rounded-full transition-all ${gaugeColor(pct)}`} style={{ width: `${Math.max(pct, 2)}%` }} />
			</div>
		</div>
	)
}

function Kv({ k, v }: { k: string; v: string }) {
	return (
		<div class="flex justify-between items-baseline gap-6 py-0.5">
			<span class="text-xs text-text-muted shrink-0">{k}</span>
			<span class="text-xs font-mono tabular-nums text-ink truncate text-right" title={v}>{v}</span>
		</div>
	)
}

function Section({ title, children }: { title: string; children: any }) {
	return (
		<div>
			<h2 class="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">{title}</h2>
			{children}
		</div>
	)
}

/* ── Optional deps card ── */

function OptionalDepsCard() {
	const { data: deps } = useQuery('warnings.optionalDeps')
	if (!deps) return null
	const missing = deps.filter(d => !d.installed)
	if (!missing.length) return null

	return (
		<div class="bg-panel rounded-lg border border-amber-500/20 p-5">
			<div class="text-xs font-semibold uppercase tracking-wider text-amber-400 mb-3">Optional packages</div>
			<div class="flex flex-col gap-2">
				{deps.map(dep => (
					<div key={dep.id}>
						<div class="flex items-center gap-2">
							<span class={`text-xs ${dep.installed ? 'text-emerald-400' : 'text-amber-400'}`}>
								{dep.installed ? '\u2713' : '\u2717'}
							</span>
							<span class={`text-xs ${dep.installed ? 'text-text-muted' : 'text-text-secondary'}`}>{dep.description}</span>
						</div>
						{!dep.installed && (
							<code class="block ml-5 mt-0.5 text-[10px] text-amber-400/80 bg-amber-500/10 px-1.5 py-0.5 rounded w-fit">{dep.install} --dev</code>
						)}
					</div>
				))}
			</div>
		</div>
	)
}

/* ── Main view ── */

export function HomeView() {
	const { data } = useQuery('overview.get')
	const { data: workers } = useQuery('workers.list')

	if (!data) {
		return (
			<div class="p-4 sm:p-8 lg:p-10">
				<h1 class="text-2xl font-bold text-ink mb-1">Overview</h1>
				<p class="text-sm text-text-muted">Loading...</p>
			</div>
		)
	}

	const rt = data.runtime
	const hasErrors = data.errors > 0
	const envEntries = Object.entries(rt.env).filter(([k]) => k !== 'PATH')

	return (
		<div class="p-4 sm:p-8 lg:p-10 max-w-[1600px]">
			{/* ── Header ── */}
			<div class="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4 mb-8">
				<div class="flex-1">
					<h1 class="text-2xl font-bold text-ink">Overview</h1>
					<p class="text-sm text-text-muted mt-1">
						Bun {rt.bunVersion} &middot; {rt.platform}/{rt.arch} &middot; up {fmtUptime(rt.uptime)}
					</p>
				</div>
				<a
					href="#/errors"
					class={`flex items-center gap-2.5 px-4 py-2 rounded-full text-sm font-medium no-underline transition-colors ${
						hasErrors
							? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
							: 'bg-emerald-500/10 text-emerald-400'
					}`}
				>
					<span class={`w-2.5 h-2.5 rounded-full ${hasErrors ? 'bg-red-500' : 'bg-emerald-500'}`} />
					{hasErrors ? `${data.errors} error${data.errors > 1 ? 's' : ''}` : 'Healthy'}
				</a>
			</div>

			{/* ── Two-column layout ── */}
			<div class="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-10">
				{/* ── Left: main content ── */}
				<div class="flex flex-col gap-10">
					{/* ── Health: Errors hero card ── */}
					{hasErrors && (
						<a
							href="#/errors"
							class="flex items-center gap-5 bg-panel rounded-lg border border-red-500/30 border-l-[3px] border-l-accent-lime px-6 py-5 no-underline hover:border-red-500/50 transition-colors"
						>
							<span class="text-3xl">⚠︎</span>
							<div class="flex-1">
								<div class="text-3xl font-bold font-mono text-red-400 tabular-nums">{data.errors}</div>
								<div class="text-sm text-text-muted mt-0.5">Unresolved errors</div>
							</div>
							<span class="text-sm font-mono text-text-muted">View all &rarr;</span>
						</a>
					)}

					{/* ── Binding rail ── */}
					<Section title="Bindings">
						<div class="flex flex-wrap gap-2">
							{INVENTORY.map(item => {
								const count = data[item.key as keyof OverviewData] as number
								const active = count > 0
								return (
									<a
										key={item.key}
										href={`#${item.path}`}
										class={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border no-underline transition-all font-mono text-sm ${
											active
												? 'border-border text-accent-lime hover:border-text-dim'
												: 'border-border-subtle opacity-40 hover:opacity-65'
										}`}
									>
										<BindingIcon type={item.icon} class={`flex items-center ${active ? 'text-accent-lime' : 'text-text-dim'}`} />
										<span class={`font-bold tabular-nums ${active ? 'text-ink' : 'text-text-dim'}`}>{count}</span>
										<span class="text-text-muted text-xs">{item.label}</span>
									</a>
								)
							})}
						</div>
					</Section>

					{/* ── Workers ── */}
					<Section title="Workers">
						{workers && workers.length > 0
							? (
								<div class="flex flex-col gap-3">
									{workers.map((w: WorkerInfo) => {
										const errCount = data.workerErrors[w.name] ?? 0
										const hasWorkerErrors = errCount > 0
										return (
											<a
												key={w.name}
												href="#/workers"
												class={`group bg-panel rounded-lg border px-5 py-4 no-underline transition-colors ${
													hasWorkerErrors
														? 'border-red-500/20 hover:border-red-500/40'
														: 'border-border hover:border-text-dim'
												}`}
											>
												<div class="flex items-center gap-2.5 mb-2">
													<span class={`w-2.5 h-2.5 rounded-full shrink-0 ${hasWorkerErrors ? 'bg-red-500' : 'bg-emerald-500'}`} />
													<span class="text-sm font-mono font-semibold text-ink">{w.name}</span>
													{w.isMain && <span class="px-2 py-0.5 rounded text-[11px] font-mono font-medium bg-accent-lime text-surface leading-none">main</span>}
													{hasWorkerErrors && (
														<span class="px-2 py-0.5 rounded text-[11px] font-medium bg-red-500/15 text-red-400 leading-none">
															{errCount} err
														</span>
													)}
													<span class="text-xs text-text-muted ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
														View &rarr;
													</span>
												</div>
												{w.bindings.length > 0 && (
													<div class="flex flex-wrap gap-1.5 ml-5">
														{w.bindings.map(b => (
															<span key={b.name} title={b.name}>
																<StatusBadge status={b.type} colorMap={BINDING_COLORS} />
															</span>
														))}
													</div>
												)}
											</a>
										)
									})}
								</div>
							)
							: (
								<div class="bg-panel rounded-lg border border-border-subtle px-5 py-8 text-center text-sm text-text-muted">
									No workers configured
								</div>
							)}
					</Section>
				</div>

				{/* ── Right: System sidebar ── */}
				<div class="flex flex-col gap-5">
					<OptionalDepsCard />
					<div class="bg-panel rounded-lg border border-border p-5">
						<div class="text-xs font-semibold uppercase tracking-wider text-text-muted mb-4">Resources</div>
						<div class="flex flex-col gap-2">
							<Kv k="RSS" v={fmtBytes(rt.memory.rss)} />
							<Kv k="Heap" v={fmtBytes(rt.memory.heapUsed)} />
							<Kv k="External" v={fmtBytes(rt.memory.external)} />
						</div>
						<div class="mt-3 pt-3 border-t border-border-subtle flex flex-col gap-2">
							<Kv k="CPU user" v={fmtMicros(rt.cpuUsage.user)} />
							<Kv k="CPU system" v={fmtMicros(rt.cpuUsage.system)} />
						</div>
					</div>

					<div class="bg-panel rounded-lg border border-border p-5">
						<div class="text-xs font-semibold uppercase tracking-wider text-text-muted mb-4">Runtime</div>
						<div class="flex flex-col gap-2">
							<Kv k="Bun" v={rt.bunVersion} />
							<Kv k="Platform" v={`${rt.platform}/${rt.arch}`} />
							<Kv k="PID" v={String(rt.pid)} />
							<Kv k="Uptime" v={fmtUptime(rt.uptime)} />
							<Kv k="Started" v={new Date(rt.startedAt).toLocaleTimeString()} />
							<Kv k="CWD" v={rt.cwd} />
						</div>
					</div>

					{envEntries.length > 0 && (
						<details class="bg-panel rounded-lg border border-border overflow-hidden">
							<summary class="p-5 cursor-pointer select-none text-xs font-semibold uppercase tracking-wider text-text-muted hover:text-text-secondary transition-colors">
								Environment ({envEntries.length})
							</summary>
							<div class="px-5 pb-5 flex flex-col gap-2">
								{envEntries.map(([key, value]) => <Kv key={key} k={key} v={value} />)}
							</div>
						</details>
					)}
				</div>
			</div>
		</div>
	)
}
