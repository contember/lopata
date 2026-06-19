import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { SqliteAnalyticsEngine } from '../src/bindings/analytics-engine'
import {
	handleAnalyticsEngineSqlRequest,
	isAnalyticsEngineSqlUrl,
	isLocalAnalyticsEngineToken,
	runAnalyticsEngineSql,
	translateAnalyticsEngineSql,
} from '../src/bindings/analytics-engine-sql'
import { runMigrations } from '../src/db'

// Fixed clock so time-based translation is deterministic.
const NOW_MS = 1_700_000_000_000 // 2023-11-14T22:13:20Z
const NOW_S = Math.floor(NOW_MS / 1000)

let db: Database
let ae: SqliteAnalyticsEngine

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	ae = new SqliteAnalyticsEngine(db, 'metrics')
})

describe('isAnalyticsEngineSqlUrl', () => {
	test('matches the SQL API endpoint', () => {
		expect(isAnalyticsEngineSqlUrl('https://api.cloudflare.com/client/v4/accounts/abc123/analytics_engine/sql')).toBe(true)
		expect(isAnalyticsEngineSqlUrl('https://api.cloudflare.com/client/v4/accounts/abc123/analytics_engine/sql/')).toBe(true)
	})
	test('rejects other URLs', () => {
		expect(isAnalyticsEngineSqlUrl('https://api.cloudflare.com/client/v4/accounts/abc/kv/namespaces')).toBe(false)
		expect(isAnalyticsEngineSqlUrl('https://example.com/analytics_engine/sql')).toBe(false)
		expect(isAnalyticsEngineSqlUrl('not a url')).toBe(false)
	})
})

describe('isLocalAnalyticsEngineToken', () => {
	test('missing or sentinel token is served locally', () => {
		expect(isLocalAnalyticsEngineToken(null)).toBe(true)
		expect(isLocalAnalyticsEngineToken(undefined)).toBe(true)
		expect(isLocalAnalyticsEngineToken('')).toBe(true)
		expect(isLocalAnalyticsEngineToken('Bearer local')).toBe(true)
		expect(isLocalAnalyticsEngineToken('  bearer LOCAL  ')).toBe(true)
	})
	test('a real bearer token passes through to prod', () => {
		expect(isLocalAnalyticsEngineToken('Bearer abc123def456')).toBe(false)
		expect(isLocalAnalyticsEngineToken('Bearer local-but-longer')).toBe(false)
	})
})

describe('translate', () => {
	test('maps FROM <dataset> to a dataset filter on analytics_engine', () => {
		const { sqlite } = translateAnalyticsEngineSql('SELECT blob1 FROM metrics', NOW_S)
		expect(sqlite).toContain('FROM analytics_engine')
		expect(sqlite).toContain("dataset = 'metrics'")
	})

	test('count() becomes COUNT(*)', () => {
		const { sqlite, columns } = translateAnalyticsEngineSql('SELECT count() FROM metrics', NOW_S)
		expect(sqlite).toContain('COUNT(*)')
		expect(columns[0]).toEqual({ name: 'count()', type: 'UInt64' })
	})

	test('aliases via AS and implicit alias', () => {
		const a = translateAnalyticsEngineSql('SELECT sum(double1) AS total FROM metrics', NOW_S)
		expect(a.columns[0]!.name).toBe('total')
		const b = translateAnalyticsEngineSql('SELECT blob1 path FROM metrics', NOW_S)
		expect(b.columns[0]!.name).toBe('path')
	})

	test('now() is baked as an epoch-second literal', () => {
		const { sqlite } = translateAnalyticsEngineSql('SELECT count() FROM metrics WHERE timestamp > now()', NOW_S)
		expect(sqlite).toContain(String(NOW_S))
	})

	test('NOW() - INTERVAL converts to seconds arithmetic and ms timestamp is normalised', () => {
		const { sqlite } = translateAnalyticsEngineSql(
			"SELECT count() FROM metrics WHERE timestamp > NOW() - INTERVAL '1' HOUR",
			NOW_S,
		)
		expect(sqlite).toContain('(timestamp / 1000.0)')
		expect(sqlite).toContain(`(${NOW_S} - 3600)`)
	})

	test('unknown column is rejected', () => {
		expect(() => translateAnalyticsEngineSql('SELECT bogus FROM metrics', NOW_S)).toThrow(/Unknown column/)
	})

	test('unsupported function gives a clear error', () => {
		expect(() => translateAnalyticsEngineSql('SELECT geoMean(double1) FROM metrics', NOW_S)).toThrow(/not supported/)
	})

	test('quantile in a non-SELECT position is rejected clearly', () => {
		expect(() => translateAnalyticsEngineSql('SELECT count() FROM metrics WHERE quantile(0.5)(double1) > 1', NOW_S)).toThrow(
			/only supported in the SELECT/,
		)
	})

	test('quantile requires a single numeric level in [0,1]', () => {
		expect(() => translateAnalyticsEngineSql('SELECT quantile(2)(double1) FROM metrics', NOW_S)).toThrow(/between 0 and 1/)
	})

	test('block comments are ignored', () => {
		const { sqlite } = translateAnalyticsEngineSql('SELECT count() /* inline */ FROM metrics', NOW_S)
		expect(sqlite).toContain('COUNT(*)')
	})

	test('/ is real division (ClickHouse semantics), not SQLite integer division', () => {
		const { sqlite } = translateAnalyticsEngineSql('SELECT toUInt32(timestamp) / 3600 AS h FROM metrics', NOW_S)
		expect(sqlite).toContain('* 1.0 /')
	})

	test('unsupported keywords get a clear, named error', () => {
		expect(() => translateAnalyticsEngineSql('SELECT count() AS c FROM metrics GROUP BY blob1 HAVING c > 5', NOW_S)).toThrow(
			/HAVING.*not supported/,
		)
		expect(() => translateAnalyticsEngineSql('SELECT count() FROM metrics LIMIT 10 OFFSET 5', NOW_S)).toThrow(/OFFSET.*not supported/)
	})
})

