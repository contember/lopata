const ICONS: Record<string, () => preact.JSX.Element> = {
	kv: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2" y="3" width="12" height="4" rx="1" />
			<rect x="2" y="9" width="12" height="4" rx="1" />
			<circle cx="5" cy="5" r="0.75" fill="currentColor" stroke="none" />
			<circle cx="5" cy="11" r="0.75" fill="currentColor" stroke="none" />
		</svg>
	),
	r2: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<ellipse cx="8" cy="5" rx="5.5" ry="2.5" />
			<path d="M2.5 5v6c0 1.38 2.46 2.5 5.5 2.5s5.5-1.12 5.5-2.5V5" />
			<path d="M2.5 8c0 1.38 2.46 2.5 5.5 2.5s5.5-1.12 5.5-2.5" />
		</svg>
	),
	d1: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2" y="2" width="12" height="12" rx="2" />
			<line x1="2" y1="6" x2="14" y2="6" />
			<line x1="2" y1="10" x2="14" y2="10" />
			<line x1="6" y1="6" x2="6" y2="14" />
		</svg>
	),
	cache: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="8" cy="8" r="6" />
			<circle cx="8" cy="8" r="3" />
			<circle cx="8" cy="8" r="0.75" fill="currentColor" stroke="none" />
		</svg>
	),
	do: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<path d="M8 1.5 L13.5 4.75 L13.5 11.25 L8 14.5 L2.5 11.25 L2.5 4.75 Z" />
			<line x1="8" y1="8" x2="13.5" y2="4.75" />
			<line x1="8" y1="8" x2="2.5" y2="4.75" />
			<line x1="8" y1="8" x2="8" y2="14.5" />
		</svg>
	),
	workflows: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="3" cy="8" r="1.5" />
			<circle cx="13" cy="4" r="1.5" />
			<circle cx="13" cy="12" r="1.5" />
			<path d="M4.5 8h3l2-4h2" />
			<path d="M7.5 8l2 4h2" />
		</svg>
	),
	containers: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2" y="2" width="12" height="12" rx="1.5" />
			<line x1="6" y1="2" x2="6" y2="14" />
			<line x1="10" y1="2" x2="10" y2="14" />
			<line x1="2" y1="6" x2="14" y2="6" />
			<line x1="2" y1="10" x2="14" y2="10" />
		</svg>
	),
	scheduled: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<circle cx="8" cy="8" r="6" />
			<polyline points="8,4.5 8,8 10.5,9.5" />
		</svg>
	),
	queue: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<line x1="3" y1="4" x2="13" y2="4" />
			<line x1="3" y1="8" x2="13" y2="8" />
			<line x1="3" y1="12" x2="13" y2="12" />
			<polyline points="10,2 13,4 10,6" />
		</svg>
	),
	email: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2" y="3.5" width="12" height="9" rx="1.5" />
			<polyline points="2,4.5 8,9 14,4.5" />
		</svg>
	),
	ai: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<path d="M8 2L9.5 6.5L14 8L9.5 9.5L8 14L6.5 9.5L2 8L6.5 6.5Z" />
		</svg>
	),
	errors: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<path d="M7.13 2.5 L1.5 12.5 a1 1 0 0 0 .87 1.5 h11.26 a1 1 0 0 0 .87-1.5 L8.87 2.5 a1 1 0 0 0-1.74 0Z" />
			<line x1="8" y1="6.5" x2="8" y2="9.5" />
			<circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
		</svg>
	),
	traces: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<path d="M2 12 L5 5 L8 9 L11 3 L14 7" />
		</svg>
	),
	analytics: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2" y="9" width="3" height="5" rx="0.5" />
			<rect x="6.5" y="5" width="3" height="9" rx="0.5" />
			<rect x="11" y="2" width="3" height="12" rx="0.5" />
		</svg>
	),
	workers: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<rect x="3" y="3" width="10" height="10" rx="2" />
			<circle cx="8" cy="8" r="2.5" />
			<line x1="8" y1="1" x2="8" y2="3" />
			<line x1="8" y1="13" x2="8" y2="15" />
			<line x1="1" y1="8" x2="3" y2="8" />
			<line x1="13" y1="8" x2="15" y2="8" />
		</svg>
	),
	overview: () => (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
			<rect x="2" y="2" width="5" height="5" rx="1" />
			<rect x="9" y="2" width="5" height="5" rx="1" />
			<rect x="2" y="9" width="5" height="5" rx="1" />
			<rect x="9" y="9" width="5" height="5" rx="1" />
		</svg>
	),
}

export type BindingIconType = keyof typeof ICONS

export function BindingIcon({ type, class: className }: { type: BindingIconType; class?: string }) {
	const Icon = ICONS[type]
	if (!Icon) return null
	return <span class={className}><Icon /></span>
}
