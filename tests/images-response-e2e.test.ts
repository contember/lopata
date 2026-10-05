import type { Subprocess } from 'bun'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

let child: Subprocess | undefined
let directory: string | undefined
let base: string

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'images-response-worker-'))
	child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'fixtures/images-response-runner.ts')], {
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
			if (result.done) throw new Error(`Image runtime exited before ready: ${output}`)
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

test('worker returns Images .response() with transformed body and custom headers over HTTP', async () => {
	const input = await sharp({ create: { width: 48, height: 24, channels: 3, background: '#ff0000' } }).png().toBuffer()
	const response = await fetch(base, { method: 'POST', body: input, signal: AbortSignal.timeout(10_000) })
	expect(response.status).toBe(200)
	expect(response.headers.get('content-type')).toBe('image/webp')
	expect(response.headers.get('x-image-worker')).toBe('transformed')
	expect(response.headers.get('cache-control')).toBe('public, max-age=60')
	const bytes = new Uint8Array(await response.arrayBuffer())
	expect(await sharp(bytes).metadata()).toMatchObject({ width: 12, height: 6, format: 'webp' })
	expect(bytes).not.toEqual(new Uint8Array(input))
}, 15_000)
