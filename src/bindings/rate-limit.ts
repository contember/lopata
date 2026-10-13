/**
 * Local implementation of the Workers Rate Limiting binding (`ratelimits` in the wrangler config).
 *
 * Cloudflare counts each key in a fixed window of `period` seconds, per location and only
 * approximately. A local dev server is one location, so here the count is exact. Counters live
 * in SQLite so every thread that builds this binding (main, the worker, a DO worker) shares them.
 */

import type { Database } from 'bun:sqlite'

export interface RateLimitOptions {
	key: string
}

export interface RateLimitOutcome {
	success: boolean
}

export class SqliteRateLimiter {
	constructor(
		private readonly db: Database,
		private readonly namespaceId: string,
		private readonly limitPerPeriod: number,
		private readonly periodSeconds: number,
		private readonly now: () => number = Date.now,
	) {}

	async limit(options: RateLimitOptions): Promise<RateLimitOutcome> {
		if (typeof options?.key !== 'string') throw new TypeError('RateLimit.limit(): options.key must be a string')
		const window = Math.floor(this.now() / (this.periodSeconds * 1000))
		this.db.run('DELETE FROM rate_limits WHERE namespace_id = ? AND key = ? AND window < ?', [this.namespaceId, options.key, window])
		const row = this.db
			.query<{ count: number }, [string, string, number]>(
				`INSERT INTO rate_limits (namespace_id, key, window, count) VALUES (?, ?, ?, 1)
				ON CONFLICT (namespace_id, key, window) DO UPDATE SET count = count + 1
				RETURNING count`,
			)
			.get(this.namespaceId, options.key, window)
		return { success: (row?.count ?? 1) <= this.limitPerPeriod }
	}
}
