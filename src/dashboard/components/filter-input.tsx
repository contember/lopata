export function FilterInput(
	{ value, onInput, placeholder, class: className }: { value: string; onInput: (v: string) => void; placeholder?: string; class?: string },
) {
	return (
		<input
			type="text"
			placeholder={placeholder}
			value={value}
			onInput={e => onInput((e.target as HTMLInputElement).value)}
			class={`bg-panel border border-border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-border focus:ring-1 focus:ring-border transition-all ${
				className ?? 'w-72'
			}`}
		/>
	)
}
