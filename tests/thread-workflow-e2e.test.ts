import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/thread-workflow-worker')
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

describe('Workflows (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18805
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/start?name=probe`, 20_000)
	}, 25_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	async function waitForStatus(id: string, deadline = Date.now() + 5_000): Promise<{ status: string; output?: unknown }> {
		while (Date.now() < deadline) {
			const res = await fetch(`${base}/status/${id}`)
			const body = await res.json() as { status: string; output?: unknown }
			if (body.status === 'complete' || body.status === 'errored' || body.status === 'terminated') return body
			await new Promise(r => setTimeout(r, 50))
		}
		throw new Error(`Workflow ${id} did not finish in time`)
	}

	test('workflow.create returns an instance handle; steps run in the worker', async () => {
		const id = await (await fetch(`${base}/start?name=alice`)).text()
		expect(id).toMatch(/^wf-/)
		const status = await waitForStatus(id)
		expect(status).toMatchObject({
			status: 'complete',
			output: { greeting: 'hello alice', length: 11 },
		})
	})

	test('different params produce different outputs', async () => {
		const id = await (await fetch(`${base}/start?name=bob`)).text()
		const status = await waitForStatus(id)
		expect(status.output).toMatchObject({ greeting: 'hello bob', length: 9 })
	})
})
