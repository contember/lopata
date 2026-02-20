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

function cronToHuman(expression: string): string {
	const trimmed = expression.trim()
	const special = SPECIAL_DESCRIPTIONS[trimmed.toLowerCase()]
	if (special) return special

	const parts = trimmed.split(/\s+/)
	if (parts.length !== 5) return expression

	const [minute, hour, dom, month, dow] = parts
	const segments: string[] = []

	if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
		return 'Every minute'
	}

	// Detect common patterns
	if (minute!.startsWith('*/')) {
		return `Every ${minute!.slice(2)} minutes`
	}
	if (hour!.startsWith('*/') && minute === '0') {
		return `Every ${hour!.slice(2)} hours`
	}

	if (hour !== '*' && minute !== '*') {
		segments.push(`At ${hour!.padStart(2, '0')}:${minute!.padStart(2, '0')}`)
	} else if (minute !== '*') {
		segments.push(`At minute ${minute}`)
	}

	if (dow !== '*') segments.push(`on day-of-week ${dow}`)
	if (dom !== '*') segments.push(`on day ${dom}`)
	if (month !== '*') segments.push(`in month ${month}`)

	return segments.join(' ') || expression
}
