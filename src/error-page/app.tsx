import { render } from 'preact'
import { useState } from 'preact/hooks'

interface StackFrame {
	file: string
	line: number
	column: number
	function: string
	source?: string[]
	sourceLine?: number
}

interface TraceSpan {
	spanId: string
	traceId: string
	parentSpanId: string | null
	name: string
	status: string
	startTime: number
	endTime: number | null
	durationMs: number | null
}

interface ErrorPageData {
	error: {
		name: string
		message: string
		stack: string
		frames: StackFrame[]
	}
	request: {
		method: string
		url: string
		headers: Record<string, string>
	}
	env: Record<string, string>
	bindings: { name: string; type: string }[]
	runtime: {
		bunVersion: string
		platform: string
		arch: string
		workerName?: string
		configName?: string
	}
	trace?: {
		traceId: string
		spanId: string | null
		spans: TraceSpan[]
	}
}

declare global {
	interface Window {
		__BUNFLARE_ERROR__: ErrorPageData
	}
}

function Section({ title, open, children }: { title: string; open?: boolean; children: preact.ComponentChildren }) {
	return (
		<details open={open} class="bg-white rounded-lg border border-gray-200 overflow-hidden">
			<summary class="px-5 py-3 cursor-pointer select-none text-sm font-semibold text-ink hover:bg-gray-50 transition-colors">
				{title}
			</summary>
			<div class="border-t border-gray-100">
				{children}
			</div>
		</details>
	)
}

const LIBRARY_PATH_RE = /\/node_modules\//

function isLibraryFrame(frame: StackFrame): boolean {
	return LIBRARY_PATH_RE.test(frame.file)
}