describe('extended WHERE coverage (IN / LIKE / BETWEEN / IS NULL)', () => {
	function seed() {
		ae.writeDataPoint({ blobs: ['GET', '/a'], doubles: [10] })
		ae.writeDataPoint({ blobs: ['POST', '/b'], doubles: [50] })
		ae.writeDataPoint({ blobs: ['PUT', '/c'], doubles: [200] })
		ae.writeDataPoint({ blobs: [null as unknown as string], doubles: [1] }) // blob1 NULL
	}

	test('IN and NOT IN', () => {
		seed()
		expect(runAnalyticsEngineSql(db, "SELECT count() AS n FROM metrics WHERE blob1 IN ('GET','PUT')", NOW_MS).data).toEqual([{ n: 2 }])
		expect(runAnalyticsEngineSql(db, "SELECT count() AS n FROM metrics WHERE blob1 NOT IN ('GET','PUT')", NOW_MS).data).toEqual([
			{ n: 1 }, // POST (NULL blob1 is excluded by NOT IN, as in SQL)
		])
	})

	test('LIKE and NOT LIKE', () => {
		seed()
		expect(runAnalyticsEngineSql(db, "SELECT count() AS n FROM metrics WHERE blob2 LIKE '/a%'", NOW_MS).data).toEqual([{ n: 1 }])
		expect(runAnalyticsEngineSql(db, "SELECT count() AS n FROM metrics WHERE blob1 NOT LIKE 'P%'", NOW_MS).data).toEqual([{ n: 1 }]) // GET
	})

	test('BETWEEN', () => {
		seed()
		expect(runAnalyticsEngineSql(db, 'SELECT count() AS n FROM metrics WHERE double1 BETWEEN 10 AND 100', NOW_MS).data).toEqual([
			{ n: 2 },
		])
	})

	test('IS NULL / IS NOT NULL', () => {
		seed()
		expect(runAnalyticsEngineSql(db, 'SELECT count() AS n FROM metrics WHERE blob1 IS NULL', NOW_MS).data).toEqual([{ n: 1 }])
		expect(runAnalyticsEngineSql(db, 'SELECT count() AS n FROM metrics WHERE blob1 IS NOT NULL', NOW_MS).data).toEqual([{ n: 3 }])
	})
})

describe('SELECT *', () => {
	test('returns all columns with meta derived from the rows', () => {
		ae.writeDataPoint({ blobs: ['GET'], doubles: [10] })
		const r = runAnalyticsEngineSql(db, 'SELECT * FROM metrics', NOW_MS)
		expect(r.rows).toBe(1)
		expect(r.data[0]!.blob1).toBe('GET')
		expect(r.data[0]!.double1).toBe(10)
		expect(r.data[0]!.dataset).toBe('metrics')
		const names = r.meta.map(m => m.name)
		expect(names).toContain('blob1')
		expect(names).toContain('double1')
	})

	test('SELECT * cannot be combined with quantiles', () => {
		expect(() => translateAnalyticsEngineSql('SELECT *, quantile(0.5)(double1) FROM metrics', NOW_S)).toThrow(/cannot be combined/)
	})
})

describe('real division end-to-end', () => {
	test('integer operands still divide as floats', () => {
		ae.writeDataPoint({ doubles: [5] })
		expect(runAnalyticsEngineSql(db, 'SELECT toUInt32(double1) / 2 AS h FROM metrics', NOW_MS).data).toEqual([{ h: 2.5 }])
	})
})

