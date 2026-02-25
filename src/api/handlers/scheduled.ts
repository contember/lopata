import type { HandlerContext, OkResponse } from '../types'
import { getAllConfigs } from '../types'

export interface ScheduledTrigger {
	expression: string
	description: string
	workerName: string | null
}

export const handlers = {
	'scheduled.listTriggers'(_input: {}, ctx: HandlerContext): ScheduledTrigger[] {
		const triggers: ScheduledTrigger[] = []

		if (ctx.registry) {
			for (const [name, mgr] of ctx.registry.listManagers()) {
				for (const cron of mgr.config.triggers?.crons ?? []) {
					triggers.push({ expression: cron, description: cronToHuman(cron), workerName: name })
				}
			}
		} else if (ctx.config) {
			for (const cron of ctx.config.triggers?.crons ?? []) {
				triggers.push({ expression: cron, description: cronToHuman(cron), workerName: null })
			}
		}

		return triggers
	},

	async 'scheduled.trigger'({ cron, workerName }: { cron: string; workerName?: string | null }, ctx: HandlerContext): Promise<OkResponse> {
		// biome-ignore lint/suspicious/noImplicitAnyLet: type inferred from Generation assignment
		let gen
		if (workerName && ctx.registry) {
			const mgr = ctx.registry.listManagers().get(workerName)
			gen = mgr?.active
		} else {
			gen = ctx.manager?.active
		}
		if (!gen) throw new Error('No active generation')
		const res = await gen.callScheduled(cron)
		if (!res.ok) {
			const text = await res.text()
			throw new Error(text || `Scheduled handler failed with status ${res.status}`)
		}
		return { ok: true }
	},
}

const SPECIAL_DESCRIPTIONS: Record<string, string> = {
	'@daily': 'Every day at midnight',
	'@midnight': 'Every day at midnight',
	'@hourly': 'Every hour',
	'@weekly': 'Every week (Sunday midnight)',
	'@monthly': 'First day of every month',
	'@yearly': 'First day of every year',
	'@annually': 'First day of every year',
}

const DOW_NAMES: Record<string, string> = {
	'0': 'Sunday',
	'1': 'Monday',
	'2': 'Tuesday',
	'3': 'Wednesday',
	'4': 'Thursday',
	'5': 'Friday',
	'6': 'Saturday',
	'7': 'Sunday',
}
const MONTH_NAMES: Record<string, string> = {
	'1': 'January',
	'2': 'February',
	'3': 'March',
	'4': 'April',
	'5': 'May',
	'6': 'June',
	'7': 'July',
	'8': 'August',
	'9': 'September',
	'10': 'October',
	'11': 'November',
	'12': 'December',
}

function formatTime(hour: string, minute: string): string {
	return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
}

function formatDow(dow: string): string {
	if (dow === '1-5') return 'weekdays'
	if (dow === '0,6' || dow === '6,0') return 'weekends'
	const names = dow.split(',').map(d => DOW_NAMES[d] ?? d)
	return names.join(', ')
}

function formatMonth(month: string): string {
	return month.split(',').map(m => MONTH_NAMES[m] ?? m).join(', ')
}

function cronToHuman(expression: string): string {
	const trimmed = expression.trim()
	const special = SPECIAL_DESCRIPTIONS[trimmed.toLowerCase()]
	if (special) return special

	const parts = trimmed.split(/\s+/)
	if (parts.length !== 5) return expression

	const [minute, hour, dom, month, dow] = parts

	if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
		return 'Every minute'
	}

	// Step patterns: */N
	if (minute!.startsWith('*/')) {
		const n = minute!.slice(2)
		return n === '1' ? 'Every minute' : `Every ${n} minutes`
	}
	if (hour!.startsWith('*/') && minute === '0') {
		const n = hour!.slice(2)
		return n === '1' ? 'Every hour' : `Every ${n} hours`
	}

	const allDates = dom === '*' && month === '*' && dow === '*'

	// minute=0, hour=* → "Every hour"
	if (minute === '0' && hour === '*' && allDates) {
		return 'Every hour'
	}

	// minute=N, hour=* → "Every hour at minute N"
	if (minute !== '*' && hour === '*' && allDates) {
		return `Every hour at minute ${minute}`
	}

	// Build description from time + date constraints
	const segments: string[] = []

	// Time part
	if (hour !== '*' && minute !== '*') {
		segments.push(`At ${formatTime(hour!, minute!)}`)
	} else if (minute !== '*' && hour === '*') {
		segments.push(`At minute ${minute}`)
	} else if (hour !== '*' && minute === '*') {
		segments.push(`Every minute of hour ${hour}`)
	}

	// Frequency context
	if (hour !== '*' && minute !== '*') {
		if (dom === '*' && month === '*' && dow === '*') {
			segments.unshift('Every day')
		}
	}

	// Date constraints
	if (dow !== '*') segments.push(`on ${formatDow(dow!)}`)
	if (dom !== '*') segments.push(`on day ${dom} of the month`)
	if (month !== '*') segments.push(`in ${formatMonth(month!)}`)

	return segments.join(' ') || expression
}
