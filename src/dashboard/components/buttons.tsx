export function LoadMoreButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			onClick={onClick}
			class="mt-4 rounded-md px-3 py-1.5 text-sm font-medium bg-panel border border-border text-text-secondary hover:bg-panel-hover transition-all"
		>
			Load more
		</button>
	)
}

export function DeleteButton({ onClick }: { onClick: () => void }) {
	return (
		<button onClick={onClick} class="text-red-400 hover:text-red-300 text-xs font-medium rounded-md px-2 py-1 hover:bg-red-500/10 transition-all">
			Delete
		</button>
	)
}
