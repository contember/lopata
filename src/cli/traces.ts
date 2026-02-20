import { getTracingDatabase } from '../tracing/db'
import { TraceStore } from '../tracing/store'
import type { SpanData, SpanEventData } from '../tracing/types'
import type { CliContext } from './context'
import { hasFlag, parseFlag } from './context'

const USAGE = `Usage:
  lopata trace list [options]   List traces
  lopata trace get <traceId>    Get trace detail

Options:
  --json              Output as JSON
  --limit <n>         Max results (default 50)
  --since <dur>       Show traces since duration ago (e.g. 5m, 1h, 2d)
  --search <query>    Filter traces by text search
  --cursor <cursor>   Pagination cursor from previous result`

export async function run(ctx: CliContext, args: string[]) {
	const action = args[0]
	const db = getTracingDatabase()
	const store = new TraceStore(db)
	const json = hasFlag(ctx.args, '--json')

	switch (action) {
		case 'list': {
			const limitStr = parseFlag(ctx.args, '--limit')
			const limit = limitStr ? parseInt(limitStr, 10) : 50
			const since = parseFlag(ctx.args, '--since')
			const search = parseFlag(ctx.args, '--search')
			const cursor = parseFlag(ctx.args, '--cursor')

			let items: Array<
				{
					traceId: string
					rootSpanName: string
					workerName: string | null
					status: string
					statusMessage: string | null
					startTime: number
					durationMs: number | null
					spanCount: number
					errorCount: number
				}
			>
			let nextCursor: string | null

			if (search) {
				const result = store.searchTraces(search, limit)
				items = result.items
				nextCursor = result.cursor
			} else if (since) {
				const sinceMs = Date.now() - parseDuration(since)
				items = store.getRecentTraces(sinceMs, limit)
				nextCursor = null
			} else {
				const result = store.listTraces({ limit, cursor })
				items = result.items
				nextCursor = result.cursor
			}

			if (json) {
				console.log(JSON.stringify({ items, cursor: nextCursor }, null, 2))
			} else {
				printTraceList(items, nextCursor)
			}
			break
		}
		case 'get': {
			const traceId = args[1]
			if (!traceId) {
				console.error('Usage: lopata trace get <traceId>')
				process.exit(1)
			}

			const { spans, events } = store.getTrace(traceId)
			if (spans.length === 0) {
				console.error(`Trace not found: ${traceId}`)
				process.exit(1)
			}

			const errors = store.getErrorsForTrace(traceId)

			if (json) {
				console.log(JSON.stringify({ traceId, spans, events, errors }, null, 2))
			} else {
				printTraceDetail(traceId, spans, events, errors)
			}
			break
		}
		default:
			console.error(USAGE)
			process.exit(1)
	}
}

// ─── Text output: list ───────────────────────────────────────────────

function printTraceList(
	items: Array<
		{ traceId: string; rootSpanName: string; status: string; startTime: number; durationMs: number | null; spanCount: number; errorCount: number }
	>,
	cursor: string | null,
) {
	if (items.length === 0) {
		console.log('(no traces)')
		return
	}

	const header = 'TIME                STATUS  DURATION  SPANS  ERRORS  NAME'
	const sep = '─'.repeat(header.length)
	console.log(header)
	console.log(sep)

	for (const t of items) {
		const time = fmtTime(t.startTime)
		const status = statusIcon(t.status) + ' ' + t.status.padEnd(5)
		const dur = t.durationMs !== null ? `${t.durationMs.toFixed(0)}ms`.padStart(6) : '   ...'
		const spans = String(t.spanCount).padStart(5)
		const errs = t.errorCount > 0 ? String(t.errorCount).padStart(6) : '     -'
		console.log(`${time}  ${status}  ${dur}  ${spans}  ${errs}  ${t.rootSpanName}`)
	}

	console.log(sep)
	console.log(`${items.length} trace(s)` + (items.length > 0 ? `  oldest id: ${items[items.length - 1]!.traceId}` : ''))

	if (cursor) {
		console.log(`\nMore results available. Use --cursor ${cursor}`)
	}
}

// ─── Text output: get ────────────────────────────────────────────────