describe('quantiles (group_concat + JS)', () => {
	function seedLatencies() {
		for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
			ae.writeDataPoint({ blobs: ['GET'], doubles: [ms] })
		}
	}

	test('median over all rows', () => {
		seedLatencies()
		const r = runAnalyticsEngineSql(db, 'SELECT quantile(0.5)(double1) AS p50 FROM metrics', NOW_MS)
		// linear interpolation: pos = 0.5 * 9 = 4.5 → between sorted[4]=50 and sorted[5]=60 → 55
		expect(r.data).toEqual([{ p50: 55 }])
		expect(r.meta).toEqual([{ name: 'p50', type: 'Float64' }])
	})

	test('quantile interpolates, quantileExact returns a real element', () => {
		for (const ms of [10, 20, 30, 40]) ae.writeDataPoint({ doubles: [ms] })
		// quantile(0.5): pos = 0.5 * 3 = 1.5 → 20 + 0.5*(30-20) = 25
		expect(runAnalyticsEngineSql(db, 'SELECT quantile(0.5)(double1) AS q FROM metrics', NOW_MS).data).toEqual([{ q: 25 }])
		// quantileExact(0.5): nearest-rank round(0.5*3)=2 → sorted[2] = 30
		expect(runAnalyticsEngineSql(db, 'SELECT quantileExact(0.5)(double1) AS q FROM metrics', NOW_MS).data).toEqual([{ q: 30 }])
	})

	test('p95 / quantileExactWeighted ignores the (always-1) weight', () => {
		seedLatencies()
		const r = runAnalyticsEngineSql(
			db,
			'SELECT quantileExactWeighted(0.95)(double1, _sample_interval) AS p95 FROM metrics',
			NOW_MS,
		)
		// round(0.95 * 9) = 9 → sorted[9] = 100
		expect(r.data).toEqual([{ p95: 100 }])
	})

	test('quantiles per group, mixed with count, ORDER BY and LIMIT', () => {
		ae.writeDataPoint({ blobs: ['GET'], doubles: [10] })
		ae.writeDataPoint({ blobs: ['GET'], doubles: [30] })
		ae.writeDataPoint({ blobs: ['POST'], doubles: [100] })
		ae.writeDataPoint({ blobs: ['POST'], doubles: [200] })
		ae.writeDataPoint({ blobs: ['POST'], doubles: [300] })
		const r = runAnalyticsEngineSql(
			db,
			'SELECT blob1 AS method, count() AS n, quantile(0.5)(double1) AS p50 FROM metrics GROUP BY blob1 ORDER BY p50 DESC LIMIT 1',
			NOW_MS,
		)
		// POST p50 (interpolated) = sorted[1.0] = 200; GET p50 = 20 — ORDER BY p50 DESC LIMIT 1 keeps POST
		expect(r.data).toEqual([{ method: 'POST', n: 3, p50: 200 }])
	})

	test('empty group yields null quantile', () => {
		const r = runAnalyticsEngineSql(db, 'SELECT quantile(0.5)(double1) AS p50 FROM metrics', NOW_MS)
		expect(r.data).toEqual([{ p50: null }])
	})

	test('ORDER BY on a non-selected column is rejected with quantiles', () => {
		expect(() => translateAnalyticsEngineSql('SELECT quantile(0.5)(double1) AS p50 FROM metrics ORDER BY double2', NOW_S)).toThrow(
			/must reference a selected column/,
		)
	})
})

