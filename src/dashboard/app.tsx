import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'

import { BindingIcon } from './components/binding-icon'
import type { BindingIconType } from './components/binding-icon'
import { useRoute } from './lib'
import { useQuery } from './rpc/hooks'
import { AiView } from './views/ai'
import { AnalyticsEngineView } from './views/analytics-engine'
import { CacheView } from './views/cache'
import { ContainersView } from './views/containers'
import { D1View } from './views/d1'
import { DoView } from './views/do'
import { EmailView } from './views/email'
import { ErrorsView } from './views/errors'
import { HomeView } from './views/home'
import { KvView } from './views/kv'
import { QueueView } from './views/queue'
import { R2View } from './views/r2'
import { ScheduledView } from './views/scheduled'
import { TracesView } from './views/traces'
import { WorkersView } from './views/workers'
import { WorkflowsView } from './views/workflows'

interface NavItem {
	path: string
	label: string
	icon: BindingIconType
	badge?: (counts: Record<string, number>) => number | null
	badgeColor?: string
}

interface NavGroup {
	label: string
	items: NavItem[]
}

const NAV_TOP: NavItem[] = [
	{ path: '/', label: 'Overview', icon: 'overview' },
]

const NAV_GROUPS: NavGroup[] = [
	{
		label: 'Observability',
		items: [
			{
				path: '/errors',
				label: 'Errors',
				icon: 'errors',
				badge: c => c.errors || null,
				badgeColor: 'bg-red-500',
			},
			{ path: '/traces', label: 'Traces', icon: 'traces' },
			{ path: '/analytics', label: 'Analytics Engine', icon: 'analytics' },
		],
	},
	{
		label: 'Compute',
		items: [
			{ path: '/workers', label: 'Workers', icon: 'workers' },
			{ path: '/do', label: 'Durable Objects', icon: 'do' },
			{ path: '/containers', label: 'Containers', icon: 'containers' },
			{ path: '/workflows', label: 'Workflows', icon: 'workflows' },
			{ path: '/scheduled', label: 'Scheduled', icon: 'scheduled' },
		],
	},
	{
		label: 'Storage',
		items: [
			{ path: '/kv', label: 'KV', icon: 'kv' },
			{ path: '/r2', label: 'R2', icon: 'r2' },
			{ path: '/d1', label: 'D1', icon: 'd1' },
			{ path: '/cache', label: 'Cache', icon: 'cache' },
		],
	},
	{
		label: 'Messaging',
		items: [
			{ path: '/queue', label: 'Queues', icon: 'queue' },
			{ path: '/email', label: 'Email', icon: 'email' },
		],
	},
	{
		label: 'AI',
		items: [
			{ path: '/ai', label: 'AI', icon: 'ai' },
		],
	},
]

function NavLink({ item, active, counts }: { item: NavItem; active: boolean; counts: Record<string, number> }) {
	const badgeValue = item.badge?.(counts) ?? null
	return (
		<a
			href={`#${item.path}`}
			class={`flex items-center gap-2.5 px-3 py-1 text-sm font-mono no-underline transition-colors ${
				active
					? 'border-l-2 border-l-accent-lime text-ink font-medium'
					: 'border-l-2 border-l-transparent text-text-secondary hover:text-ink'
			}`}
		>
			<BindingIcon type={item.icon} class="w-4 text-center opacity-60 flex items-center justify-center" />
			<span class="flex-1">{item.label}</span>
			{badgeValue !== null && (
				<span
					class={`min-w-[20px] h-5 flex items-center justify-center rounded-full text-[10px] font-bold text-white px-1.5 ${
						item.badgeColor ?? 'bg-text-muted'
					}`}
				>
					{badgeValue > 99 ? '99+' : badgeValue}
				</span>
			)}
		</a>
	)
}

function SidebarGroup({ group, activeSection, counts }: { group: NavGroup; activeSection: string; counts: Record<string, number> }) {
	return (
		<div class="mb-1">
			<div class="px-3 py-1.5 text-[10px] font-mono font-semibold uppercase tracking-wider text-text-muted">
				{group.label}
			</div>
			<div class="mt-0.5 ml-1">
				{group.items.map(item => <NavLink key={item.path} item={item} active={activeSection === item.path} counts={counts} />)}
			</div>
		</div>
	)
}

type Theme = 'auto' | 'light' | 'dark'

