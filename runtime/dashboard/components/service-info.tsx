export function ServiceInfo({ description, links, stats, configGroups }: {
	description: string
	links: { label: string; href: string }[]
	stats?: { label: string; value: string | number }[]
	configGroups?: { title: string; items: { name: string; value: string }[] }[] | null
}) {
	return (
		<div class="w-80 flex-shrink-0 space-y-5">
			{stats && stats.length > 0 && (
				<div class="grid grid-cols-2 gap-2">
					{stats.map(stat => (
						<div key={stat.label} class="bg-panel border border-border rounded-lg px-3.5 py-3">
							<div class="text-xs text-text-muted font-medium">{stat.label}</div>
							<div class="text-xl font-semibold text-ink mt-0.5 tabular-nums">{stat.value}</div>
						</div>
					))}
				</div>
			)}
			{configGroups && configGroups.length > 0 && configGroups.map(group => (
				<div key={group.title}>
					<div class="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">{group.title}</div>
					<div class="bg-panel border border-border rounded-lg divide-y divide-border-subtle">
						{group.items.map(item => (
							<div key={item.name} class="px-3.5 py-2.5">
								<div class="text-xs font-medium text-ink">{item.name}</div>
								<div class="text-xs text-text-muted font-mono mt-0.5 truncate" title={item.value}>{item.value}</div>
							</div>
						))}
					</div>
				</div>
			))}
			<div>
				<p class="text-xs text-text-muted leading-relaxed mb-2.5">{description}</p>
				<div class="space-y-1.5">
					{links.map(link => (
						<a
							key={link.href}
							href={link.href}
							target="_blank"
							rel="noopener"
							class="flex items-center gap-1.5 text-xs text-text-muted hover:text-ink no-underline transition-colors"
						>
							<span>&rarr;</span> {link.label}
						</a>
					))}
				</div>
			</div>
		</div>
	)
}