describe('run (end-to-end against SQLite)', () => {
	function seed() {
		// 3 GET to /a, 1 POST to /b, with latencies in double1
		ae.writeDataPoint({ blobs: ['GET', '/a'], doubles: [10] })
		ae.writeDataPoint({ blobs: ['GET', '/a'], doubles: [20] })
		ae.writeDataPoint({ blobs: ['GET', '/a'], doubles: [30] })
		ae.writeDataPoint({ blobs: ['POST', '/b'], doubles: [100] })
	}

	test('count() over a dataset', () => {
		seed()
		const r = runAnalyticsEngineSql(db, 'SELECT count() AS n FROM metrics', NOW_MS)
		expect(r.data).toEqual([{ n: 4 }])
		expect(r.rows).toBe(1)
		expect(r.meta).toEqual([{ name: 'n', type: 'UInt64' }])
	})

	test('GROUP BY with sum and ORDER BY / LIMIT', () => {
		seed()
		const r = runAnalyticsEngineSql(
			db,
			'SELECT blob1 AS method, count() AS hits, sum(double1) AS total FROM metrics GROUP BY blob1 ORDER BY hits DESC',
			NOW_MS,
		)
		expect(r.data).toEqual([
			{ method: 'GET', hits: 3, total: 60 },
			{ method: 'POST', hits: 1, total: 100 },
		])
	})

	test('sum(_sample_interval) equals count() locally', () => {
		seed()
		const r = runAnalyticsEngineSql(db, 'SELECT sum(_sample_interval) AS n FROM metrics', NOW_MS)
		expect(r.data).toEqual([{ n: 4 }])
	})

	test('WHERE timestamp filter with NOW()/INTERVAL selects recent rows', () => {
		// row well in the past
		db.run(
			"INSERT INTO analytics_engine (id, dataset, timestamp, _sample_interval, blob1) VALUES ('old', 'metrics', ?, 1, 'GET')",
			[NOW_MS - 7200_000], // 2h ago
		)
		// row 1 minute ago
		db.run(
			"INSERT INTO analytics_engine (id, dataset, timestamp, _sample_interval, blob1) VALUES ('new', 'metrics', ?, 1, 'GET')",
			[NOW_MS - 60_000],
		)
		const r = runAnalyticsEngineSql(
			db,
			"SELECT count() AS n FROM metrics WHERE timestamp > NOW() - INTERVAL '1' HOUR",
			NOW_MS,
		)
		expect(r.data).toEqual([{ n: 1 }])
	})

	test('dataset isolation — other datasets are not counted', () => {
		seed()
		new SqliteAnalyticsEngine(db, 'other').writeDataPoint({ blobs: ['X'], doubles: [1] })
		const r = runAnalyticsEngineSql(db, 'SELECT count() AS n FROM metrics', NOW_MS)
		expect(r.data).toEqual([{ n: 4 }])
	})

	test('time bucketing with toStartOfInterval', () => {
		const base = 1_700_000_000_000
		db.run("INSERT INTO analytics_engine (id, dataset, timestamp, _sample_interval) VALUES ('1', 'metrics', ?, 1)", [base])
		db.run("INSERT INTO analytics_engine (id, dataset, timestamp, _sample_interval) VALUES ('2', 'metrics', ?, 1)", [base + 30_000])
		db.run("INSERT INTO analytics_engine (id, dataset, timestamp, _sample_interval) VALUES ('3', 'metrics', ?, 1)", [base + 7200_000])
		const r = runAnalyticsEngineSql(
			db,
			"SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS bucket, count() AS n FROM metrics GROUP BY bucket ORDER BY bucket ASC",
			NOW_MS,
		)
		expect(r.data.length).toBe(2)
		expect(r.data[0]).toMatchObject({ n: 2 })
		expect(r.data[1]).toMatchObject({ n: 1 })
	})
})

describe('robustness fixes', () => {
	function seed() {
		ae.writeDataPoint({ blobs: ['GET', '/a'], doubles: [10] })
		ae.writeDataPoint({ blobs: ['POST', '/b'], doubles: [50] })
		ae.writeDataPoint({ blobs: ['PUT', '/c'], doubles: [200] })
		ae.writeDataPoint({ blobs: [null as unknown as string], doubles: [1] }) // blob1 NULL
	}

	test('NOT binds looser than comparison: `NOT a = b` is `NOT (a = b)`', () => {
		const { sqlite } = translateAnalyticsEngineSql("SELECT count() FROM metrics WHERE NOT blob1 = 'GET'", NOW_S)
		expect(sqlite).toContain("(NOT (blob1 = 'GET'))")
		seed()
		// POST and PUT match; GET is excluded, NULL blob1 is excluded (NOT NULL → NULL)
		expect(runAnalyticsEngineSql(db, "SELECT count() AS n FROM metrics WHERE NOT blob1 = 'GET'", NOW_MS).data).toEqual([{ n: 2 }])
	})

	test('NOT mixed with AND keeps correct grouping', () => {
		seed()
		// (NOT (blob1 = 'GET')) AND (double1 > 5) → POST(50), PUT(200)
		expect(
			runAnalyticsEngineSql(db, "SELECT count() AS n FROM metrics WHERE NOT blob1 = 'GET' AND double1 > 5", NOW_MS).data,
		).toEqual([{ n: 2 }])
	})

	test('LIKE is case-sensitive (ClickHouse semantics)', () => {
		seed()
		expect(runAnalyticsEngineSql(db, "SELECT count() AS n FROM metrics WHERE blob1 LIKE 'G%'", NOW_MS).data).toEqual([{ n: 1 }])
		expect(runAnalyticsEngineSql(db, "SELECT count() AS n FROM metrics WHERE blob1 LIKE 'g%'", NOW_MS).data).toEqual([{ n: 0 }])
	})

	test('sum over an empty result is 0, not null', () => {
		expect(runAnalyticsEngineSql(db, 'SELECT sum(double1) AS s FROM metrics', NOW_MS).data).toEqual([{ s: 0 }])
	})

	test('wrong function arity fails loudly', () => {
		expect(() => translateAnalyticsEngineSql('SELECT if(double1 > 5, 1) FROM metrics', NOW_S)).toThrow(/expects exactly 3 arguments/)
		expect(() => translateAnalyticsEngineSql('SELECT sum() FROM metrics', NOW_S)).toThrow(/expects exactly 1 argument/)
		expect(() => translateAnalyticsEngineSql('SELECT count(blob1, blob2) FROM metrics', NOW_S)).toThrow(/expects/)
	})

	test('trailing semicolon is allowed', () => {
		seed()
		expect(runAnalyticsEngineSql(db, 'SELECT count() AS n FROM metrics;', NOW_MS).data).toEqual([{ n: 4 }])
	})

	test('malformed numeric literal fails loudly instead of becoming NaN', () => {
		expect(() => translateAnalyticsEngineSql('SELECT count() FROM metrics WHERE double1 > 1.2.3', NOW_S)).toThrow()
		const { sqlite } = translateAnalyticsEngineSql('SELECT count() FROM metrics WHERE double1 > 1.5', NOW_S)
		expect(sqlite).not.toContain('NaN')
	})

	test('nested aggregates and aggregates in WHERE / GROUP BY are rejected clearly', () => {
		expect(() => translateAnalyticsEngineSql('SELECT sum(count()) FROM metrics', NOW_S)).toThrow(/cannot be nested/)
		expect(() => translateAnalyticsEngineSql('SELECT count() FROM metrics WHERE sum(double1) > 5', NOW_S)).toThrow(/not allowed in the WHERE/)
		expect(() => translateAnalyticsEngineSql('SELECT count() FROM metrics GROUP BY sum(double1)', NOW_S)).toThrow(/not allowed in GROUP BY/)
	})
})

