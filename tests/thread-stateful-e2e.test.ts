import type { Subprocess } from 'bun'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
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
})
