import { useEffect, useRef, useState } from 'preact/hooks'

export function CopyMarkdownButton({ getMarkdown, title }: { getMarkdown: () => string; title?: string }) {
	const [copied, setCopied] = useState(false)
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current)
		}
	}, [])

	const handleCopy = (e: Event) => {
		e.stopPropagation()
		navigator.clipboard.writeText(getMarkdown()).then(() => {
			setCopied(true)
			if (timerRef.current) clearTimeout(timerRef.current)
			timerRef.current = setTimeout(() => setCopied(false), 1500)
		})
	}

	return (
		<button
			onClick={handleCopy}
			class="rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:text-text-data hover:bg-panel-hover border border-transparent hover:border-border transition-all"
			title={title ?? 'Copy as Markdown'}
		>
			{copied ? 'Copied!' : 'Copy MD'}
		</button>
	)
}

function extractText(v: unknown): string {
	if (v == null || v === false || v === true) return ''
	if (typeof v === 'string' || typeof v === 'number') return String(v)
	if (Array.isArray(v)) return v.map(extractText).join('')
	if (typeof v === 'object' && 'props' in v) {
		const props = (v as { props: Record<string, unknown> }).props
		return extractText(props.children)
	}
	return String(v)
}

export function tableToMarkdown(headers: string[], rows: unknown[][]): string {
	const escape = (v: unknown) => extractText(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
	const headerRow = `| ${headers.map(escape).join(' | ')} |`
	const separator = `| ${headers.map(() => '---').join(' | ')} |`
	const dataRows = rows.map(row => `| ${row.map(escape).join(' | ')} |`)
	return [headerRow, separator, ...dataRows].join('\n')
}

export function recordsToMarkdown(headers: string[], rows: Record<string, unknown>[]): string {
	return tableToMarkdown(headers, rows.map(row => headers.map(h => row[h])))
}

export function keyValueToMarkdown(data: Record<string, string>): string {
	const entries = Object.entries(data)
	if (entries.length === 0) return ''
	return tableToMarkdown(['Key', 'Value'], entries)
}
