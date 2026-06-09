import { ExecutionContext } from '../execution-context'
import { persistError, startSpan } from '../tracing/span'

export interface ScheduledController {
	readonly scheduledTime: number
	readonly cron: string
	readonly type: 'scheduled'
	noRetry(): void
}

// A CronField matcher that can check a value, optionally with full date context
type CronFieldMatcher = (value: number, date: Date) => boolean

interface CronField {
	match: CronFieldMatcher
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

/** Get the last day of a given month (1-indexed) */
function lastDayOfMonth(year: number, month: number): number {
	return new Date(year, month, 0).getDate()
}

/** Get the day-of-week (0=Sun) for a given date */
function dayOfWeekFor(year: number, month: number, day: number): number {
	return new Date(year, month - 1, day).getDay()
}

/** Find nearest weekday to the given day in the given month */
function nearestWeekday(year: number, month: number, day: number): number {
	const lastDay = lastDayOfMonth(year, month)
	day = Math.min(day, lastDay)
	const dow = dayOfWeekFor(year, month, day)
	if (dow >= 1 && dow <= 5) return day // already weekday
	if (dow === 6) {
		// Saturday → Friday or Monday
		return day > 1 ? day - 1 : day + 2
	}
	// Sunday → Monday or Friday
	return day < lastDay ? day + 1 : day - 2
}

/** Find the Nth occurrence of a weekday in a month (1-based N) */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number | null {
	let count = 0
	const lastDay = lastDayOfMonth(year, month)
	for (let d = 1; d <= lastDay; d++) {
		if (dayOfWeekFor(year, month, d) === weekday) {
			count++
			if (count === n) return d
		}
	}
	return null // Nth occurrence doesn't exist
}

/** Find the last occurrence of a weekday in a month */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
	const lastDay = lastDayOfMonth(year, month)
	for (let d = lastDay; d >= 1; d--) {
		if (dayOfWeekFor(year, month, d) === weekday) return d
	}
	return lastDay // should never reach here
}

type FieldType = 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek'

function parseField(field: string, min: number, max: number, fieldType: FieldType, names: Record<string, number> | null = null): CronField {
	if (field === '*') {
		return { match: () => true }
	}

	// Collect matchers for each comma-separated part
	const matchers: CronFieldMatcher[] = []

	for (const part of field.split(',')) {
		// LW — last weekday of month (day-of-month field only)
		if (fieldType === 'dayOfMonth' && part.toUpperCase() === 'LW') {
			matchers.push((_value, date) => {
				const year = date.getFullYear()
				const month = date.getMonth() + 1
				const last = lastDayOfMonth(year, month)
				const dow = dayOfWeekFor(year, month, last)
				let lw: number
				if (dow === 0) lw = last - 2 // Sun → Fri
				else if (dow === 6) lw = last - 1 // Sat → Fri
				else lw = last
				return date.getDate() === lw
			})
			continue
		}

		// L in day-of-month — last day of month
		if (fieldType === 'dayOfMonth' && part.toUpperCase() === 'L') {
			matchers.push((_value, date) => {
				return date.getDate() === lastDayOfMonth(date.getFullYear(), date.getMonth() + 1)
			})
			continue
		}

		// W in day-of-month — nearest weekday (e.g. 15W)
		if (fieldType === 'dayOfMonth') {
			const wMatch = part.match(/^(\d+)W$/i)
			if (wMatch) {
				const targetDay = parseInt(wMatch[1]!, 10)
				matchers.push((_value, date) => {
					return date.getDate() === nearestWeekday(date.getFullYear(), date.getMonth() + 1, targetDay)
				})
				continue
			}
		}

		// # in day-of-week — Nth occurrence (e.g. 2#3 = 3rd Tuesday)
		if (fieldType === 'dayOfWeek') {
			const hashMatch = part.match(/^([a-zA-Z0-9]+)#(\d+)$/)
			if (hashMatch) {
				const weekday = resolveToken(hashMatch[1]!, names)
				const n = parseInt(hashMatch[2]!, 10)
				matchers.push((_value, date) => {
					const nth = nthWeekdayOfMonth(date.getFullYear(), date.getMonth() + 1, weekday, n)
					return nth !== null && date.getDate() === nth
				})
				continue
			}
		}

		// L in day-of-week — last occurrence of that weekday (e.g. 5L or FRIL)
		if (fieldType === 'dayOfWeek') {
			const lMatch = part.match(/^([a-zA-Z0-9]+)L$/i)
			if (lMatch) {
				const weekday = resolveToken(lMatch[1]!, names)
				matchers.push((_value, date) => {
					const last = lastWeekdayOfMonth(date.getFullYear(), date.getMonth() + 1, weekday)
					return date.getDate() === last
				})
				continue
			}
		}

		// Step: */2 or 1-5/2
		const stepMatch = part.match(/^(\*|([a-zA-Z0-9]+)-([a-zA-Z0-9]+))\/(\d+)$/)
		if (stepMatch) {
			const step = parseInt(stepMatch[4]!, 10)
			const start = stepMatch[1] === '*' ? min : resolveToken(stepMatch[2]!, names)
			const end = stepMatch[1] === '*' ? max : resolveToken(stepMatch[3]!, names)
			const values: number[] = []
			for (let i = start; i <= end; i += step) {
				values.push(i)
			}
			matchers.push((value) => values.includes(value))
			continue
		}

		// Range: 1-5
		const rangeMatch = part.match(/^([a-zA-Z0-9]+)-([a-zA-Z0-9]+)$/)
		if (rangeMatch) {
			const start = resolveToken(rangeMatch[1]!, names)
			const end = resolveToken(rangeMatch[2]!, names)
			const values: number[] = []
			for (let i = start; i <= end; i++) {
				values.push(i)
			}
			matchers.push((value) => values.includes(value))
			continue
		}

		// Single value
		const val = resolveToken(part, names)
		matchers.push((value) => value === val)
	}

	return {
		match: (value, date) => matchers.some(m => m(value, date)),
	}
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
		minute: parseField(parts[0]!, 0, 59, 'minute'),
		hour: parseField(parts[1]!, 0, 23, 'hour'),
		dayOfMonth: parseField(parts[2]!, 1, 31, 'dayOfMonth'),
		month: parseField(parts[3]!, 1, 12, 'month', MONTH_NAMES),
		dayOfWeek: parseField(parts[4]!, 0, 6, 'dayOfWeek', DAY_NAMES),
	}
}

