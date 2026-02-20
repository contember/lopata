import { useEffect, useState } from 'preact/hooks'
import type { SpanData, SpanEventData } from '../rpc/types'

// ─── Types ───────────────────────────────────────────────────────────

export interface TraceWaterfallProps {
	spans: SpanData[]
	events: SpanEventData[]
	highlightSpanId?: string | null
	onAddAttributeFilter?: (key: string, value: string, type: 'include' | 'exclude') => void
}

// ─── Component ───────────────────────────────────────────────────────

export function TraceWaterfall({ spans, events, highlightSpanId, onAddAttributeFilter }: TraceWaterfallProps) {
	const [expandedSpan, setExpandedSpan] = useState<string | null>(null)
	const [collapsedSpans, setCollapsedSpans] = useState<Set<string>>(new Set())

	// Compute waterfall layout
	const traceStart = spans.length > 0 ? Math.min(...spans.map(s => s.startTime)) : 0
	const traceEnd = spans.length > 0 ? Math.max(...spans.map(s => (s.endTime ?? Date.now()))) : 0
	const traceDuration = traceEnd - traceStart || 1

	// Build tree structure
	const spanMap = new Map(spans.map(s => [s.spanId, s]))
	const childMap = new Map<string | null, SpanData[]>()
	for (const s of spans) {
		const key = s.parentSpanId
		if (!childMap.has(key)) childMap.set(key, [])
		childMap.get(key)!.push(s)
	}

	// Auto-expand: first 2 levels OR spans with >10% duration
	const getAutoExpanded = (): Set<string> => {
		const autoCollapsed = new Set<string>()
		function walk(parentId: string | null, depth: number) {
			const children = childMap.get(parentId) ?? []
			for (const child of children) {
				const hasChildren = (childMap.get(child.spanId) ?? []).length > 0
				if (hasChildren) {
					const spanDur = child.durationMs ?? 0
					const significantDuration = spanDur > traceDuration * 0.1
					if (depth >= 2 && !significantDuration) {
						autoCollapsed.add(child.spanId)
					}
				}
				walk(child.spanId, depth + 1)
			}
		}
		walk(null, 0)
		return autoCollapsed
	}

	// Initialize collapsed state when spans change
	useEffect(() => {
		if (spans.length > 0) {
			setCollapsedSpans(getAutoExpanded())
			setExpandedSpan(null)
		}
	}, [spans, getAutoExpanded])

	const toggleCollapse = (spanId: string) => {
		setCollapsedSpans(prev => {
			const next = new Set(prev)
			if (next.has(spanId)) {
				next.delete(spanId)
			} else {
				next.add(spanId)
			}
			return next
		})
	}

	function flattenTree(parentId: string | null, depth: number): Array<{ span: SpanData; depth: number }> {
		const children = childMap.get(parentId) ?? []
		const result: Array<{ span: SpanData; depth: number }> = []
		for (const child of children) {
			result.push({ span: child, depth })
			if (!collapsedSpans.has(child.spanId)) {
				result.push(...flattenTree(child.spanId, depth + 1))
			}
		}
		return result
	}

	const flatSpans = flattenTree(null, 0)

	// Get parent span attributes for filtering inherited attrs
	const getParentAttributes = (span: SpanData): Record<string, unknown> => {
		if (!span.parentSpanId) return {}
		const parent = spanMap.get(span.parentSpanId)
		return parent?.attributes ?? {}
	}

	return (
		<div>
			{/* Timeline header */}
			<div class="flex items-center justify-between mb-3">
				<span class="text-xs text-text-muted font-mono">0ms</span>
				<span class="text-xs text-text-muted font-mono">{formatDuration(traceDuration)}</span>
			</div>

			{/* Waterfall */}
			<div class="space-y-0.5">
				{flatSpans.map(({ span, depth }) => {
					const offset = ((span.startTime - traceStart) / traceDuration) * 100
					const width = (((span.endTime ?? Date.now()) - span.startTime) / traceDuration) * 100
					const spanEvents = events.filter(e => e.spanId === span.spanId)
					const isExpanded = expandedSpan === span.spanId
					const hasChildren = (childMap.get(span.spanId) ?? []).length > 0
					const isCollapsed = collapsedSpans.has(span.spanId)
					const parentAttrs = getParentAttributes(span)
					const isHighlighted = highlightSpanId === span.spanId

					// Key attributes to show in the bar
					const keyAttrs = width > 5 ? getKeyAttributes(span.attributes, 2) : []

					return (
						<div key={span.spanId}>
							<div
								class={`flex items-center cursor-pointer hover:bg-panel-hover rounded-md py-1 px-1 transition-colors`}
								style={isHighlighted ? { background: 'var(--color-error-highlight)', boxShadow: `inset 0 0 0 2px var(--color-span-error)` } : undefined}
								onClick={() => setExpandedSpan(isExpanded ? null : span.spanId)}
							>
								{/* Span name with collapse toggle */}
								<div class="w-[200px] flex-shrink-0 truncate text-xs text-ink flex items-center" style={{ paddingLeft: `${depth * 16}px` }}>
									{hasChildren && (
										<span
											class="inline-block w-4 text-text-muted cursor-pointer select-none flex-shrink-0"
											onClick={(e) => {
												e.stopPropagation()
												toggleCollapse(span.spanId)
											}}
										>
											{isCollapsed ? '\u25B6' : '\u25BC'}
										</span>
									)}
									{!hasChildren && <span class="inline-block w-4 flex-shrink-0" />}
									<span class="truncate">{span.name}</span>
								</div>
								{/* Bar area */}
								<div class="flex-1 h-6 relative bg-panel-secondary rounded">
									<div
										class={`absolute top-0.5 bottom-0.5 rounded flex items-center overflow-hidden ${
											span.status !== 'error' && span.status !== 'ok' ? 'animate-pulse' : ''
										}`}
										style={{
											left: `${offset}%`,
											width: `${Math.max(width, 0.5)}%`,
											background: span.status === 'error' ? 'var(--color-span-error)' : span.status === 'ok' ? 'var(--color-span-ok)' : '#d1d5db',
										}}
									>
										{/* Key attributes inside bar */}
										{keyAttrs.length > 0 && (
											<span class="text-[9px] text-white px-1 truncate whitespace-nowrap">
												{keyAttrs.map(([k, v]) => `${k}=${String(v)}`).join(' ')}
											</span>
										)}
										{/* Event markers */}
										{spanEvents.map(ev => {
											const evOffset = ((ev.timestamp - span.startTime) / ((span.endTime ?? Date.now()) - span.startTime || 1)) * 100
											return (
												<div
													key={ev.id}
													class={`absolute top-0 w-1.5 h-full rounded-full ${ev.name === 'exception' ? 'bg-red-600' : 'bg-panel-secondary0'}`}
													style={{ left: `${Math.min(evOffset, 100)}%` }}
													title={ev.message ?? ev.name}
												/>
											)
										})}
									</div>
									{/* Duration label */}
									<span
										class="absolute top-0.5 text-[10px] text-text-secondary whitespace-nowrap"
										style={{ left: `${offset + width + 1}%` }}
									>
										{span.durationMs !== null ? formatDuration(span.durationMs) : '...'}
									</span>
								</div>
							</div>

							{/* Expanded detail */}
							{isExpanded && (
								<div class="bg-panel-secondary border border-border-subtle rounded-lg p-4 mt-1 mb-2 ml-4">
									<div class="text-xs space-y-3">
										{/* Timing section */}
										<div class="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1.5 items-baseline">
											<span class="text-text-muted">Kind:</span> <span class="text-ink">{span.kind}</span>
											<span class="text-text-muted">Status:</span> <TraceStatusBadge status={span.status} />
											<span class="text-text-muted">Start:</span> <span class="text-ink font-mono">{formatTimestamp(span.startTime)}</span>
											<span class="text-text-muted">End:</span> <span class="text-ink font-mono">{span.endTime ? formatTimestamp(span.endTime) : '...'}</span>
											<span class="text-text-muted">Duration:</span>{' '}
											<span class="text-ink font-mono">{span.durationMs !== null ? formatDuration(span.durationMs) : '...'}</span>
											<span class="text-text-muted">Trace ID:</span> <span class="text-ink font-mono">{span.traceId.slice(0, 16)}...</span>
											{span.parentSpanId && (
												<>
													<span class="text-text-muted">Parent:</span> <span class="text-ink font-mono">{span.parentSpanId.slice(0, 16)}...</span>
												</>
											)}
										</div>
										{span.statusMessage && (
											<div>
												<span class="text-text-muted">Error:</span>
												<span class="ml-2 text-red-500">{span.statusMessage}</span>
											</div>
										)}
										{/* Attributes (filtered: inherited removed) */}
										{Object.keys(span.attributes).length > 0 && (() => {
											const filteredAttrs = Object.entries(span.attributes).filter(([k, v]) => {
												const parentVal = parentAttrs[k]
												return parentVal === undefined || JSON.stringify(parentVal) !== JSON.stringify(v)
											})
											if (filteredAttrs.length === 0) return null
											return (
												<div>
													<div class="text-text-muted mb-1.5 font-medium">Attributes:</div>
													<div class="space-y-1.5">
														{filteredAttrs.map(([k, v]) => {
															const isComplex = typeof v === 'object'
																|| (typeof v === 'string' && (v.includes('\n') || (v.startsWith('{') || v.startsWith('[')) && v.length > 2))
															return (
																<div key={k} class="group">
																	<div class="flex items-center gap-1.5">
																		<span class="text-text-secondary font-mono text-[11px]">{k}</span>
																		{onAddAttributeFilter && (
																			<span class="invisible group-hover:visible flex gap-0.5">
																				<button
																					onClick={(e) => {
																						e.stopPropagation()
																						onAddAttributeFilter(k, String(v), 'include')
																					}}
																					class="text-emerald-500 hover:text-emerald-700 text-[10px] leading-none"
																					title="Include filter"
																				>
																					+
																				</button>
																				<button
																					onClick={(e) => {
																						e.stopPropagation()
																						onAddAttributeFilter(k, String(v), 'exclude')
																					}}
																					class="text-red-500 hover:text-red-700 text-[10px] leading-none"
																					title="Exclude filter"
																				>
																					{'\u2212'}
																				</button>
																			</span>
																		)}
																		{!isComplex && (
																			<span class="font-mono text-[11px] ml-auto">
																				<AttributeValue value={v} />
																			</span>
																		)}
																	</div>
																	{isComplex && (
																		<div class="mt-0.5 font-mono text-[11px]">
																			<AttributeValue value={v} />
																		</div>
																	)}
																</div>
															)
														})}
													</div>
												</div>
											)
										})()}
										{/* Events */}
										{spanEvents.length > 0 && (
											<div>
												<div class="text-text-muted mb-1">Events:</div>
												{spanEvents.map(ev => (
													<div
														key={ev.id}
														class={`py-1 px-2 rounded-md mb-1 ${ev.name !== 'exception' ? 'bg-panel border border-border-subtle' : ''}`}
														style={ev.name === 'exception' ? { background: 'var(--color-error-highlight)' } : undefined}
													>
														<div class="flex items-center gap-2">
															<span class="font-medium">{ev.name}</span>
															{ev.level && <EventLevelBadge level={ev.level} />}
															<span class="text-text-muted font-mono ml-auto">
																+{Math.round(ev.timestamp - span.startTime)}ms
															</span>
														</div>
														{ev.message && <div class="text-text-data mt-0.5 font-mono break-all">{ev.message}</div>}
													</div>
												))}
											</div>
										)}
									</div>
								</div>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}

// ─── Smart Attribute Rendering ───────────────────────────────────────

const URL_REGEX = /^https?:\/\/[^\s]+$/

function CollapsibleBlock({ content, lines }: { content: string; lines: number }) {
	const [expanded, setExpanded] = useState(false)
	const isLong = lines > 8

	return (
		<div class="relative">
			<pre
				class={`text-ink bg-panel border border-border p-2 rounded-md overflow-x-auto text-[11px] whitespace-pre-wrap break-all ${
					isLong && !expanded ? 'max-h-[160px] overflow-hidden' : ''
				}`}
			>{content}</pre>
			{isLong && (
				<button
					onClick={(e) => {
						e.stopPropagation()
						setExpanded(!expanded)
					}}
					class={`text-[10px] text-link hover:text-accent-lime font-medium mt-0.5 ${
						!expanded ? 'absolute bottom-0 left-0 right-0 pt-6 pb-1 text-center bg-gradient-to-t from-panel via-panel/90 to-transparent rounded-b-md' : ''
					}`}
				>
					{expanded ? 'Show less' : `Show all (${lines} lines)`}
				</button>
			)}
		</div>
	)
}

export function AttributeValue({ value }: { value: unknown }) {
	if (value === null || value === undefined) {
		return <span class="text-text-muted italic">null</span>
	}
	if (typeof value === 'boolean') {
		return <span class="text-orange-600">{String(value)}</span>
	}
	if (typeof value === 'number') {
		return <span class="text-purple-600">{value}</span>
	}
	if (typeof value === 'object') {
		const formatted = JSON.stringify(value, null, 2)
		const lines = formatted.split('\n').length
		return <CollapsibleBlock content={formatted} lines={lines} />
	}
	const str = String(value)
	if (URL_REGEX.test(str)) {
		return <a href={str} target="_blank" rel="noopener noreferrer" class="text-link hover:underline break-all">{str}</a>
	}
	// Try JSON
	if ((str.startsWith('{') || str.startsWith('[')) && str.length > 2) {
		try {
			const parsed = JSON.parse(str)
			const formatted = JSON.stringify(parsed, null, 2)
			const lines = formatted.split('\n').length
			return <CollapsibleBlock content={formatted} lines={lines} />
		} catch {}
	}
	// Multiline
	if (str.includes('\n')) {
		const lines = str.split('\n').length
		return <CollapsibleBlock content={str} lines={lines} />
	}
	return <span class="text-ink">{str}</span>
}

// ─── Shared Helpers ──────────────────────────────────────────────────

export function EventLevelBadge({ level }: { level: string }) {
	const upper = level.toUpperCase()
	const styles: Record<string, { bg: string; color: string } | null> = {
		ERROR: { bg: 'var(--color-badge-red-bg)', color: 'var(--color-badge-red-text)' },
		WARN: { bg: 'var(--color-badge-orange-bg)', color: 'var(--color-badge-orange-text)' },
		WARNING: { bg: 'var(--color-badge-orange-bg)', color: 'var(--color-badge-orange-text)' },
		INFO: { bg: 'var(--color-badge-blue-bg)', color: 'var(--color-badge-blue-text)' },
		LOG: null,
		DEBUG: null,
	}
	const s = styles[upper]
	return (
		<span
			class={`inline-flex px-1.5 py-0.5 rounded-md text-[10px] font-medium ${!s ? 'bg-panel-secondary text-text-secondary' : ''}`}
			style={s ? { background: s.bg, color: s.color } : undefined}
		>
			{upper}
		</span>
	)
}

export function TraceStatusBadge({ status }: { status: string }) {
	const styles: Record<string, { bg: string; color: string } | null> = {
		ok: { bg: 'var(--color-badge-emerald-bg)', color: 'var(--color-badge-emerald-text)' },
		error: { bg: 'var(--color-badge-red-bg)', color: 'var(--color-badge-red-text)' },
		unset: null,
	}
	const s = styles[status]
	return (
		<span
			class={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${!s ? 'bg-panel-hover text-text-secondary' : ''} ${
				status === 'unset' ? 'animate-pulse' : ''
			}`}
			style={s ? { background: s.bg, color: s.color } : undefined}
		>
			{status === 'unset' ? 'running' : status}
		</span>
	)
}

export function getKeyAttributes(attrs: Record<string, unknown>, max: number): [string, unknown][] {
	const priorityKeys = ['http.method', 'http.status_code', 'http.url', 'http.route', 'db.system', 'db.operation', 'rpc.method']
	const entries = Object.entries(attrs)
	const result: [string, unknown][] = []
	for (const key of priorityKeys) {
		if (result.length >= max) break
		const entry = entries.find(([k]) => k === key)
		if (entry) result.push(entry)
	}
	if (result.length < max) {
		for (const entry of entries) {
			if (result.length >= max) break
			if (!result.some(([k]) => k === entry[0]) && typeof entry[1] !== 'object') {
				result.push(entry)
			}
		}
	}
	return result
}

export function formatDuration(ms: number): string {
	if (ms < 1) return '<1ms'
	if (ms < 1000) return `${Math.round(ms)}ms`
	return `${(ms / 1000).toFixed(2)}s`
}

export function formatTimestamp(ts: number): string {
	const d = new Date(ts)
	return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${
		d.getMilliseconds().toString().padStart(3, '0')
	}`
}
