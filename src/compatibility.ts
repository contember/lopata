export interface CompatibilityInput {
	readonly date?: string
	readonly flags?: readonly string[]
}

export type CompatibilityMode = 'enabled' | 'disabled' | 'legacy-local'

export interface CompatibilitySelection {
	readonly date: string | null
	readonly flags: readonly string[]
	readonly unimplementedFlags: readonly string[]
	readonly deleteAllDeletesAlarm: CompatibilityMode
	readonly websocketCloseReasonByteLimit: CompatibilityMode
	readonly websocketStandardBinaryType: CompatibilityMode
	readonly websocketAutoReplyToClose: CompatibilityMode
	readonly ctxExports: CompatibilityMode
	readonly queuesJsonMessages: CompatibilityMode
	readonly r2ListHonorInclude: CompatibilityMode
}

interface CompatibilityRule {
	readonly enable: string
	/** Absent when workerd defines no flag that turns the behaviour off. */
	readonly disable?: string
	readonly date: string
}

// Pinned to workerd v1.20261005.1, src/workerd/io/compatibility-date.capnp.
const rules = {
	deleteAllDeletesAlarm: { enable: 'delete_all_deletes_alarm', disable: 'delete_all_preserves_alarm', date: '2026-02-24' },
	websocketCloseReasonByteLimit: {
		enable: 'websocket_close_reason_byte_limit',
		disable: 'no_websocket_close_reason_byte_limit',
		date: '2026-03-03',
	},
	websocketStandardBinaryType: {
		enable: 'websocket_standard_binary_type',
		disable: 'no_websocket_standard_binary_type',
		date: '2026-03-17',
	},
	websocketAutoReplyToClose: { enable: 'web_socket_auto_reply_to_close', disable: 'web_socket_manual_reply_to_close', date: '2026-04-07' },
	ctxExports: { enable: 'enable_ctx_exports', disable: 'disable_ctx_exports', date: '2025-11-17' },
	queuesJsonMessages: { enable: 'queues_json_messages', disable: 'no_queues_json_messages', date: '2024-03-18' },
	r2ListHonorInclude: { enable: 'r2_list_honor_include', date: '2022-08-04' },
} satisfies Record<string, CompatibilityRule>
const ruleList: readonly CompatibilityRule[] = Object.values(rules)

function parseDate(value: unknown): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string' || value.length !== 10 || !/^2\d{3}-\d{2}-\d{2}$/.test(value)) {
		throw new TypeError('compatibility date must be YYYY-MM-DD with a year from 2000 to 2999')
	}
	const year = Number(value.slice(0, 4))
	const month = Number(value.slice(5, 7))
	const day = Number(value.slice(8, 10))
	const parsed = new Date(Date.UTC(year, month - 1, day))
	// Unlike workerd's basic month/day parser, local validation rejects impossible calendar days.
	if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
		throw new TypeError('compatibility date must be a valid Gregorian calendar date')
	}
	return value
}

export function parseCompatibility(input: unknown): CompatibilityInput {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new TypeError('compatibility input must be an object')
	}
	const date = parseDate('date' in input ? input.date : undefined)
	const rawFlags: unknown = 'flags' in input ? input.flags : undefined
	let flags: string[] | undefined
	if (rawFlags !== undefined) {
		if (!Array.isArray(rawFlags)) throw new TypeError('compatibility flags must be an array of non-empty strings')
		flags = []
		const seen = new Set<string>()
		for (const flag of rawFlags) {
			if (typeof flag !== 'string' || flag.length === 0) throw new TypeError('compatibility flags must be non-empty strings')
			if (seen.has(flag)) throw new TypeError(`Duplicate compatibility flag: ${flag}`)
			seen.add(flag)
			flags.push(flag)
		}
		for (const rule of ruleList) {
			if (rule.disable !== undefined && seen.has(rule.enable) && seen.has(rule.disable)) {
				throw new TypeError(`Conflicting compatibility flags: ${rule.enable} and ${rule.disable}`)
			}
		}
	}
	return { ...(date === undefined ? {} : { date }), ...(flags === undefined ? {} : { flags }) }
}

export function resolveCompatibility(input: CompatibilityInput): CompatibilitySelection {
	const parsed = parseCompatibility(input)
	const date = parsed.date ?? null
	const flags = Object.freeze([...(parsed.flags ?? [])])
	function select(rule: CompatibilityRule): CompatibilityMode {
		if (flags.includes(rule.enable)) return 'enabled'
		if (rule.disable !== undefined && flags.includes(rule.disable)) return 'disabled'
		if (date === null) return 'legacy-local'
		return date >= rule.date ? 'enabled' : 'disabled'
	}
	return Object.freeze({
		date,
		flags,
		unimplementedFlags: Object.freeze(flags.filter(flag => !ruleList.some(rule => rule.enable === flag || rule.disable === flag))),
		deleteAllDeletesAlarm: select(rules.deleteAllDeletesAlarm),
		websocketCloseReasonByteLimit: select(rules.websocketCloseReasonByteLimit),
		websocketStandardBinaryType: select(rules.websocketStandardBinaryType),
		websocketAutoReplyToClose: select(rules.websocketAutoReplyToClose),
		ctxExports: select(rules.ctxExports),
		queuesJsonMessages: select(rules.queuesJsonMessages),
		r2ListHonorInclude: select(rules.r2ListHonorInclude),
	})
}
