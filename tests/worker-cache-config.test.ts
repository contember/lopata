import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import type { CacheExecutionContext } from '../src/bindings/worker-cache'
import { loadConfig } from '../src/config'
import { createTestEnv } from '../src/testing'

const dir = mkdtempSync('/tmp/opencode/worker-cache-config-')
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
`,
		)
		const config = await loadConfig(path, 'production')
		expect(config.cache).toEqual({ enabled: true, cross_version_cache: true })
		expect(config.exports?.Backend?.cache?.enabled).toBe(false)
	})

	test('rejects invalid new fields at config loading', async () => {
		const invalid = [
			{ cache: { enabled: 'true' } },
			{ cache: { enabled: true, cross_version_cache: 1 } },
			{ cache: { enabled: true, unknown: true } },
			{ exports: { Backend: { type: 'worker', cache: { enabled: 'true' } } } },
			{ exports: { Backend: { type: 'worker', cache: { enabled: true, cross_version_cache: true } } } },
			{ exports: { Backend: { type: 'object', cache: { enabled: true } } } },
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