const HL_RE =
	/(\/\/.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|(\b(?:const|let|var|function|return|if|else|for|while|do|class|new|import|export|from|default|async|await|throw|try|catch|finally|switch|case|break|continue|typeof|instanceof|in|of|yield|static|extends|super|void|delete|enum|interface|type|as|declare|readonly)\b)|(\b(?:true|false|null|undefined|this|NaN|Infinity)\b)/g

function highlightLine(line: string) {
	const parts: preact.ComponentChildren[] = []
	let last = 0
	for (const m of line.matchAll(HL_RE)) {
		if (m.index! > last) parts.push(line.slice(last, m.index))
		const t = m[0]
		const c = m[1] ? '#6b7280' : m[2] ? '#16a34a' : m[3] ? '#d97706' : m[4] ? '#7c3aed' : m[5] ? '#2563eb' : undefined
		parts.push(c ? <span style={{ color: c }}>{t}</span> : t)
		last = m.index! + t.length
	}
	if (last < line.length) parts.push(line.slice(last))
	return parts.length > 0 ? parts : line
}

function FrameList({ frames }: { frames: StackFrame[] }) {
	return (
		<div class="divide-y divide-gray-100">
			{frames.map((frame, i) => <CodeBlock key={i} frame={frame} defaultOpen={!isLibraryFrame(frame)} />)}
		</div>
	)
}

function CodeBlock({ frame, defaultOpen }: { frame: StackFrame; defaultOpen: boolean }) {
	if (!frame.source || frame.source.length === 0) return null
	const startLine = frame.line - (frame.sourceLine ?? 0)

	return (
		<details open={defaultOpen}>
			<summary
				class="px-4 py-2 bg-gray-50 text-xs font-medium text-ink-muted cursor-pointer select-none hover:bg-gray-100 transition-colors"
				style="font-family: 'JetBrains Mono', monospace;"
			>
				{frame.file}:{frame.line}:{frame.column}
				{frame.function && <span class="ml-2 text-gray-400">in {frame.function}</span>}
			</summary>
			<div class="overflow-x-auto scrollbar-thin">
				<pre class="text-xs leading-5 m-0" style="font-family: 'JetBrains Mono', monospace;">
          {frame.source.map((line, i) => {
            const lineNum = startLine + i;
            const isError = i === frame.sourceLine;
            return (
              <div
                key={i}
                class={isError ? "bg-red-50 border-l-4 border-error-red" : "border-l-4 border-transparent hover:bg-gray-50"}
              >
                <span class={`inline-block w-12 text-right pr-3 select-none ${isError ? "text-error-red font-bold" : "text-gray-400"}`}>
                  {lineNum}
                </span>
                <span class={`text-ink${isError ? " font-medium" : ""}`}>{highlightLine(line)}</span>
              </div>
            );
          })}
				</pre>
			</div>
		</details>
	)
}

function KeyValueTable({ data, mask }: { data: Record<string, string>; mask?: boolean }) {
	const entries = Object.entries(data)
	if (entries.length === 0) {
		return <div class="px-4 py-3 text-sm text-gray-400">No entries</div>
	}

	return (
		<table class="w-full text-sm">
			<tbody>
				{entries.map(([key, value]) => (
					<tr key={key} class="border-b border-gray-100 last:border-0 hover:bg-gray-50/50 transition-colors">
						<td class="px-4 py-2 font-medium text-ink-muted whitespace-nowrap align-top" style="font-family: 'JetBrains Mono', monospace; width: 1%;">
							{key}
						</td>
						<td class="px-4 py-2 text-ink break-all" style="font-family: 'JetBrains Mono', monospace;">
							{value}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}

const MAX_COLLAPSED_LINES = 10

function ErrorMessage({ message }: { message: string }) {
	const [expanded, setExpanded] = useState(false)
	const nlIndex = message.indexOf('\n')

	if (nlIndex === -1) {
		return <h1 class="text-lg font-bold text-ink m-0 leading-snug break-words">{message}</h1>
	}

	const firstLine = message.slice(0, nlIndex)
	const rest = message.slice(nlIndex + 1)
	const restLines = rest.split('\n')
	const needsCollapse = restLines.length > MAX_COLLAPSED_LINES

	return (
		<>
			<h1 class="text-lg font-bold text-ink m-0 leading-snug break-words">{firstLine}</h1>
			<div class="relative mt-2">
				<pre
					class="text-xs text-ink-muted m-0 whitespace-pre-wrap break-words leading-5 overflow-hidden transition-all"
					style={{
						fontFamily: "'JetBrains Mono', monospace",
						maxHeight: !expanded && needsCollapse ? `${MAX_COLLAPSED_LINES * 1.25}rem` : 'none',
					}}
				>
          {rest}
				</pre>
				{needsCollapse && !expanded && (
					<div
						class="absolute bottom-0 left-0 right-0 h-16 flex items-end justify-center pb-2 cursor-pointer"
						style="background: linear-gradient(to bottom, transparent, white);"
						onClick={() => setExpanded(true)}
					>
						<span class="text-xs font-medium text-gray-400 hover:text-ink transition-colors">
							Show all ({restLines.length} lines)
						</span>
					</div>
				)}
				{needsCollapse && expanded && (
					<button
						class="mt-1 text-xs font-medium text-gray-400 hover:text-ink transition-colors"
						onClick={() => setExpanded(false)}
					>
						Collapse
					</button>
				)}
			</div>
		</>
	)
}

function fmtDuration(ms: number): string {
	if (ms < 1) return '<1ms'
	if (ms < 1000) return `${Math.round(ms)}ms`
	return `${(ms / 1000).toFixed(2)}s`
}

function SimpleTraceWaterfall({ trace }: { trace: NonNullable<ErrorPageData['trace']> }) {
	const { spans, spanId: errorSpanId } = trace
	if (spans.length === 0) return null

	const traceStart = Math.min(...spans.map(s => s.startTime))
	const traceEnd = Math.max(...spans.map(s => s.endTime ?? Date.now()))
	const traceDuration = traceEnd - traceStart || 1

	// Build tree and flatten
	const childMap = new Map<string | null, TraceSpan[]>()
	for (const s of spans) {
		const key = s.parentSpanId
		if (!childMap.has(key)) childMap.set(key, [])
		childMap.get(key)!.push(s)
	}

	function flatten(parentId: string | null, depth: number): Array<{ span: TraceSpan; depth: number }> {
		const children = childMap.get(parentId) ?? []
		const result: Array<{ span: TraceSpan; depth: number }> = []
		for (const child of children) {
			result.push({ span: child, depth })
			result.push(...flatten(child.spanId, depth + 1))
		}
		return result
	}

	const flatSpans = flatten(null, 0)

	return (
		<div class="px-4 py-3">
			<div class="flex items-center justify-between mb-2">
				<span class="text-xs text-gray-400" style="font-family: 'JetBrains Mono', monospace;">0ms</span>
				<span class="text-xs text-gray-400" style="font-family: 'JetBrains Mono', monospace;">{fmtDuration(traceDuration)}</span>
			</div>
			<div class="space-y-0.5">
				{flatSpans.map(({ span, depth }) => {
					const offset = ((span.startTime - traceStart) / traceDuration) * 100
					const width = (((span.endTime ?? Date.now()) - span.startTime) / traceDuration) * 100
					const isError = errorSpanId === span.spanId

					return (
						<div
							key={span.spanId}
							class={`flex items-center py-1 px-1 rounded-md ${isError ? 'bg-red-50 ring-1 ring-red-300' : ''}`}
						>
							<div
								class="w-[180px] flex-shrink-0 truncate text-xs text-ink"
								style={{ paddingLeft: `${depth * 14}px`, fontFamily: "'JetBrains Mono', monospace" }}
							>
								{span.name}
							</div>
							<div class="flex-1 h-5 relative bg-gray-50 rounded">
								<div
									class={`absolute top-0.5 bottom-0.5 rounded ${
										span.status === 'error'
											? 'bg-red-400'
											: span.status === 'ok'
											? 'bg-emerald-400'
											: 'bg-gray-300'
									}`}
									style={{ left: `${offset}%`, width: `${Math.max(width, 0.5)}%` }}
								/>
								<span
									class="absolute top-0.5 text-[10px] text-gray-500 whitespace-nowrap"
									style={{ left: `${offset + width + 1}%`, fontFamily: "'JetBrains Mono', monospace" }}
								>
									{span.durationMs != null ? fmtDuration(span.durationMs) : '...'}
								</span>
							</div>
						</div>
					)
				})}
			</div>
		</div>
	)
}

function App() {
	const data = window.__BUNFLARE_ERROR__

	if (!data) {
		return <div class="p-8 text-gray-400">No error data available.</div>
	}

	const { error, request, env, bindings, runtime } = data

	return (
		<div class="min-h-full p-6 max-w-5xl mx-auto flex flex-col gap-4">
			{/* Error header */}
			<div class="bg-white rounded-lg border border-gray-200 overflow-hidden border-l-4 border-l-error-red">
				<div class="px-5 py-4">
					<div class="flex items-center gap-2.5 mb-1.5">
						<span class="w-6 h-6 rounded-md bg-red-50 flex items-center justify-center text-error-red text-xs font-bold">!</span>
						<span class="text-xs font-semibold uppercase tracking-wider text-error-red">{error.name}</span>
					</div>
					<ErrorMessage message={error.message} />
				</div>
			</div>

			{/* Source Code */}
			{error.frames.length > 0 && (
				<Section title="Source Code" open>
					<FrameList frames={error.frames} />
				</Section>
			)}

			{/* Stack Trace */}
			<Section title="Stack Trace">
				<div class="px-4 py-3 overflow-x-auto scrollbar-thin">
					<pre class="text-xs text-ink-muted leading-5 m-0 whitespace-pre-wrap break-words" style="font-family: 'JetBrains Mono', monospace;">
            {error.stack}
					</pre>
				</div>
			</Section>

			{/* Trace */}
			{data.trace && data.trace.spans.length > 0 && (
				<Section title="Trace" open>
					<SimpleTraceWaterfall trace={data.trace} />
				</Section>
			)}

			{/* Request */}
			<Section title="Request" open>
				<div class="px-4 py-2.5 border-b border-gray-100">
					<span class="inline-block px-2 py-0.5 rounded-md bg-gray-100 text-xs font-bold mr-2">{request.method}</span>
					<span class="text-sm break-all" style="font-family: 'JetBrains Mono', monospace;">{request.url}</span>
				</div>
				<KeyValueTable data={request.headers} />
			</Section>

			{/* Environment */}
			<Section title="Environment">
				<KeyValueTable data={env} />
			</Section>

			{/* Bindings */}
			<Section title="Bindings">
				{bindings.length === 0 ? <div class="px-4 py-3 text-sm text-gray-400">No bindings configured</div> : (
					<table class="w-full text-sm">
						<tbody>
							{bindings.map((b) => (
								<tr key={b.name} class="border-b border-gray-100 last:border-0 hover:bg-gray-50/50 transition-colors">
									<td class="px-4 py-2 font-medium text-ink-muted whitespace-nowrap" style="font-family: 'JetBrains Mono', monospace;">
										{b.name}
									</td>
									<td class="px-4 py-2">
										<span class="inline-block px-2 py-0.5 rounded-md bg-gray-100 text-xs font-medium text-gray-600">{b.type}</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</Section>

			{/* Runtime */}
			<Section title="Runtime">
				<KeyValueTable
					data={{
						'Bun': runtime.bunVersion,
						'Platform': runtime.platform,
						'Arch': runtime.arch,
						...(runtime.workerName ? { 'Worker': runtime.workerName } : {}),
						...(runtime.configName ? { 'Config': runtime.configName } : {}),
					}}
				/>
			</Section>

			<div class="text-center text-xs text-gray-400 py-4">
				Bunflare Dev Server
			</div>
		</div>
	)
}

render(<App />, document.getElementById('app')!)
