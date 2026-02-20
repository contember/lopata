export function CodeBlock({ children, class: className }: { children: any; class?: string }) {
	return <pre class={`bg-panel-secondary rounded-lg p-4 text-xs overflow-x-auto font-mono ${className ?? ''}`}>{children}</pre>
}
