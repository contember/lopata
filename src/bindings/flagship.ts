import type { Database } from 'bun:sqlite'

export type FlagType = 'boolean' | 'string' | 'number' | 'object'

export interface FlagDetails<T> {
	value: T
	variant?: string
	reason: 'STATIC' | 'DEFAULT' | 'ERROR' | 'TARGETING_MATCH'
	errorCode?: string
}

type EvaluationContext = Record<string, unknown> | undefined

interface FlagRow {
	type: string
	value: string
	variant: string | null
}

/**
 * Local implementation of the Cloudflare Flagship feature-flag binding.
 * Flag values are stored in SQLite (`flagship_flags` table). When a flag is
 * not found, the caller's `defaultValue` is returned with reason `DEFAULT`.
 * Local dev does not implement targeting rules — the `context` argument is
 * accepted for API compatibility but ignored during evaluation.
 */
export class FlagshipBinding {
	private db: Database
	private appId: string

	constructor(db: Database, appId: string) {
		this.db = db
		this.appId = appId
	}

	async getBooleanValue(key: string, defaultValue: boolean, context?: EvaluationContext): Promise<boolean> {
		return (await this.getBooleanValueDetails(key, defaultValue, context)).value
	}

	async getStringValue(key: string, defaultValue: string, context?: EvaluationContext): Promise<string> {
		return (await this.getStringValueDetails(key, defaultValue, context)).value
	}

	async getNumberValue(key: string, defaultValue: number, context?: EvaluationContext): Promise<number> {
		return (await this.getNumberValueDetails(key, defaultValue, context)).value
	}

	async getObjectValue<T>(key: string, defaultValue: T, context?: EvaluationContext): Promise<T> {
		return (await this.getObjectValueDetails(key, defaultValue, context)).value
	}

	async getBooleanValueDetails(key: string, defaultValue: boolean, _context?: EvaluationContext): Promise<FlagDetails<boolean>> {
		return this.evaluate('boolean', key, defaultValue, parseBoolean)
	}

	async getStringValueDetails(key: string, defaultValue: string, _context?: EvaluationContext): Promise<FlagDetails<string>> {
		return this.evaluate('string', key, defaultValue, (v) => v)
	}

	async getNumberValueDetails(key: string, defaultValue: number, _context?: EvaluationContext): Promise<FlagDetails<number>> {
		return this.evaluate('number', key, defaultValue, (v) => Number(v))
	}

	async getObjectValueDetails<T>(key: string, defaultValue: T, _context?: EvaluationContext): Promise<FlagDetails<T>> {
		return this.evaluate('object', key, defaultValue, (v) => JSON.parse(v) as T)
	}

	private evaluate<T>(expectedType: FlagType, key: string, defaultValue: T, parse: (raw: string) => T): FlagDetails<T> {
		const row = this.db
			.query<FlagRow, [string, string]>('SELECT type, value, variant FROM flagship_flags WHERE app_id = ? AND flag_key = ?')
			.get(this.appId, key)
		if (!row) {
			return { value: defaultValue, reason: 'DEFAULT' }
		}
		if (row.type !== expectedType) {
			return { value: defaultValue, reason: 'ERROR', errorCode: 'TYPE_MISMATCH' }
		}
		try {
			const parsed = parse(row.value)
			return { value: parsed, variant: row.variant ?? undefined, reason: 'STATIC' }
		} catch {
			return { value: defaultValue, reason: 'ERROR', errorCode: 'PARSE_ERROR' }
		}
	}
}

function parseBoolean(raw: string): boolean {
	const v = raw.toLowerCase()
	if (v === 'true' || v === '1') return true
	if (v === 'false' || v === '0') return false
	throw new Error(`invalid boolean flag value: ${raw}`)
}

/**
 * Programmatic helper to seed / override a flag value in the local store.
 * Used by tests and (later) the dashboard.
 */
export function setFlagValue(
	db: Database,
	appId: string,
	key: string,
	type: FlagType,
	value: unknown,
	variant?: string,
): void {
	const raw = type === 'object' ? JSON.stringify(value) : String(value)
	db.run(
		`INSERT INTO flagship_flags (app_id, flag_key, type, value, variant, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(app_id, flag_key) DO UPDATE SET type = excluded.type, value = excluded.value, variant = excluded.variant, updated_at = excluded.updated_at`,
		[appId, key, type, raw, variant ?? null, Date.now()],
	)
}

export function deleteFlag(db: Database, appId: string, key: string): void {
	db.run('DELETE FROM flagship_flags WHERE app_id = ? AND flag_key = ?', [appId, key])
}
