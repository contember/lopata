import type { Subprocess } from 'bun'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execPath } from 'node:process'

let process: Subprocess
let directory: string
let base: string

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
		const match = /READY (\d+)/.exec(log)
		if (!match) continue
		base = `http://localhost:${match[1]}`
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

async function spans(): Promise<Span[]> {
	const value: unknown = await (await fetch(base + '/__spans')).json()
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

test('real Vite SSR named tracing forwards to the native tracing singleton', async () => {
	expect(await (await fetch(base + '/identity')).json()).toEqual({ same: true, traced: true, forwarded: 42 })
	const root = await waitForSpan('GET /identity', true)
	expect((await waitForSpan('forwarded', true)).parentSpanId).toBe(root.spanId)
})
