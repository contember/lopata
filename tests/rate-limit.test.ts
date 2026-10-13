import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { SqliteRateLimiter } from '../src/bindings/rate-limit'
import { addStatelessBindings } from '../src/bindings/stateless-env'
import { runMigrations } from '../src/db'

let db: Database
let clock: number

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	clock = 1_000_000_000_000
})

const limiter = (namespaceId: string, limit: number, period: number) => new SqliteRateLimiter(db, namespaceId, limit, period, () => clock)

describe('SqliteRateLimiter', () => {
	test('allows up to the limit in one window, then refuses', async () => {
		const rl = limiter('1001', 3, 60)
		const outcomes = []
		for (let i = 0; i < 5; i++) outcomes.push((await rl.limit({ key: 'site-a' })).success)
		expect(outcomes).toEqual([true, true, true, false, false])
	})

	test('a new window starts the count again', async () => {
		const rl = limiter('1001', 1, 10)
		expect((await rl.limit({ key: 'k' })).success).toBe(true)
		expect((await rl.limit({ key: 'k' })).success).toBe(false)
		clock += 10_000
		expect((await rl.limit({ key: 'k' })).success).toBe(true)
	})

	test('keys and namespaces are counted apart', async () => {
		const a = limiter('1001', 1, 60)
		const b = limiter('1002', 1, 60)
		expect((await a.limit({ key: 'x' })).success).toBe(true)
		expect((await a.limit({ key: 'y' })).success).toBe(true)
		expect((await b.limit({ key: 'x' })).success).toBe(true)
		expect((await a.limit({ key: 'x' })).success).toBe(false)
	})

	test('two instances over one database share the count, as threads do', async () => {
		expect((await limiter('1001', 1, 60).limit({ key: 'x' })).success).toBe(true)
		expect((await limiter('1001', 1, 60).limit({ key: 'x' })).success).toBe(false)
	})

	test('rejects a call without a string key', async () => {
		const rl = limiter('1001', 1, 60)
		// @ts-expect-error: the key is required
		await expect(rl.limit({})).rejects.toThrow('options.key must be a string')
	})
})

describe('ratelimits config', () => {
	test('each entry becomes a binding under its name', async () => {
		const env: Record<string, unknown> = {}
		addStatelessBindings(env, {
			config: { name: 'w', ratelimits: [{ name: 'LIMITER', namespace_id: '1001', simple: { limit: 1, period: 60 } }] },
			db,
			dataDir: '/tmp/lopata-rate-limit-test',
			baseDir: '/tmp',
		})
		const binding = env.LIMITER as SqliteRateLimiter
		expect((await binding.limit({ key: 'x' })).success).toBe(true)
		expect((await binding.limit({ key: 'x' })).success).toBe(false)
	})
})
