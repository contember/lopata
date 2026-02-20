export function EmptyState({ message }: { message: string }) {
	return (
		<div class="text-center py-16 text-text-muted">
			<div class="text-5xl mb-3 opacity-50">&#8709;</div>
			<div class="text-sm font-medium">{message}</div>
		</div>
	)
}
