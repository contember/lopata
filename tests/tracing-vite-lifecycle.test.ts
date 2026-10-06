import type { Subprocess } from 'bun'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execPath } from 'node:process'

let process: Subprocess
let directory: string
let base: string
let controlBase: string

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'tracing-vite-'))
	process = Bun.spawn([execPath, resolve(import.meta.dir, 'fixtures/tracing-vite-runner.ts')], {
		cwd: directory,
		stdout: 'pipe',
		stderr: 'inherit',
	})
	const output = process.stdout
	if (!output || typeof output === 'number') throw new Error('Missing runner stdout')
	const reader = output.getReader()
	let log = ''
	while (true) {
		const result = await reader.read()
		if (result.done) throw new Error(`Vite exited before ready: ${log}`)
		log += new TextDecoder().decode(result.value)
		const match = /READY (\d+) CONTROL (\d+)/.exec(log)
		if (!match) continue
		base = `http://localhost:${match[1]}`
		controlBase = `http://localhost:${match[2]}`
		break
	}
	reader.releaseLock()
	void (async () => {
		for await (const _chunk of output) {}
	})()
}, 30_000)

afterAll(async () => {
	process?.kill()
	if (process) await process.exited
	if (directory) rmSync(directory, { recursive: true, force: true })
})

interface Span {
	name: string
	spanId: string
	parentSpanId: string | null
	endTime: number | null
	status: string
	attributes: object
}

async function spans(url = base + '/__spans'): Promise<Span[]> {
	const value: unknown = await (await fetch(url)).json()
	if (!Array.isArray(value)) throw new Error('Invalid spans response')
	return value.map((row: unknown) => {
		if (!row || typeof row !== 'object') throw new Error('Invalid span')
		if (
			!('name' in row) || typeof row.name !== 'string' || !('spanId' in row) || typeof row.spanId !== 'string'
			|| !('parentSpanId' in row) || (row.parentSpanId !== null && typeof row.parentSpanId !== 'string')
			|| !('endTime' in row) || (row.endTime !== null && typeof row.endTime !== 'number')
			|| !('status' in row) || typeof row.status !== 'string'
			|| !('attributes' in row) || row.attributes === null || typeof row.attributes !== 'object'
		) throw new Error('Invalid span fields')
		return { name: row.name, spanId: row.spanId, parentSpanId: row.parentSpanId, endTime: row.endTime, status: row.status, attributes: row.attributes }
	})
}

async function waitForSpan(name: string, ended = false): Promise<Span> {
	const deadline = Date.now() + 3000
	while (true) {
		const row = (await spans()).find(row => row.name === name)
		if (row && (!ended || row.endTime !== null)) return row
		if (Date.now() > deadline) throw new Error(`Missing ${ended ? 'ended' : 'started'} span ${name}`)
		await Bun.sleep(10)
	}
}

async function release(name: string): Promise<void> {
	await (await fetch(base + '/release/' + name)).arrayBuffer()
}

test('real Vite SSR named tracing forwards to the native invocation singleton', async () => {
	expect(await (await fetch(base + '/identity')).json()).toEqual({ same: true, traced: true, outside: false, forwarded: 42 })
	const root = await waitForSpan('GET /identity', true)
	expect((await waitForSpan('forwarded', true)).parentSpanId).toBe(root.spanId)
	expect((await spans()).some(row => row.name === 'outside-module')).toBe(false)
})

test('bodyless finish preserves imported and nested context waitUntil lifetimes', async () => {
	expect((await fetch(base + '/background')).status).toBe(204)
	expect((await waitForSpan('GET /background')).endTime).toBeNull()
	await release('background')
	await waitForSpan('background-first', true)
	expect((await waitForSpan('GET /background')).endTime).toBeNull()
	await release('nested')
	const root = await waitForSpan('GET /background', true)
	expect((await waitForSpan('background-manual', true)).parentSpanId).toBe(root.spanId)
	expect((await waitForSpan('background-nested', true)).parentSpanId).toBe(root.spanId)
})

test('HTTP response stays open through delayed source EOF and native finish', async () => {
	const response = await fetch(base + '/stream')
	const reader = response.body!.getReader()
	expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
	expect((await waitForSpan('GET /stream')).endTime).toBeNull()
	await release('body')
	expect(new TextDecoder().decode((await reader.read()).value)).toBe('last')
	expect((await reader.read()).done).toBe(true)
	const root = await waitForSpan('GET /stream', true)
	expect((await waitForSpan('body-finish', true)).parentSpanId).toBe(root.spanId)
})

test('premature HTTP close cancels the source and waits for asynchronous cleanup', async () => {
	await new Promise<void>((resolve, reject) => {
		const request = get(base + '/cancel', response => {
			response.once('data', () => {
				request.destroy()
				resolve()
			})
		})
		request.once('error', reject)
	})
	await waitForSpan('cancel-start', true)
	expect((await waitForSpan('GET /cancel')).endTime).toBeNull()
	await release('cancel')
	await waitForSpan('cancel-end', true)
	expect((await waitForSpan('GET /cancel')).endTime).toBeNull()
	await release('cancel-background')
	expect((await waitForSpan('GET /cancel', true)).status).toBe('error')
	await waitForSpan('cancel-background', true)
})

test('handler and body errors end the runtime root as error', async () => {
	const response = await fetch(base + '/failure')
	expect(response.status).toBe(500)
	await response.text()
	expect((await waitForSpan('GET /failure', true)).status).toBe('error')
	try {
		await (await fetch(base + '/body-error')).text()
	} catch {}
	expect((await waitForSpan('GET /body-error', true)).status).toBe('error')
})

test('scheduled and email dispatches keep native background scopes after trigger responses', async () => {
	await (await fetch(base + '/cdn-cgi/handler/scheduled')).text()
	expect((await waitForSpan('scheduled')).endTime).toBeNull()
	await release('scheduled')
	await waitForSpan('scheduled-manual', true)
	await waitForSpan('scheduled-background', true)
	await waitForSpan('scheduled', true)
	await (await fetch(base + '/cdn-cgi/handler/email?from=a@example.com&to=b@example.com', { method: 'POST', body: 'Subject: Test\r\n\r\nHello' }))
		.text()
	expect((await waitForSpan('email')).endTime).toBeNull()
	await release('email')
	await waitForSpan('email-manual', true)
	await waitForSpan('email-background', true)
	await waitForSpan('email', true)
})

test('Vite shutdown closes completed Workflow engines with live callbacks and preserves unrelated bindings', async () => {
	expect(await (await fetch(base + '/workflow-start')).text()).toBe('complete')
	expect((await waitForSpan('workflow PENDING')).endTime).toBeNull()
	await spans(controlBase + '/prepare')
	const closed = await spans(controlBase + '/close')
	const root = closed.find(span => span.name === 'workflow PENDING')
	expect(root).toBeDefined()
	expect(root?.endTime).not.toBeNull()
	expect(root?.status).toBe('error')
	expect(closed.find(span => span.name === 'vite-workflow-manual')?.endTime).not.toBeNull()
	expect(closed.find(span => span.name === 'workflow other-runtime')?.endTime).toBeNull()
	const late = await spans(controlBase + '/release-vite')
	expect(late).toEqual(closed)
	expect(late.some(span => span.name === 'vite-workflow-late')).toBe(false)
	const drained = await spans(controlBase + '/release-other')
	expect(drained.find(span => span.name === 'workflow other-runtime')?.endTime).not.toBeNull()
	expect(drained.find(span => span.name === 'workflow other-runtime')?.status).toBe('ok')
})
