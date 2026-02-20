export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: preact.ComponentChildren }) {
	return (
		<div class="mb-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
			<div class="min-w-0">
				<h1 class="text-2xl sm:text-3xl font-bold text-ink">{title}</h1>
				{subtitle && <div class="text-sm font-mono text-text-muted mt-1 font-medium">{subtitle}</div>}
			</div>
			{actions && <div class="flex gap-2 items-center flex-shrink-0">{actions}</div>}
		</div>
	)
}
