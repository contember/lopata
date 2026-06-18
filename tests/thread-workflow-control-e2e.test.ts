/**
 * Regression test for CORR-BINDINGS-1: the dashboard workflow control surface
 * (create / sendEvent / skipSleep / terminate + sleeping/waiting introspection)
 * was broken in thread mode because the dashboard handlers ran against main's
 * hollow `SqliteWorkflowBinding` while the live state machine ran in the worker.
 *
 * These ops are now routed through the worker thread; this test drives the real
 * dashboard `/__api/rpc` endpoint and asserts the *live* worker-side state
 * actually changes (an event wakes a blocked instance, skipSleep wakes a
 * sleeper, terminate aborts a running instance).
 */

import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-workflow-control-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await fetch(url)
			return
		} catch {
			await new Promise(r => setTimeout(r, 200))
		}
	}
	throw new Error(`Server ${url} did not become ready in ${timeoutMs}ms`)
}

function cleanup() {
	try {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	} catch {}
}

describe('Workflow dashboard control (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18807
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	/** Call a dashboard RPC procedure via the real `/__api/rpc` endpoint. The
	 *  dispatch layer signals RPC-level failures with a non-200 status — `error`
	 *  inside a 200 body (e.g. a `WorkflowDetail.error` field) is legitimate data. */
	async function rpc<T = unknown>(procedure: string, input: Record<string, unknown>): Promise<T> {
		const res = await fetch(`${base}/__api/rpc`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ procedure, input }),
		})
		const body = await res.json()
		if (res.status !== 200) {
			throw new Error(`${procedure} failed (${res.status}): ${JSON.stringify(body)}`)
		}
		return body as T
	}

	async function getInstance(name: string, id: string): Promise<{ status: string; waitingForEvents: string[]; activeSleep: unknown }> {
		return rpc('workflows.getInstance', { name, id })
	}

	async function waitFor(
		fn: () => Promise<boolean>,
		deadline = Date.now() + 5_000,
	): Promise<void> {
		while (Date.now() < deadline) {
			if (await fn()) return
			await new Promise(r => setTimeout(r, 50))
		}
		throw new Error('condition not met in time')
	}

	test('create routes through the worker and runs the workflow (no "class not wired" throw)', async () => {
		const created = await rpc<{ ok: true; id: string }>('workflows.create', { name: 'SLEEPER', params: '{}' })
		expect(created.ok).toBe(true)
		expect(created.id).toMatch(/^wf-/)
		// The created instance is the sleeper — it should reach the 'long-nap'
		// sleep and be reported as sleeping by the live worker-side introspection.
		await waitFor(async () => {
			const inst = await getInstance('SLEEPER', created.id)
			return inst.status === 'running' && inst.activeSleep !== null
		})
	})

	test('sendEvent wakes a blocked waitForEvent instance', async () => {
		const id = await (await fetch(`${base}/start-waiter`)).text()
		// Wait until the worker-side instance is actually parked in waitForEvent.
		await waitFor(async () => {
			const inst = await getInstance('WAITER', id)
			return inst.status === 'waiting' && inst.waitingForEvents.includes('go')
		})

		await rpc('workflows.sendEvent', { name: 'WAITER', id, type: 'go', payload: JSON.stringify({ ok: 1 }) })

		// The blocked worker re-polls and completes — proving the event reached the
		// live in-worker waiter, not main's empty registry.
		await waitFor(async () => {
			const inst = await getInstance('WAITER', id)
			return inst.status === 'complete'
		})
	})

	test('skipSleep wakes a sleeping instance', async () => {
		const id = await (await fetch(`${base}/start-sleeper`)).text()
		await waitFor(async () => {
			const inst = await getInstance('SLEEPER', id)
			return inst.status === 'running' && inst.activeSleep !== null
		})

		await rpc('workflows.skipSleep', { name: 'SLEEPER', id })

		await waitFor(async () => {
			const inst = await getInstance('SLEEPER', id)
			return inst.status === 'complete'
		})
	})

	test('terminate aborts a running instance and the status sticks', async () => {
		const id = await (await fetch(`${base}/start-waiter`)).text()
		await waitFor(async () => {
			const inst = await getInstance('WAITER', id)
			return inst.status === 'waiting'
		})

		await rpc('workflows.terminate', { name: 'WAITER', id })

		await waitFor(async () => {
			const inst = await getInstance('WAITER', id)
			return inst.status === 'terminated'
		})

		// The worker's AbortController was actually aborted, so the status doesn't
		// get overwritten back to 'complete'/'errored' a moment later.
		await new Promise(r => setTimeout(r, 300))
		const inst = await getInstance('WAITER', id)
		expect(inst.status).toBe('terminated')
	})
})