describe('handleAnalyticsEngineSqlRequest', () => {
	function req(sql: string) {
		return new Request('https://api.cloudflare.com/client/v4/accounts/abc/analytics_engine/sql', {
			method: 'POST',
			body: sql,
		})
	}

	test('returns Cloudflare-shaped JSON', async () => {
		ae.writeDataPoint({ blobs: ['GET'], doubles: [5] })
		const res = await handleAnalyticsEngineSqlRequest(db, req('SELECT count() AS n FROM metrics'))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { meta: unknown[]; data: unknown[]; rows: number }
		expect(body.data).toEqual([{ n: 1 }])
		expect(body.rows).toBe(1)
		expect(body.meta).toEqual([{ name: 'n', type: 'UInt64' }])
	})

	test('FORMAT JSONEachRow returns newline-delimited rows', async () => {
		ae.writeDataPoint({ blobs: ['GET'] })
		ae.writeDataPoint({ blobs: ['POST'] })
		const res = await handleAnalyticsEngineSqlRequest(db, req('SELECT blob1 AS m FROM metrics ORDER BY blob1 ASC FORMAT JSONEachRow'))
		const text = await res.text()
		expect(text).toBe('{"m":"GET"}\n{"m":"POST"}')
	})

	test('bad query returns 400 with the error message', async () => {
		const res = await handleAnalyticsEngineSqlRequest(db, req('SELECT bogus FROM metrics'))
		expect(res.status).toBe(400)
		expect(await res.text()).toMatch(/Unknown column/)
	})
})