export function cronMatchesDate(cron: ParsedCron, date: Date): boolean {
	return (
		cron.minute.match(date.getMinutes(), date)
		&& cron.hour.match(date.getHours(), date)
		&& cron.dayOfMonth.match(date.getDate(), date)
		&& cron.month.match(date.getMonth() + 1, date)
		&& cron.dayOfWeek.match(date.getDay(), date)
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

/**
 * Generic cron timer. `invoke` is called with the matched expression and the
 * tick time; the caller decides how to dispatch (in-process handler vs RPC).
 */
export function startCronTimer(
	crons: string[],
	invoke: (cronExpr: string, now: Date) => Promise<unknown>,
	workerName?: string,
): NodeJS.Timer {
	const parsed = crons.map(parseCron)

	// Poll a few times per minute and fire each cron at most once per matching
	// wall-clock minute. `setInterval` is NOT minute-aligned (it fires relative
	// to creation, and HMR reload resets that phase), so a once-per-60s check
	// could drift past a matching minute or land on it twice. Polling at 15s +
	// per-minute dedup makes firing robust to that drift within a generation.
	const lastFiredMinute = new Map<number, number>()
	return setInterval(() => {
		const now = new Date()
		const minuteKey = Math.floor(now.getTime() / 60_000)
		parsed.forEach((cron, i) => {
			if (!cronMatchesDate(cron, now)) return
			if (lastFiredMinute.get(i) === minuteKey) return
			lastFiredMinute.set(i, minuteKey)
			console.log(`[lopata] Cron triggered: ${cron.expression}`)
			startSpan({
				name: 'scheduled',
				kind: 'server',
				attributes: { cron: cron.expression },
				workerName,
			}, () => invoke(cron.expression, now)).catch((err) => {
				console.error(`[lopata] Scheduled handler error (${cron.expression}):`, err)
				persistError(err, 'scheduled', workerName)
			})
		})
	}, 15_000)
}

export function startCronScheduler(
	crons: string[],
	handler: ScheduledHandler,
	env: Record<string, unknown>,
	workerName?: string,
): NodeJS.Timer {
	return startCronTimer(crons, async (cronExpr, now) => {
		const controller = createScheduledController(cronExpr, now.getTime())
		const ctx = new ExecutionContext()
		await handler(controller, env, ctx)
		await ctx._awaitAll()
	}, workerName)
}
