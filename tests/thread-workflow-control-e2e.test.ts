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
import type { WorkflowStepKey } from '../src/bindings/workflow-store'

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

test('typed dashboard and DO restarts select the second occurrence after fresh-process replay', async () => {
	const directory = resolve(import.meta.dir, 'fixtures/workflow-occurrences-worker')
	const base = 'http://localhost:18853'
	rmSync(resolve(directory, '.lopata'), { recursive: true, force: true })
	const start = () => Bun.spawn([process.execPath, CLI_PATH, 'dev', '--port', '18853'], { cwd: directory, stdout: 'ignore', stderr: 'inherit' })
	let proc = start()
	async function rpc(procedure: string, input: object): Promise<unknown> {
		const response = await fetch(`${base}/__api/rpc`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ procedure, input }),
		})
		if (!response.ok) throw new Error(await response.text())
		return response.json()
	}
	function stepKey(value: unknown): WorkflowStepKey {
		if (
			!value || typeof value !== 'object' || !('type' in value) || !('name' in value) || !('count' in value)
			|| (value.type !== 'do' && value.type !== 'sleep' && value.type !== 'waitForEvent')
			|| typeof value.name !== 'string' || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 1
		) throw new Error('Invalid workflow occurrence key')
		return { type: value.type, name: value.name, count: value.count }
	}
	async function detail(id: string) {
		const value = await rpc('workflows.getInstance', { name: 'OCCURRENCES', id })
		if (
			!value || typeof value !== 'object' || !('status' in value) || typeof value.status !== 'string'
			|| !('steps' in value) || !Array.isArray(value.steps) || !('occurrences' in value) || !Array.isArray(value.occurrences)
		) throw new Error('Invalid workflow detail response')
		const steps = value.steps.map((step: unknown) => {
			if (
				!step || typeof step !== 'object' || !('key' in step) || !('output' in step)
				|| (step.output !== null && typeof step.output !== 'string')
			) throw new Error('Invalid workflow checkpoint response')
			return { key: step.key === null ? null : stepKey(step.key), output: step.output }
		})
		const occurrences = value.occurrences.map((occurrence: unknown) => {
			if (!occurrence || typeof occurrence !== 'object' || !('key' in occurrence)) throw new Error('Invalid workflow occurrence response')
			return { key: stepKey(occurrence.key) }
		})
		return { status: value.status, steps, occurrences }
	}
	async function waitFor(predicate: () => Promise<boolean>) {
		const deadline = Date.now() + 5000
		while (!await predicate()) {
			if (Date.now() > deadline) throw new Error('Typed dashboard control timed out')
			await Bun.sleep(20)
		}
	}
	try {
		await waitForServer(base, 20000)
		const created = await rpc('workflows.create', { name: 'OCCURRENCES', params: '{}' })
		if (!created || typeof created !== 'object' || !('id' in created) || typeof created.id !== 'string') {
			throw new Error('Invalid workflow create response')
		}
		const { id } = created
		await waitFor(async () => (await detail(id)).status === 'waiting')
		const first = (await detail(id)).steps.find(row => row.key?.type === 'do')?.output
		expect(first).toBeString()
		proc.kill()
		await proc.exited
		proc = start()
		await waitForServer(base, 20000)
		await waitFor(async () => (await detail(id)).status === 'waiting')
		expect((await detail(id)).steps.find(row => row.key?.type === 'do')?.output).toBe(first)
		await rpc('workflows.sendEvent', { name: 'OCCURRENCES', id, type: 'go' })
		await waitFor(async () => (await detail(id)).occurrences.filter(row => row.key.type === 'waitForEvent').length === 2)
		await rpc('workflows.sendEvent', { name: 'OCCURRENCES', id, type: 'go' })
		await waitFor(async () => (await detail(id)).status === 'complete')
		const second = (await detail(id)).steps.find(row => row.key?.type === 'do' && row.key.count === 2)?.output
		await rpc('workflows.restart', { name: 'OCCURRENCES', id, from: { name: 'same', count: 2, type: 'do' } })
		await waitFor(async () => (await detail(id)).status === 'waiting')
		await rpc('workflows.sendEvent', { name: 'OCCURRENCES', id, type: 'go' })
		await waitFor(async () => (await detail(id)).status === 'complete')
		const final = await detail(id)
		expect(final.steps.find(row => row.key?.type === 'do' && row.key.count === 1)?.output).toBe(first)
		expect(final.steps.find(row => row.key?.type === 'do' && row.key.count === 2)?.output).not.toBe(second)
		expect(await (await fetch(`${base}/effects?id=${encodeURIComponent(id)}`)).json()).toEqual([1, 2])
		const beforeDoRestart = final.steps.find(row => row.key?.type === 'do' && row.key.count === 2)?.output
		const restarted = await fetch(`${base}/do-restart?id=${encodeURIComponent(id)}`, { method: 'POST' })
		if (!restarted.ok) throw new Error(await restarted.text())
		await waitFor(async () => (await detail(id)).status === 'waiting')
		expect((await detail(id)).steps.find(row => row.key?.type === 'do' && row.key.count === 1)?.output).toBe(first)
		await rpc('workflows.sendEvent', { name: 'OCCURRENCES', id, type: 'go' })
		await waitFor(async () => (await detail(id)).status === 'complete')
		const afterDoRestart = await detail(id)
		expect(afterDoRestart.steps.find(row => row.key?.type === 'do' && row.key.count === 1)?.output).toBe(first)
		expect(afterDoRestart.steps.find(row => row.key?.type === 'do' && row.key.count === 2)?.output).not.toBe(beforeDoRestart)
		expect(await (await fetch(`${base}/effects?id=${encodeURIComponent(id)}`)).json()).toEqual([1, 3])
	} finally {
		proc.kill()
		await proc.exited
		rmSync(resolve(directory, '.lopata'), { recursive: true, force: true })
	}
}, 60000)