// Snapshot the exact SQLite a representative set of *classic dashboard* queries
// translates to — the kind people actually write against Analytics Engine
// (top-N, time series, percentiles, error rates, unique counts, …). These pin
// down the emitter's output (quoting, parenthesisation, real division, time
// canonicalisation, quantile lowering) so any change to the translation is
// surfaced as a readable diff rather than slipping through a behavioural test.
describe('classic analytical queries (translation snapshots)', () => {
	interface Case {
		name: string
		sql: string
		sqlite: string
		columns: { name: string; type: string }[]
		caseSensitiveLike?: boolean
		postProcess?: {
			quantiles: { tempCol: string; outputName: string; level: number; interpolate: boolean }[]
			orderBy: { name: string; desc: boolean }[]
			limit?: number
		}
	}

	const cases: Case[] = [
		{
			name: 'total events',
			sql: `SELECT count() AS count FROM metrics`,
			sqlite: `SELECT COUNT(*) AS "count" FROM analytics_engine WHERE dataset = 'metrics'`,
			columns: [{ name: 'count', type: 'UInt64' }],
		},
		{
			name: 'sampled request count (sum of _sample_interval)',
			sql: `SELECT sum(_sample_interval) AS requests FROM metrics`,
			sqlite: `SELECT COALESCE(SUM(_sample_interval), 0) AS "requests" FROM analytics_engine WHERE dataset = 'metrics'`,
			columns: [{ name: 'requests', type: 'Float64' }],
		},
		{
			name: 'top-N pages by hits',
			sql: `SELECT blob1 AS path, count() AS hits FROM metrics GROUP BY path ORDER BY hits DESC LIMIT 10`,
			sqlite: `SELECT blob1 AS "path", COUNT(*) AS "hits" FROM analytics_engine WHERE dataset = 'metrics' GROUP BY "path" ORDER BY "hits" DESC LIMIT 10`,
			columns: [{ name: 'path', type: 'String' }, { name: 'hits', type: 'UInt64' }],
		},
		{
			name: 'requests by status code',
			sql: `SELECT blob2 AS status, count() AS n FROM metrics GROUP BY status ORDER BY n DESC`,
			sqlite: `SELECT blob2 AS "status", COUNT(*) AS "n" FROM analytics_engine WHERE dataset = 'metrics' GROUP BY "status" ORDER BY "n" DESC`,
			columns: [{ name: 'status', type: 'String' }, { name: 'n', type: 'UInt64' }],
		},
		{
			name: 'requests by country (top 20)',
			sql: `SELECT blob4 AS country, count() AS n FROM metrics GROUP BY country ORDER BY n DESC LIMIT 20`,
			sqlite: `SELECT blob4 AS "country", COUNT(*) AS "n" FROM analytics_engine WHERE dataset = 'metrics' GROUP BY "country" ORDER BY "n" DESC LIMIT 20`,
			columns: [{ name: 'country', type: 'String' }, { name: 'n', type: 'UInt64' }],
		},
		{
			name: 'requests in the last hour (now() - INTERVAL)',
			sql: `SELECT count() AS n FROM metrics WHERE timestamp > now() - INTERVAL '1' HOUR`,
			sqlite: `SELECT COUNT(*) AS "n" FROM analytics_engine WHERE dataset = 'metrics' AND ((timestamp / 1000.0) > (${NOW_S} - 3600))`,
			columns: [{ name: 'n', type: 'UInt64' }],
		},
		{
			name: 'requests in the last 24 hours',
			sql: `SELECT count() AS n FROM metrics WHERE timestamp > now() - INTERVAL '1' DAY`,
			sqlite: `SELECT COUNT(*) AS "n" FROM analytics_engine WHERE dataset = 'metrics' AND ((timestamp / 1000.0) > (${NOW_S} - 86400))`,
			columns: [{ name: 'n', type: 'UInt64' }],
		},
		{
			name: 'time series bucketed by hour',
			sql: `SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS bucket, count() AS n FROM metrics GROUP BY bucket ORDER BY bucket ASC`,
			sqlite:
				`SELECT ((CAST((timestamp / 1000.0) AS INTEGER) / 3600) * 3600) AS "bucket", COUNT(*) AS "n" FROM analytics_engine WHERE dataset = 'metrics' GROUP BY "bucket" ORDER BY "bucket" ASC`,
			columns: [{ name: 'bucket', type: 'DateTime' }, { name: 'n', type: 'UInt64' }],
		},
		{
			name: 'time series bucketed by minute',
			sql: `SELECT toStartOfMinute(timestamp) AS bucket, count() AS n FROM metrics GROUP BY bucket ORDER BY bucket ASC`,
			sqlite:
				`SELECT ((CAST((timestamp / 1000.0) AS INTEGER) / 60) * 60) AS "bucket", COUNT(*) AS "n" FROM analytics_engine WHERE dataset = 'metrics' GROUP BY "bucket" ORDER BY "bucket" ASC`,
			columns: [{ name: 'bucket', type: 'DateTime' }, { name: 'n', type: 'UInt64' }],
		},
		{
			name: 'daily totals (toStartOfDay)',
			sql: `SELECT toStartOfDay(timestamp) AS day, count() AS n FROM metrics GROUP BY day ORDER BY day ASC`,
			sqlite:
				`SELECT ((CAST((timestamp / 1000.0) AS INTEGER) / 86400) * 86400) AS "day", COUNT(*) AS "n" FROM analytics_engine WHERE dataset = 'metrics' GROUP BY "day" ORDER BY "day" ASC`,
			columns: [{ name: 'day', type: 'DateTime' }, { name: 'n', type: 'UInt64' }],
		},
		{
			name: 'server-error count (LIKE is case-sensitive)',
			sql: `SELECT count() AS errors FROM metrics WHERE blob2 LIKE '5%'`,
			sqlite: `SELECT COUNT(*) AS "errors" FROM analytics_engine WHERE dataset = 'metrics' AND (blob2 LIKE '5%')`,
			columns: [{ name: 'errors', type: 'UInt64' }],
			caseSensitiveLike: true,
		},
		{
			name: 'hourly server errors over the last day',
			sql:
				`SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS bucket, count() AS errors FROM metrics WHERE blob2 LIKE '5%' AND timestamp > now() - INTERVAL '1' DAY GROUP BY bucket ORDER BY bucket ASC`,
			sqlite:
				`SELECT ((CAST((timestamp / 1000.0) AS INTEGER) / 3600) * 3600) AS "bucket", COUNT(*) AS "errors" FROM analytics_engine WHERE dataset = 'metrics' AND ((blob2 LIKE '5%') AND ((timestamp / 1000.0) > (${NOW_S} - 86400))) GROUP BY "bucket" ORDER BY "bucket" ASC`,
			columns: [{ name: 'bucket', type: 'DateTime' }, { name: 'errors', type: 'UInt64' }],
			caseSensitiveLike: true,
		},
		{
			name: 'unique visitors (COUNT DISTINCT)',
			sql: `SELECT count(DISTINCT blob3) AS visitors FROM metrics`,
			sqlite: `SELECT COUNT(DISTINCT blob3) AS "visitors" FROM analytics_engine WHERE dataset = 'metrics'`,
			columns: [{ name: 'visitors', type: 'UInt64' }],
		},
		{
			name: 'average latency',
			sql: `SELECT avg(double1) AS avg_ms FROM metrics`,
			sqlite: `SELECT AVG(double1) AS "avg_ms" FROM analytics_engine WHERE dataset = 'metrics'`,
			columns: [{ name: 'avg_ms', type: 'Float64' }],
		},
		{
			name: 'min/max latency',
			sql: `SELECT min(double1) AS min_ms, max(double1) AS max_ms FROM metrics`,
			sqlite: `SELECT MIN(double1) AS "min_ms", MAX(double1) AS "max_ms" FROM analytics_engine WHERE dataset = 'metrics'`,
			columns: [{ name: 'min_ms', type: 'Float64' }, { name: 'max_ms', type: 'Float64' }],
		},
		{
			name: 'total bytes (sum coalesces to 0)',
			sql: `SELECT sum(double2) AS bytes FROM metrics`,
			sqlite: `SELECT COALESCE(SUM(double2), 0) AS "bytes" FROM analytics_engine WHERE dataset = 'metrics'`,
			columns: [{ name: 'bytes', type: 'Float64' }],
		},
		{
			name: 'average bytes per status',
			sql: `SELECT blob2 AS status, avg(double2) AS avg_bytes FROM metrics GROUP BY status`,
			sqlite: `SELECT blob2 AS "status", AVG(double2) AS "avg_bytes" FROM analytics_engine WHERE dataset = 'metrics' GROUP BY "status"`,
			columns: [{ name: 'status', type: 'String' }, { name: 'avg_bytes', type: 'Float64' }],
		},
		{
			name: 'bytes-per-request ratio (ClickHouse real division)',
			sql: `SELECT sum(double2) / count() AS avg_bytes FROM metrics`,
			sqlite: `SELECT (COALESCE(SUM(double2), 0) * 1.0 / COUNT(*)) AS "avg_bytes" FROM analytics_engine WHERE dataset = 'metrics'`,
			columns: [{ name: 'avg_bytes', type: 'Float64' }],
		},
		{
			name: 'conditional aggregation (error count via if)',
			sql: `SELECT sum(if(blob2 LIKE '5%', 1, 0)) AS errors, count() AS total FROM metrics`,
			sqlite:
				`SELECT COALESCE(SUM((CASE WHEN (blob2 LIKE '5%') THEN 1 ELSE 0 END)), 0) AS "errors", COUNT(*) AS "total" FROM analytics_engine WHERE dataset = 'metrics'`,
			columns: [{ name: 'errors', type: 'Float64' }, { name: 'total', type: 'UInt64' }],
			caseSensitiveLike: true,
		},
		{
			name: 'filter by method (IN list)',
			sql: `SELECT count() AS n FROM metrics WHERE blob1 IN ('GET', 'POST')`,
			sqlite: `SELECT COUNT(*) AS "n" FROM analytics_engine WHERE dataset = 'metrics' AND (blob1 IN ('GET', 'POST'))`,
			columns: [{ name: 'n', type: 'UInt64' }],
		},
		{
			name: 'filter by latency range (BETWEEN)',
			sql: `SELECT count() AS n FROM metrics WHERE double1 BETWEEN 100 AND 500`,
			sqlite: `SELECT COUNT(*) AS "n" FROM analytics_engine WHERE dataset = 'metrics' AND (double1 BETWEEN 100 AND 500)`,
			columns: [{ name: 'n', type: 'UInt64' }],
		},
		{
			name: 'p95 latency (quantile → group_concat + JS post-process)',
			sql: `SELECT quantile(0.95)(double1) AS p95 FROM metrics`,
			sqlite: `SELECT group_concat(double1) AS "__q0" FROM analytics_engine WHERE dataset = 'metrics'`,
			columns: [{ name: 'p95', type: 'Float64' }],
			postProcess: {
				quantiles: [{ tempCol: '__q0', outputName: 'p95', level: 0.95, interpolate: true }],
				orderBy: [],
				limit: undefined,
			},
		},
		{
			name: 'p50 / p95 / p99 latency in one query',
			sql: `SELECT quantile(0.5)(double1) AS p50, quantile(0.95)(double1) AS p95, quantile(0.99)(double1) AS p99 FROM metrics`,
			sqlite:
				`SELECT group_concat(double1) AS "__q0", group_concat(double1) AS "__q1", group_concat(double1) AS "__q2" FROM analytics_engine WHERE dataset = 'metrics'`,
			columns: [{ name: 'p50', type: 'Float64' }, { name: 'p95', type: 'Float64' }, { name: 'p99', type: 'Float64' }],
			postProcess: {
				quantiles: [
					{ tempCol: '__q0', outputName: 'p50', level: 0.5, interpolate: true },
					{ tempCol: '__q1', outputName: 'p95', level: 0.95, interpolate: true },
					{ tempCol: '__q2', outputName: 'p99', level: 0.99, interpolate: true },
				],
				orderBy: [],
				limit: undefined,
			},
		},
		{
			name: 'p95 latency per endpoint (quantile + GROUP BY + ORDER BY + LIMIT)',
			sql: `SELECT blob1 AS path, quantile(0.95)(double1) AS p95 FROM metrics GROUP BY path ORDER BY p95 DESC LIMIT 10`,
			sqlite: `SELECT blob1 AS "path", group_concat(double1) AS "__q1" FROM analytics_engine WHERE dataset = 'metrics' GROUP BY "path"`,
			columns: [{ name: 'path', type: 'String' }, { name: 'p95', type: 'Float64' }],
			postProcess: {
				quantiles: [{ tempCol: '__q1', outputName: 'p95', level: 0.95, interpolate: true }],
				orderBy: [{ name: 'p95', desc: true }],
				limit: 10,
			},
		},
	]

	test('cover at least 20 distinct classic queries', () => {
		expect(cases.length).toBeGreaterThanOrEqual(20)
	})

	for (const c of cases) {
		test(c.name, () => {
			const t = translateAnalyticsEngineSql(c.sql, NOW_S)
			expect(t.sqlite).toBe(c.sqlite)
			expect(t.columns).toEqual(c.columns)
			expect(t.caseSensitiveLike ?? false).toBe(c.caseSensitiveLike ?? false)
			if (c.postProcess) expect(t.postProcess).toEqual(c.postProcess)
			else expect(t.postProcess).toBeUndefined()
		})
	}
})

