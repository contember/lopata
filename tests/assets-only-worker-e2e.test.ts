import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// A worker with `assets` and no `main` is how Cloudflare serves a static site: there is
// no script, so nothing is bundled, spawned or hot-reloaded. lopata used to reject that
// shape outright — GenerationManager resolved `config.main` unconditionally and threw
// ERR_INVALID_ARG_TYPE before the server started.

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/assets-only')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await fetch(url)
			return
		} catch {
			await new Promise((r) => setTimeout(r, 200))
		}
	}
	throw new Error(`Server ${url} did not become ready in ${timeoutMs}ms`)
}

function cleanup(dir: string) {
	try {
		rmSync(resolve(dir, '.lopata'), { recursive: true, force: true })
	} catch {}
}

describe('assets-only worker (no `main`)', () => {
	let proc: Subprocess
	const PORT = 18852
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup(FIXTURE_DIR)
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup(FIXTURE_DIR)
	})

	test('the scripted main worker still runs', async () => {
		const res = await fetch(`${base}/`)
		expect(await res.text()).toBe('api root')
	})

	test('an assets-only auxiliary worker serves its files, routed by host', async () => {
		const res = await fetch(`${base}/hello.txt`, { headers: { host: 'site.localhost' } })
		expect(res.status).toBe(200)
		expect((await res.text()).trim()).toBe('asset-from-disk')
	})

	test('html_handling applies without a script', async () => {
		// `drop-trailing-slash`: /about is served from about/index.html…
		const bare = await fetch(`${base}/about`, { headers: { host: 'site.localhost' } })
		expect(bare.status).toBe(200)
		expect((await bare.text()).trim()).toBe('about-page')

		// …and the slashed form redirects to it rather than serving a second copy.
		const slashed = await fetch(`${base}/about/`, { headers: { host: 'site.localhost' }, redirect: 'manual' })
		expect(slashed.status).toBeGreaterThanOrEqual(300)
		expect(slashed.status).toBeLessThan(400)
	})

	test('not_found_handling applies without a script — SPA deep links resolve', async () => {
		const deep = await fetch(`${base}/pages/some-id`, { headers: { host: 'spa.localhost' } })
		expect(deep.status).toBe(200)
		expect((await deep.text()).trim()).toBe('spa-shell')

		// A real file still wins over the fallback.
		const file = await fetch(`${base}/nested/file.txt`, { headers: { host: 'spa.localhost' } })
		expect((await file.text()).trim()).toBe('spa-asset')
	})

	test('a missing asset 404s when not_found_handling is off', async () => {
		const res = await fetch(`${base}/nope.txt`, { headers: { host: 'site.localhost' } })
		expect(res.status).toBe(404)
	})

	test('a service binding into an assets-only worker resolves to its assets', async () => {
		const res = await fetch(`${base}/via-site`)
		expect(await res.text()).toBe('api->site: asset-from-disk (200)')
	})

	test('an RPC call into an assets-only worker fails with a message that explains why', async () => {
		const res = await fetch(`${base}/rpc-site`)
		const message = await res.text()
		expect(message).toContain('assets-only worker')
		expect(message).toContain('only fetch()')
	})

	test('asset edits are picked up with no reload (files are read per request)', async () => {
		const path = join(FIXTURE_DIR, 'spa/public/nested/file.txt')
		try {
			writeFileSync(path, 'spa-asset-edited\n')
			const res = await fetch(`${base}/nested/file.txt`, { headers: { host: 'spa.localhost' } })
			expect((await res.text()).trim()).toBe('spa-asset-edited')
		} finally {
			writeFileSync(path, 'spa-asset\n')
		}
	})
})

describe('assets-only worker as the only worker', () => {
	let proc: Subprocess
	const PORT = 18853
	const base = `http://localhost:${PORT}`
	const dir = resolve(FIXTURE_DIR, 'site')

	beforeAll(async () => {
		cleanup(dir)
		// Single-worker mode: no lopata.config.ts, just the assets-only wrangler config.
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: dir,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/hello.txt`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup(dir)
	})

	test('serves assets with no worker thread at all', async () => {
		const res = await fetch(`${base}/hello.txt`)
		expect(res.status).toBe(200)
		expect((await res.text()).trim()).toBe('asset-from-disk')
	})

	test('serves the index for /', async () => {
		const res = await fetch(`${base}/`)
		expect((await res.text()).trim()).toBe('site-index')
	})
})

describe('config validation', () => {
	test('a config with neither `main` nor `assets` is rejected with a clear message', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'lopata-empty-'))
		try {
			writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({ name: 'nothing', compatibility_date: '2026-02-12' }))
			const { loadConfig } = await import('../src/config')
			await expect(loadConfig(join(dir, 'wrangler.jsonc'))).rejects.toThrow(/neither "main" nor "assets"/)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
