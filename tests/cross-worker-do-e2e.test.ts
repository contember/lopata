import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Durable Object bindings with `script_name`: the main worker ("ledger") and an auxiliary
 * worker ("mailbox") each host a class and bind the other's. Every call crosses
 * caller thread → main → the hosting worker's Durable Object thread.
 */

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/cross-worker-do')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')
const PORT = 18880
const base = `http://localhost:${PORT}`

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

async function getJson(path: string): Promise<unknown> {
	const res = await fetch(`${base}${path}`)
	if (res.status !== 200) throw new Error(`GET ${path} returned ${res.status}: ${await res.text()}`)
	return res.json()
}

async function dashboardRpc(procedure: string, input: unknown): Promise<unknown> {
	const res = await fetch(`${base}/__api/rpc`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ procedure, input }),
	})
	return res.json()
}

function cleanup() {
	rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
}

describe('Durable Objects shared across workers (script_name)', () => {
	let proc: Subprocess

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/own/id`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	const receipt = (total: number) => ({ total, atIsDate: true, tagsIsSet: true, tags: ['a', 'b'] })

	test("main worker calls the auxiliary worker's class over RPC with a structured-cloned value", async () => {
		expect(await getJson('/call-mailbox/rpc')).toEqual(receipt(5))
	})

	test("auxiliary worker calls the main worker's class over RPC with a structured-cloned value", async () => {
		expect(await getJson('/mailbox/call-ledger/rpc')).toEqual(receipt(5))
	})

	test('both workers reach the same instance through their own bindings', async () => {
		expect(await getJson('/call-mailbox/id')).toBe(await getJson('/mailbox/own/id'))
		expect(await getJson('/mailbox/call-ledger/id')).toBe(await getJson('/own/id'))

		expect(await getJson('/call-mailbox/rpc')).toEqual(receipt(10))
		expect(await getJson('/mailbox/own/total')).toBe(10)
		expect(await getJson('/mailbox/call-ledger/rpc')).toEqual(receipt(10))
		expect(await getJson('/own/total')).toBe(10)
	})

	test('a thrown error keeps its name and message in both directions', async () => {
		expect(await getJson('/call-mailbox/error')).toEqual({ threw: true, name: 'TypeError', message: 'mailbox is full' })
		expect(await getJson('/mailbox/call-ledger/error')).toEqual({ threw: true, name: 'RangeError', message: 'ledger is closed' })
	})

	test('fetch() to a cross-script stub delivers the Request body and reads the streamed Response', async () => {
		expect(await getJson('/call-mailbox/fetch')).toEqual({ status: 200, host: 'mailbox', text: 'mailbox:POST:payload' })
		expect(await getJson('/mailbox/call-ledger/fetch')).toEqual({ status: 200, host: 'ledger', text: 'ledger:POST:payload' })
	})

	test('a ReadableStream response body from a cross-script stub streams through to the client', async () => {
		const toMailbox = await fetch(`${base}/call-mailbox/stream`)
		expect(toMailbox.headers.get('x-host')).toBe('mailbox')
		expect(await toMailbox.text()).toBe('mailbox:GET:')

		const toLedger = await fetch(`${base}/mailbox/call-ledger/stream`)
		expect(toLedger.headers.get('x-host')).toBe('ledger')
		expect(await toLedger.text()).toBe('ledger:GET:')
	})

	test('a Durable Object calls a class that another worker hosts', async () => {
		expect(await getJson('/call-mailbox/ledger-from-do')).toBe(await getJson('/own/total'))
	})

	test('a binding to a worker lopata does not run fails with a clear error', async () => {
		expect(await getJson('/missing-worker')).toEqual({
			threw: true,
			name: 'Error',
			message: 'Durable Object class "Ghost" is bound with script_name "nowhere", but lopata runs no worker named "nowhere" (workers: ledger, mailbox)',
		})
	})

	test('a binding to a class the target worker does not host fails with a clear error', async () => {
		expect(await getJson('/missing-class')).toEqual({
			threw: true,
			name: 'Error',
			message: 'Worker "mailbox" hosts no Durable Object namespace for class "Phantom". '
				+ 'Declare a durable_objects binding for "Phantom" (without script_name) in that worker\'s wrangler config.',
		})
	})

	test('an auxiliary worker loads Text (.md) and CompiledWasm (.wasm) modules from its wrangler rules', async () => {
		const modules = { prompt: '# Welcome\n\nThis prompt is a Text module.\n', sum: 5 }
		expect(await getJson('/mailbox/modules')).toEqual(modules)
		// The Durable Object thread imports the same module graph.
		expect(await getJson('/call-mailbox/modules')).toEqual(modules)
	})

	test('Data rules, the default Text rule kept by fallthrough, and a removed default rule', async () => {
		const binPath = resolve(FIXTURE_DIR, 'mailbox/src/blob.bin')
		expect(await getJson('/mailbox/rules')).toEqual({
			notes: 'plain text notes',
			data: [1, 2, 3],
			removed: {
				threw: true,
				name: 'Error',
				message: `The file ${binPath} matched a module rule in your configuration ({"type":"Data","globs":["**/*.bin"]}), `
					+ 'but was ignored because a previous rule with the same type was not marked as `fallthrough = true`.',
			},
		})
	})

	test('the dashboard lists each namespace once, under the worker that hosts it', async () => {
		const namespaces = await dashboardRpc('do.listNamespaces', {})
		expect(namespaces).toEqual([{ namespace: 'Ledger', count: 1 }, { namespace: 'Mailbox', count: 1 }])

		const generations = await dashboardRpc('generations.list', {})
		expect(generations).toMatchObject({
			workers: [
				{ workerName: 'ledger', generations: [{ durableObjects: [{ namespace: 'Ledger' }] }] },
				{ workerName: 'mailbox', generations: [{ durableObjects: [{ namespace: 'Mailbox' }] }] },
			],
		})
	})
})
