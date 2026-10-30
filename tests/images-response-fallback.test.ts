import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Images response preserves passthrough bytes and headers when Sharp is unavailable', async () => {
	// Isolate resolution from repository dependencies and disable Bun's automatic package installation.
	const directory = mkdtempSync(join(tmpdir(), 'images-response-fallback-'))
	try {
		await Bun.write(join(directory, 'images.ts'), Bun.file(resolve(import.meta.dir, '../src/bindings/images.ts')))
		const child = Bun.spawn([
			process.execPath,
			'--no-install',
			'--eval',
			`
import assert from 'node:assert/strict'
import { ImagesBinding } from './images.ts'
await assert.rejects(import('sharp'))
const input = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"/>')
const result = await new ImagesBinding().input(new Blob([input]).stream())
	.transform({ width: 1, height: 1 }).output({ format: 'image/png' })
for (const headers of [
	undefined,
	{ 'CoNtEnT-TyPe': 'text/html', 'X-Custom': 'kept' },
	[['Content-Type', 'text/html'], ['content-type', 'application/javascript'], ['X-Custom', 'kept']],
	new Headers({ 'Content-Type': 'text/html', 'X-Custom': 'kept' }),
]) {
	const original = headers instanceof Headers ? [...headers] : structuredClone(headers)
	const response = result.response(headers ? { headers } : undefined)
	assert.ok(response instanceof Response)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get('content-type'), 'image/png')
	assert.equal(result.contentType(), 'image/png')
	assert.equal(response.headers.get('x-custom'), headers ? 'kept' : null)
	response.headers.set('x-custom', 'changed')
	assert.deepEqual(headers instanceof Headers ? [...headers] : headers, original)
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), input)
}
assert.deepEqual(new Uint8Array(await new Response(result.image()).arrayBuffer()), input)
`,
		], { cwd: directory, stdout: 'pipe', stderr: 'pipe' })
		const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
		expect({ exit, stdout, stderr }).toEqual({
			exit: 0,
			stdout: '',
			stderr: '[lopata] sharp is not installed — image transformations will pass through unchanged. Install it: bun add sharp\n',
		})
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})