const THEME_ICONS: Record<Theme, string> = { light: '☀︎', dark: '☾', auto: '◐' }
const THEME_LABELS: Record<Theme, string> = { light: 'Light', dark: 'Dark', auto: 'Auto' }
const THEME_CYCLE: Record<Theme, Theme> = { auto: 'light', light: 'dark', dark: 'auto' }

function ThemeSwitcher() {
	const [theme, setTheme] = useState<Theme>(() => {
		const saved = localStorage.getItem('bunflare-theme')
		return saved === 'light' || saved === 'dark' ? saved : 'auto'
	})

	useEffect(() => {
		if (theme === 'auto') {
			document.documentElement.removeAttribute('data-theme')
			localStorage.removeItem('bunflare-theme')
		} else {
			document.documentElement.setAttribute('data-theme', theme)
			localStorage.setItem('bunflare-theme', theme)
		}
	}, [theme])

	return (
		<button
			onClick={() => setTheme(THEME_CYCLE[theme])}
			class="flex items-center gap-2 w-full px-3 py-1.5 text-xs font-mono text-text-muted hover:text-ink hover:bg-panel-hover rounded-md transition-colors"
			title={`Theme: ${THEME_LABELS[theme]}`}
		>
			<span class="w-4 text-center text-sm">{THEME_ICONS[theme]}</span>
			<span>{THEME_LABELS[theme]}</span>
		</button>
	)
}

function App() {
	const route = useRoute()
	const activeSection = '/' + (route.split('/')[1] || '')
	const { data: overview } = useQuery('overview.get')

	const counts: Record<string, number> = overview
		? {
			errors: overview.errors,
			kv: overview.kv,
			r2: overview.r2,
			queue: overview.queue,
			do: overview.do,
			workflows: overview.workflows,
			containers: overview.containers,
			d1: overview.d1,
			cache: overview.cache,
			scheduled: overview.scheduled,
			email: overview.email,
			ai: overview.ai,
		}
		: {}

	function renderView() {
		if (route === '/' || route === '') return <HomeView />
		if (route.startsWith('/errors')) return <ErrorsView route={route} />
		if (route.startsWith('/traces')) return <TracesView />
		if (route.startsWith('/workers')) return <WorkersView />
		if (route.startsWith('/kv')) return <KvView route={route} />
		if (route.startsWith('/r2')) return <R2View route={route} />
		if (route.startsWith('/queue')) return <QueueView route={route} />
		if (route.startsWith('/do')) return <DoView route={route} />
		if (route.startsWith('/workflows')) return <WorkflowsView route={route} />
		if (route.startsWith('/containers')) return <ContainersView route={route} />
		if (route.startsWith('/d1')) return <D1View route={route} />
		if (route.startsWith('/cache')) return <CacheView route={route} />
		if (route.startsWith('/scheduled')) return <ScheduledView route={route} />
		if (route.startsWith('/email')) return <EmailView route={route} />
		if (route.startsWith('/ai')) return <AiView route={route} />
		if (route.startsWith('/analytics')) return <AnalyticsEngineView route={route} />
		return <div class="p-8 text-text-muted">Page not found</div>
	}

	return (
		<div class="flex h-full">
			<nav class="w-56 flex-shrink-0 border-r border-border bg-panel flex flex-col">
				<div class="p-4 pb-3">
					<a href="#/" class="flex items-center gap-2.5 no-underline">
						<span class="w-7 h-7 rounded-lg bg-accent-lime flex items-center justify-center text-xs font-bold text-surface">B</span>
						<div>
							<div class="text-sm font-mono font-semibold text-ink leading-tight">Bunflare</div>
							<div class="text-[10px] text-text-muted font-mono">Dev Console</div>
						</div>
					</a>
				</div>
				<div class="flex-1 overflow-y-auto scrollbar-thin px-2 py-1">
					{NAV_TOP.map(item => (
						<div key={item.path} class="mb-2">
							<NavLink item={item} active={activeSection === item.path} counts={counts} />
						</div>
					))}
					{NAV_GROUPS.map(group => <SidebarGroup key={group.label} group={group} activeSection={activeSection} counts={counts} />)}
				</div>
				<div class="border-t border-border px-2 py-2">
					<ThemeSwitcher />
				</div>
			</nav>

			<main class="flex-1 overflow-y-auto scrollbar-thin bg-surface">
				{renderView()}
			</main>
		</div>
	)
}

render(<App />, document.getElementById('app')!)
