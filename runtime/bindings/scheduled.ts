import { ExecutionContext } from '../execution-context'
import { persistError, startSpan } from '../tracing/span'

export interface ScheduledController {
	readonly scheduledTime: number
	readonly cron: string
	readonly type: 'scheduled'
	noRetry(): void
}

interface CronField {
	type: 'any' | 'values'
	values: number[]
}

interface ParsedCron {
	expression: string
	minute: CronField
	hour: CronField
	dayOfMonth: CronField
	month: CronField
	dayOfWeek: CronField
}

const DAY_NAMES: Record<string, number> = {
	SUN: 0,
	MON: 1,
	TUE: 2,
	WED: 3,
	THU: 4,
	FRI: 5,
	SAT: 6,
}

const MONTH_NAMES: Record<string, number> = {
	JAN: 1,
	FEB: 2,
	MAR: 3,
	APR: 4,
	MAY: 5,
	JUN: 6,
	JUL: 7,
	AUG: 8,
	SEP: 9,
	OCT: 10,
	NOV: 11,
	DEC: 12,
}

const SPECIAL_CRONS: Record<string, string> = {
	'@daily': '0 0 * * *',
	'@midnight': '0 0 * * *',
	'@hourly': '0 * * * *',
	'@weekly': '0 0 * * 0',
	'@monthly': '0 0 1 * *',
	'@yearly': '0 0 1 1 *',
	'@annually': '0 0 1 1 *',
}

function resolveToken(token: string, names: Record<string, number> | null): number {
	if (names) {
		const upper = token.toUpperCase()
		if (upper in names) return names[upper]!
	}
	return parseInt(token, 10)
}

function parseField(field: string, min: number, max: number, names: Record<string, number> | null = null): CronField {
	if (field === '*') {
		return { type: 'any', values: [] }
	}

	const values: number[] = []

	for (const part of field.split(',')) {
		const stepMatch = part.match(/^(\*|([a-zA-Z0-9]+)-([a-zA-Z0-9]+))\/(\d+)$/)
		if (stepMatch) {
			const step = parseInt(stepMatch[4]!, 10)
			const start = stepMatch[1] === '*' ? min : resolveToken(stepMatch[2]!, names)
			const end = stepMatch[1] === '*' ? max : resolveToken(stepMatch[3]!, names)
			for (let i = start; i <= end; i += step) {
				values.push(i)
			}
			continue
		}

		const rangeMatch = part.match(/^([a-zA-Z0-9]+)-([a-zA-Z0-9]+)$/)
		if (rangeMatch) {
			const start = resolveToken(rangeMatch[1]!, names)
			const end = resolveToken(rangeMatch[2]!, names)
			for (let i = start; i <= end; i++) {
				values.push(i)
			}
			continue
		}

		values.push(resolveToken(part, names))
	}

	return { type: 'values', values }
}

export function parseCron(expression: string): ParsedCron {
	const trimmed = expression.trim()

	// Handle special cron strings
	const special = SPECIAL_CRONS[trimmed.toLowerCase()]
	if (special) {
		const parsed = parseCron(special)
		parsed.expression = trimmed
		return parsed
	}

	const parts = trimmed.split(/\s+/)
	if (parts.length !== 5) {
		throw new Error(`Invalid cron expression: "${expression}" (expected 5 fields)`)
	}

	return {
		expression: trimmed,
		minute: parseField(parts[0]!, 0, 59),
		hour: parseField(parts[1]!, 0, 23),
		dayOfMonth: parseField(parts[2]!, 1, 31),
		month: parseField(parts[3]!, 1, 12, MONTH_NAMES),
		dayOfWeek: parseField(parts[4]!, 0, 6, DAY_NAMES),
	}
}

function fieldMatches(field: CronField, value: number): boolean {
	if (field.type === 'any') return true
	return field.values.includes(value)
}

export function cronMatchesDate(cron: ParsedCron, date: Date): boolean {
	return (
		fieldMatches(cron.minute, date.getMinutes())
		&& fieldMatches(cron.hour, date.getHours())
		&& fieldMatches(cron.dayOfMonth, date.getDate())
		&& fieldMatches(cron.month, date.getMonth() + 1)
		&& fieldMatches(cron.dayOfWeek, date.getDay())
	)
}

export function createScheduledController(cron: string, scheduledTime: number): ScheduledController {
	return {
		scheduledTime,
		cron,
		type: 'scheduled',
		noRetry() {},
	}
}

type ScheduledHandler = (controller: ScheduledController, env: Record<string, unknown>, ctx: ExecutionContext) => Promise<void>

export function startCronScheduler(
	crons: string[],
	handler: ScheduledHandler,
	env: Record<string, unknown>,
	workerName?: string,
): NodeJS.Timer {
	const parsed = crons.map(parseCron)

	// Check every 60 seconds, aligned to the start of each minute
	const interval = setInterval(() => {
		const now = new Date()
		for (const cron of parsed) {
			if (cronMatchesDate(cron, now)) {
				const controller = createScheduledController(cron.expression, now.getTime())
				const ctx = new ExecutionContext()
				console.log(`[bunflare] Cron triggered: ${cron.expression}`)
				startSpan({
					name: 'scheduled',
					kind: 'server',
					attributes: { cron: cron.expression },
					workerName,
				}, async () => {
					await handler(controller, env, ctx)
					await ctx._awaitAll()
				}).catch((err) => {
					console.error(`[bunflare] Scheduled handler error (${cron.expression}):`, err)
					persistError(err, 'scheduled', workerName)
				})
			}
		}
	}, 60_000)

	return interval
}
