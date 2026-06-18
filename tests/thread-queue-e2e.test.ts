import type { Subprocess } from 'bun'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-queue-worker')
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

describe('Queue consumers (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18806
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/receipts`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('messages produced from fetch are consumed in worker and acked', async () => {
		await fetch(`${base}/send?body=alpha`)
		await fetch(`${base}/send?body=bravo`)
		await fetch(`${base}/send?body=charlie`)

		// Poll until the consumer's poll cycle picks them up + acks
		const deadline = Date.now() + 4_000
		let receipts: string[] = []
		while (Date.now() < deadline) {
			receipts = await (await fetch(`${base}/receipts`)).json() as string[]
			if (receipts.length >= 3) break
			await new Promise(r => setTimeout(r, 100))
		}
		expect(receipts.sort()).toEqual(['receipt:alpha', 'receipt:bravo', 'receipt:charlie'])

		const db = new Database(resolve(FIXTURE_DIR, '.lopata/data.sqlite'), { readonly: true })
		const statuses = db.query<{ status: string }, [string]>('SELECT status FROM queue_messages WHERE queue = ?')
			.all('thread-q-work').map(r => r.status)
		db.close()
		expect(statuses.every(s => s === 'acked')).toBe(true)
	}, 10_000)
})
