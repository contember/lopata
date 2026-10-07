import type { Subprocess } from 'bun'
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let child: Subprocess | undefined
let directory: string | undefined
let base: string

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'ai-transport-'))
	child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'fixtures/ai-transport-runner.ts')], {
		cwd: directory,
		stdout: 'pipe',
		stderr: 'inherit',
	})
	if (!child.stdout || typeof child.stdout === 'number') throw new Error('Missing subprocess stdout')
	const reader = child.stdout.getReader()
	let output = ''
	try {
		while (true) {
			const result = await reader.read()
			if (result.done) throw new Error(`AI runtime exited before ready: ${output}`)
			output += new TextDecoder().decode(result.value)
			const match = /READY (\d+)/.exec(output)
			if (match) {
				base = `http://localhost:${match[1]}`
				break
			}
		}
	} finally {
		reader.releaseLock()
	}
}, 20_000)

afterAll(async () => {
	child?.kill()
	await child?.exited
	if (directory) rmSync(directory, { recursive: true, force: true })
})

test('worker-created binary multipart reaches worker-local AI transport incrementally', async () => {
	const response = await fetch(`${base}/multipart`, { signal: AbortSignal.timeout(5000) })
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({ exactBytes: true, incrementalUpload: true })
	if (!directory) throw new Error('Missing fixture directory')
	const db = new Database(join(directory, '.lopata/data.sqlite'), { readonly: true })
	try {
		const row = db.query<{ input_summary: string }, []>("SELECT input_summary FROM ai_requests WHERE model = '@cf/test/multipart'").get()
		expect(row?.input_summary).toContain('<stream>')
		expect(row?.input_summary).not.toContain('private-image')
		expect(row?.input_summary).not.toContain('fixture-secret')
	} finally {
		db.close()
	}
})

test.each(['true', 'false', 'absent'])('worker JSON busy option %s preserves Gateway routing and other inputs', async value => {
	const response = await fetch(`${base}/busy/${value}`)
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		body: JSON.stringify({ prompt: 'worker', options: value === 'absent' ? { seed: 7 } : { seed: 7, rejectIfBusy: value === 'true' } }),
		gateway: 'worker-gateway',
	})
})

test('worker-created signal aborts multipart upload and cancels its source', async () => {
	const response = await fetch(`${base}/abort`, { signal: AbortSignal.timeout(5000) })
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({ uploadCancelled: true })
})

test('response first chunk crosses worker boundary before upstream completion', async () => {
	const response = await fetch(`${base}/stream`, { signal: AbortSignal.timeout(5000) })
	expect(response.headers.get('cf-aig-log-id')).toBe('worker-stream-log')
	if (!response.body) throw new Error('Missing response stream')
	const reader = response.body.getReader()
	expect(new TextDecoder().decode((await reader.read()).value)).toBe('first\n')
	await fetch(`${base}/release`)
	let remaining = ''
	const decoder = new TextDecoder()
	while (true) {
		const result = await reader.read()
		if (result.done) break
		remaining += decoder.decode(result.value, { stream: true })
	}
	expect(remaining + decoder.decode()).toBe('last\n')
})

test('response cancellation crosses the worker boundary back to the upstream source', async () => {
	const controller = new AbortController()
	const response = await fetch(`${base}/stream`, { signal: controller.signal })
	if (!response.body) throw new Error('Missing response stream')
	const reader = response.body.getReader()
	await reader.read()
	controller.abort()
	await reader.cancel().catch(() => {})
	let cancelled: unknown
	for (let attempt = 0; attempt < 100; attempt++) {
		cancelled = await (await fetch(`${base}/cancelled`)).json()
		if (typeof cancelled === 'object' && cancelled !== null && 'responseCancelled' in cancelled && cancelled.responseCancelled === true) break
		await Bun.sleep(20)
	}
	expect(cancelled).toEqual({ responseCancelled: true })
})