function printTraceDetail(
	traceId: string,
	spans: SpanData[],
	events: SpanEventData[],
	errors: Array<{ id: string; timestamp: number; errorName: string; errorMessage: string; source: string | null; data: unknown }>,
) {
	const root = spans.find(s => !s.parentSpanId)
	const totalDuration = root?.durationMs
	const startTime = root?.startTime ?? spans[0]!.startTime

	// Header
	console.log(`Trace ${traceId}`)
	console.log(
		`Status: ${statusIcon(root?.status ?? 'unset')} ${root?.status ?? 'unset'}  |  Duration: ${
			fmtDuration(totalDuration)
		}  |  Spans: ${spans.length}  |  Started: ${fmtTime(startTime)}`,
	)
	if (root?.workerName) console.log(`Worker: ${root.workerName}`)

	// Span tree
	console.log('\nSpans')
	const spanMap = new Map(spans.map(s => [s.spanId, s]))
	const children = new Map<string | null, SpanData[]>()
	for (const s of spans) {
		const pid = s.parentSpanId ?? null
		if (!children.has(pid)) children.set(pid, [])
		children.get(pid)!.push(s)
	}
	const rootSpans = children.get(null) ?? []
	for (let i = 0; i < rootSpans.length; i++) {
		printSpanTree(rootSpans[i]!, children, '', i === rootSpans.length - 1)
	}

	// Events
	if (events.length > 0) {
		console.log('\nEvents')
		for (const e of events) {
			const ts = fmtTimestamp(e.timestamp)
			const level = e.level ? `[${e.level}]`.padEnd(8) : '        '
			const msg = e.message ?? e.name
			const spanName = spanMap.get(e.spanId)?.name
			const spanRef = spanName ? `  (${spanName})` : ''
			console.log(`  ${ts}  ${level} ${msg}${spanRef}`)
		}
	}

	// Errors
	if (errors.length > 0) {
		console.log('\nErrors')
		for (const e of errors) {
			const ts = fmtTimestamp(e.timestamp)
			console.log(`  ${ts}  \x1b[31m${e.errorName}: ${e.errorMessage}\x1b[0m` + (e.source ? `  [${e.source}]` : ''))
			const stack = extractStack(e.data)
			if (stack) {
				for (const line of stack) {
					console.log(`           \x1b[2m${line}\x1b[0m`)
				}
			}
		}
	}
}

function printSpanTree(span: SpanData, children: Map<string | null, SpanData[]>, prefix: string, isLast: boolean) {
	const connector = isLast ? '└─ ' : '├─ '
	const status = statusIcon(span.status)
	const dur = fmtDuration(span.durationMs)
	const kind = span.kind !== 'internal' ? ` [${span.kind}]` : ''
	const errMsg = span.status === 'error' && span.statusMessage ? `: ${span.statusMessage}` : ''
	console.log(`${prefix}${connector}${status} ${span.name}${kind}  ${span.status} ${dur}${errMsg}`)

	const attrs = span.attributes
	if (attrs && Object.keys(attrs).length > 0) {
		const attrPrefix = prefix + (isLast ? '   ' : '│  ')
		for (const [k, v] of Object.entries(attrs)) {
			console.log(`${attrPrefix}  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
		}
	}

	const kids = children.get(span.spanId) ?? []
	const childPrefix = prefix + (isLast ? '   ' : '│  ')
	for (let i = 0; i < kids.length; i++) {
		printSpanTree(kids[i]!, children, childPrefix, i === kids.length - 1)
	}
}

// ─── Formatting helpers ──────────────────────────────────────────────

function statusIcon(status: string): string {
	switch (status) {
		case 'ok':
			return '\x1b[32m✓\x1b[0m'
		case 'error':
			return '\x1b[31m✗\x1b[0m'
		default:
			return '\x1b[33m●\x1b[0m'
	}
}

function fmtTime(ms: number): string {
	return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function fmtTimestamp(ms: number): string {
	return new Date(ms).toISOString().slice(11, 23)
}

function fmtDuration(ms: number | null | undefined): string {
	if (ms == null) return '...'
	if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`
	if (ms < 1000) return `${ms.toFixed(0)}ms`
	return `${(ms / 1000).toFixed(2)}s`
}

function extractStack(data: unknown): string[] | null {
	if (!data || typeof data !== 'object') return null
	const d = data as Record<string, unknown>
	const error = d.error as Record<string, unknown> | undefined
	const stack = error?.stack
	if (typeof stack !== 'string') return null
	// Stack lines start with "    at " — skip the first line (error name: message, already printed)
	const lines = stack.split('\n')
	const frameLines = lines.filter(l => l.trimStart().startsWith('at '))
	return frameLines.length > 0 ? frameLines.map(l => l.trim()) : null
}

function parseDuration(s: string): number {
	const match = s.match(/^(\d+)(s|m|h|d)$/)
	if (!match) {
		console.error(`Invalid duration: ${s} (use e.g. 5m, 1h, 2d)`)
		process.exit(1)
	}
	const n = parseInt(match[1]!, 10)
	switch (match[2]) {
		case 's':
			return n * 1000
		case 'm':
			return n * 60_000
		case 'h':
			return n * 3_600_000
		case 'd':
			return n * 86_400_000
		default:
			return n * 60_000
	}
}
