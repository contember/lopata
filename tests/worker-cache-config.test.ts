import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CacheExecutionContext } from '../src/bindings/worker-cache'
import { loadConfig, type WranglerConfig } from '../src/config'
import { createTestEnv } from '../src/testing'

const dir = mkdtempSync(join(tmpdir(), 'worker-cache-config-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('Workers Cache configuration boundary', () => {
	test('parses TOML and applies environment cache/export overrides', async () => {
		const path = `${dir}/wrangler.toml`
		await Bun.write(
			path,
			`name = "cache-config"
[cache]
enabled = false
[env.production.cache]
enabled = true
cross_version_cache = true
[env.production.exports.Backend]
type = "worker"
[env.production.exports.Backend.cache]
enabled = false
[env.production.exports.Room]
type = "durable-object"
storage = "sqlite"
[env.production.exports.Job]
type = "workflow"
name = "production-job"
`,
		)
		const config = await loadConfig(path, 'production')
		expect(config.cache).toEqual({ enabled: true, cross_version_cache: true })
		const backend = config.exports?.Backend
		if (backend?.type !== 'worker') throw new Error('Missing Worker declaration')
		expect(backend.cache?.enabled).toBe(false)
		expect(config.exports?.Room).toEqual({ type: 'durable-object', storage: 'sqlite' })
		expect(config.exports?.Job).toEqual({ type: 'workflow', name: 'production-job' })
	})

	test('preserves mixed export declarations with cache absent, disabled, and enabled', async () => {
		const declarations = {
			Room: { type: 'durable-object', storage: 'sqlite', container: 'room-container' },
			LegacyRoom: { type: 'durable-object', state: 'created', storage: 'legacy-kv' },
			DeletedRoom: { type: 'durable-object', state: 'deleted' },
			OldRoom: { type: 'durable-object', state: 'renamed', renamed_to: 'Room' },
			OutgoingRoom: { type: 'durable-object', state: 'transferred', transferred_to: 'target-worker' },
			IncomingRoom: { type: 'durable-object', state: 'expecting-transfer', storage: 'sqlite', transfer_from: 'source-worker' },
			Job: {
				type: 'workflow',
				name: 'scheduled-job',
				limits: { steps: 25000 },
				schedules: ['0 * * * *'],
				default_retention: { success_retention: '3 days', error_retention: 604800000 },
			},
			HourlyJob: { type: 'workflow', name: 'hourly-job', schedules: '0 * * * *' },
		} satisfies NonNullable<WranglerConfig['exports']>
		for (const enabled of [undefined, false, true]) {
			const cache = enabled === undefined ? undefined : { enabled }
			const fields = { name: 'mixed-exports', cache, exports: { ...declarations, Backend: { type: 'worker', cache } } }
			const path = `${dir}/mixed-${enabled}.json`
			await Bun.write(path, JSON.stringify(fields))
			expect(await loadConfig(path)).toEqual(JSON.parse(JSON.stringify(fields)))
		}
	})

	test('rejects malformed Worker cache controls alongside Durable Object and Workflow exports', async () => {
		const invalidCaches = [null, [], true, {}, { enabled: 'true' }, { enabled: true, unknown: true }, {
			enabled: true,
			cross_version_cache: false,
		}]
		for (const [index, cache] of invalidCaches.entries()) {
			const path = `${dir}/mixed-invalid-${index}.json`
			await Bun.write(
				path,
				JSON.stringify({
					name: 'mixed-invalid',
					exports: {
						Room: { type: 'durable-object', storage: 'sqlite' },
						Job: { type: 'workflow', name: 'job' },
						Backend: { type: 'worker', cache },
					},
				}),
			)
			await expect(loadConfig(path)).rejects.toThrow('exports.Backend.cache')
		}
	})

	test('rejects invalid new fields at config loading', async () => {
		const invalid = [
			{ cache: { enabled: 'true' } },
			{ cache: { enabled: true, cross_version_cache: 1 } },
			{ cache: { enabled: true, unknown: true } },
			{ exports: { Backend: { type: 'worker', cache: { enabled: 'true' } } } },
			{ exports: { Backend: { type: 'worker', cache: { enabled: true, cross_version_cache: true } } } },
			{ exports: { Backend: { type: 'object', cache: { enabled: true } } } },
			{ exports: { Backend: { type: 'object' } } },
			{ exports: { Backend: {} } },
			{ exports: { Backend: null } },
			{ exports: [] },
			{ exports: { Room: { type: 'durable-object', storage: 'sqlite', cache: { enabled: true } } } },
			{ exports: { Job: { type: 'workflow', name: 'job', cache: { enabled: false } } } },
		]
		for (const [index, fields] of invalid.entries()) {
			const path = `${dir}/invalid-${index}.json`
			await Bun.write(path, JSON.stringify({ name: 'cache-config', ...fields }))
			await expect(loadConfig(path)).rejects.toBeInstanceOf(TypeError)
		}
	})

	test('test harness uses configured cache and its test clock', async () => {
		const path = `${dir}/clock.json`
		await Bun.write(path, JSON.stringify({ name: 'clock-cache', cache: { enabled: true } }))
		let calls = 0
		const env = await createTestEnv({
			wrangler: path,
			clock: true,
			worker: { fetch: () => new Response(String(++calls), { headers: { 'cache-control': 'max-age=1, must-revalidate' } }) },
		})
		try {
			expect(await (await env.fetch('/')).text()).toBe('1')
			expect(await (await env.fetch('/')).text()).toBe('1')
			await env.advanceTime(2000)
			expect(await (await env.fetch('/')).text()).toBe('2')
		} finally {
			env.dispose()
		}
	})

	test('test harness fetch waits for named child work before disposal', async () => {
		let release: (() => void) | undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		let completed = false
		class Backend {
			get [Symbol.for('lopata.WorkerEntrypoint')]() {
				return true
			}
			constructor(private ctx: CacheExecutionContext) {}
			fetch() {
				this.ctx.waitUntil(gate.then(() => {
					completed = true
				}))
				return new Response('child')
			}
		}
		const env = await createTestEnv({
			worker: {
				Backend,
				default: {
					async fetch(request: Request, _env: unknown, ctx: CacheExecutionContext) {
						const binding = ctx.exports.Backend
						if (typeof binding !== 'function') throw new Error('Missing loopback')
						const fetch: unknown = Reflect.get(binding, 'fetch')
						if (typeof fetch !== 'function') throw new Error('Missing loopback fetch')
						return Reflect.apply(fetch, binding, [request])
					},
				},
			},
		})
		let settled = false
		const response = env.fetch('/').then(result => {
			settled = true
			return result
		})
		try {
			await Bun.sleep(10)
			expect(settled).toBe(false)
			expect(completed).toBe(false)
			release?.()
			expect(await (await response).text()).toBe('child')
			expect(completed).toBe(true)
		} finally {
			release?.()
			await response
			env.dispose()
		}
	})
})