// The real SQL API returns `DateTime` columns as `YYYY-MM-DD HH:MM:SS` (UTC)
// strings, not epoch numbers. Lopata computes time in seconds internally but must
// hand the *same shape* back to worker code so `new Date(row.bucket)` behaves
// identically locally and in prod.
describe('DateTime columns render as ClickHouse strings (prod fidelity)', () => {
	test('raw timestamp comes back as a UTC datetime string, not an epoch number', () => {
		db.run("INSERT INTO analytics_engine (id, dataset, timestamp, _sample_interval) VALUES ('a', 'metrics', ?, 1)", [NOW_MS])
		const r = runAnalyticsEngineSql(db, 'SELECT timestamp AS ts FROM metrics', NOW_MS)
		expect(r.data).toEqual([{ ts: '2023-11-14 22:13:20' }])
		expect(r.meta).toEqual([{ name: 'ts', type: 'DateTime' }])
	})

	test('toStartOfInterval bucket is a datetime string floored to the hour', () => {
		db.run("INSERT INTO analytics_engine (id, dataset, timestamp, _sample_interval) VALUES ('a', 'metrics', ?, 1)", [NOW_MS])
		const r = runAnalyticsEngineSql(
			db,
			"SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS bucket, count() AS n FROM metrics GROUP BY bucket",
			NOW_MS,
		)
		expect(r.data).toEqual([{ bucket: '2023-11-14 22:00:00', n: 1 }])
	})

	test('now() in the SELECT list is a datetime string', () => {
		ae.writeDataPoint({ blobs: ['GET'] })
		const r = runAnalyticsEngineSql(db, 'SELECT now() AS t FROM metrics', NOW_MS)
		expect(r.data).toEqual([{ t: '2023-11-14 22:13:20' }])
	})

	test('SELECT * also renders the timestamp column as a datetime string', () => {
		db.run(
			"INSERT INTO analytics_engine (id, dataset, timestamp, _sample_interval, blob1) VALUES ('a', 'metrics', ?, 1, 'GET')",
			[NOW_MS],
		)
		const r = runAnalyticsEngineSql(db, 'SELECT * FROM metrics', NOW_MS)
		expect(r.data[0]!.timestamp).toBe('2023-11-14 22:13:20')
		expect(r.data[0]!.blob1).toBe('GET')
	})

	test('a NULL DateTime (max(timestamp) over an empty dataset) stays null', () => {
		const r = runAnalyticsEngineSql(db, 'SELECT max(timestamp) AS t FROM metrics', NOW_MS)
		expect(r.data).toEqual([{ t: null }])
		expect(r.meta).toEqual([{ name: 't', type: 'DateTime' }])
	})

	test('the HTTP response carries datetime strings (matches the prod SQL API shape)', async () => {
		ae.writeDataPoint({ blobs: ['GET'] })
		const res = await handleAnalyticsEngineSqlRequest(
			db,
			new Request('https://api.cloudflare.com/client/v4/accounts/abc/analytics_engine/sql', {
				method: 'POST',
				body: 'SELECT timestamp AS ts FROM metrics',
			}),
		)
		const body = (await res.json()) as { data: { ts: string }[] }
		expect(body.data[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
	})
})
