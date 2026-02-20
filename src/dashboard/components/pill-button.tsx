export function PillButton({ onClick, active, children }: { onClick: () => void; active?: boolean; children: any }) {
	return (
		<button
			onClick={onClick}
			class={`rounded-md px-3 py-1.5 text-sm font-medium transition-all border ${
				active
					? 'bg-accent-lime text-surface border-transparent'
					: 'bg-panel border-border text-text-secondary hover:bg-panel-hover'
			}`}
		>
			{children}
		</button>
	)
}
