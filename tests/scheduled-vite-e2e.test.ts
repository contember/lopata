import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The dashboard's manual cron trigger under the Vite plugin.
 *
 * Under the `lopata dev` CLI the dashboard talks to a real `Generation`, which has
 * `callScheduled`. In Vite mode the generation is a small adapter around the SSR-loaded
 * worker module, and it used to expose only `callFetch` — so every Trigger button in the
 * dashboard's Scheduled page died with `gen.callScheduled is not a function`.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/scheduled-vite-worker')
const VITE_BIN = resolve(import.meta.dir, '../node_modules/.bin/vite')
const PORT = 18799
const CRON = '0 0 1 1 *'

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await fetch(url)
			return
		} catch {
			await new Promise(r => setTimeout(r, 250))
		}
	}
	throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`)
}

async function rpc(procedure: string, input: unknown): Promise<{ status: number; body: any }> {
	const res = await fetch(`http://localhost:${PORT}/__api/rpc`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ procedure, input }),
	})
	return { status: res.status, body: await res.json() }
}

async function ticks(): Promise<{ ticks: number; lastCron: string | null; waitUntilRan: boolean }> {
	const res = await fetch(`http://localhost:${PORT}/ticks`)
	return await res.json() as { ticks: number; lastCron: string | null; waitUntilRan: boolean }
}

function cleanup() {
	rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
}

describe('Scheduled trigger E2E — vite', () => {
	let proc: Subprocess

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', '--bun', VITE_BIN, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`http://localhost:${PORT}/ticks`, 60_000)
	}, 90_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('the dashboard lists the configured cron', async () => {
		const { body } = await rpc('scheduled.listTriggers', {})
		expect(body).toMatchObject([{ expression: CRON, workerName: null }])
	})

	test("triggering the cron runs the worker's scheduled() handler", async () => {
		expect((await ticks()).ticks).toBe(0)

		const { status, body } = await rpc('scheduled.trigger', { cron: CRON })
		expect(status).toBe(200)
		expect(body).toEqual({ ok: true })

		expect(await ticks()).toEqual({ ticks: 1, lastCron: CRON, waitUntilRan: true })
	}, 15_000)

	test('triggering again ticks the same module instance', async () => {
		const { body } = await rpc('scheduled.trigger', { cron: CRON })
		expect(body).toEqual({ ok: true })
		expect((await ticks()).ticks).toBe(2)
	}, 15_000)
})
