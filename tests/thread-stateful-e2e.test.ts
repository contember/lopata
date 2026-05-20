import type { Subprocess } from 'bun'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-stateful-worker')
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

describe('Stateful bindings in worker-isolation=thread mode', () => {
	let proc: Subprocess
	const PORT = 18801
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT), '--worker-isolation=thread'], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/queue/send`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	function readQueueBodies(queue: string): string[] {
		const db = new Database(resolve(FIXTURE_DIR, '.lopata/data.sqlite'), { readonly: true })
		const rows = db.query<{ body: Uint8Array }, [string]>('SELECT body FROM queue_messages WHERE queue = ? ORDER BY created_at')
			.all(queue)
		db.close()
		return rows.map(r => new TextDecoder().decode(r.body))
	}

	test('queue.send() round-trips through main and persists', async () => {
		const res = await fetch(`${base}/queue/send`)
		expect(await res.text()).toBe('sent')
		expect(readQueueBodies('thread-stateful-q')).toContain('{"hello":"world"}')
	})

	test('queue.sendBatch() persists multiple messages', async () => {
		const res = await fetch(`${base}/queue/send-batch`)
		expect(await res.text()).toBe('batched')
		const bodies = readQueueBodies('thread-stateful-q')
		expect(bodies).toContain('{"item":1}')
		expect(bodies).toContain('{"item":2}')
	})

	test('send_email.send() rebuilds EmailMessage on main and persists', async () => {
		const res = await fetch(`${base}/email/send`)
		expect(await res.text()).toBe('emailed')

		const db = new Database(resolve(FIXTURE_DIR, '.lopata/data.sqlite'), { readonly: true })
		const row = db.query<{ from_addr: string; to_addr: string; status: string }, []>(
			'SELECT from_addr, to_addr, status FROM email_messages ORDER BY created_at DESC LIMIT 1',
		).get()
		db.close()
		expect(row).toMatchObject({ from_addr: 'a@example.com', to_addr: 'b@example.com', status: 'sent' })
	})

	function readKv(key: string): string | null {
		const db = new Database(resolve(FIXTURE_DIR, '.lopata/data.sqlite'), { readonly: true })
		const row = db.query<{ value: Uint8Array }, [string, string]>(
			'SELECT value FROM kv WHERE namespace = ? AND key = ?',
		).get('thread-stateful-kv', key)
		db.close()
		return row ? new TextDecoder().decode(row.value) : null
	}

	test('ctx.waitUntil response returns immediately while background work continues', async () => {
		const res = await fetch(`${base}/wait-until/slow?ms=300&tag=phase3-receipt`)
		expect(await res.text()).toBe('queued')

		// Background put hasn't fired yet
		expect(readKv('phase3-receipt')).toBeNull()

		await new Promise(r => setTimeout(r, 600))
		expect(readKv('phase3-receipt')).toBe('done')
	}, 5_000)

	test("worker-created spans land in main's trace store under the server parent", async () => {
		const res = await fetch(`${base}/trace/nested`)
		expect(await res.text()).toBe('traced')

		// Poll traces.sqlite until the child span flushes through the bridge.
		const deadline = Date.now() + 2_000
		let spans: { name: string; parent_span_id: string | null; trace_id: string; kind: string }[] = []
		while (Date.now() < deadline) {
			const traces = new Database(resolve(FIXTURE_DIR, '.lopata/traces.sqlite'), { readonly: true })
			spans = traces.query<{ name: string; parent_span_id: string | null; trace_id: string; kind: string }, [string]>(
				'SELECT name, parent_span_id, trace_id, kind FROM spans WHERE trace_id IN (SELECT trace_id FROM spans WHERE name = ? ORDER BY start_time DESC LIMIT 1)',
			).all('phase4-child')
			traces.close()
			if (spans.some(s => s.name === 'phase4-child')) break
			await new Promise(r => setTimeout(r, 20))
		}

		const root = spans.find(s => s.parent_span_id === null)
		const child = spans.find(s => s.name === 'phase4-child')
		expect(root?.kind).toBe('server')
		expect(root?.name).toBe('GET /trace/nested')
		expect(child).toBeDefined()
		expect(child?.trace_id).toBe(root?.trace_id)

		const traces = new Database(resolve(FIXTURE_DIR, '.lopata/traces.sqlite'), { readonly: true })
		const events = traces.query<{ name: string; message: string | null }, [string]>(
			'SELECT name, message FROM span_events WHERE span_id = (SELECT span_id FROM spans WHERE name = ? ORDER BY start_time DESC LIMIT 1)',
		).all('phase4-child')
		traces.close()
		expect(events.some(e => e.name === 'phase4-event' && e.message === 'from inside child span')).toBe(true)
	}, 5_000)

	test('reload drains waitUntil from the previous generation before terminating its worker', async () => {
		const workerSrc = resolve(FIXTURE_DIR, 'src/index.ts')
		const original = readFileSync(workerSrc, 'utf-8')

		try {
			// Fire a slow waitUntil that needs ~1.5s to complete
			const res = await fetch(`${base}/wait-until/slow?ms=1500&tag=phase3-drain`)
			expect(await res.text()).toBe('queued')

			// Trigger a reload while the waitUntil is still pending — appending
			// whitespace bumps mtime and the FileWatcher picks it up within 500ms.
			writeFileSync(workerSrc, original + '\n')

			// If drain works the put eventually lands; if the worker is killed
			// mid-flight, the KV entry never appears.
			const deadline = Date.now() + 4_000
			let value: string | null = null
			while (Date.now() < deadline) {
				value = readKv('phase3-drain')
				if (value === 'done') break
				await new Promise(r => setTimeout(r, 100))
			}
			expect(value).toBe('done')
		} finally {
			writeFileSync(workerSrc, original)
		}
	}, 10_000)
})
