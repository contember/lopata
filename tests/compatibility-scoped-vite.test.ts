import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('two Vite servers scope transformed imports, concurrent requests and module reload', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-scoped-vite-'))
	const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/compatibility-scoped-vite-runner.ts')], {
		cwd: directory,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	try {
		const stdout = new Response(child.stdout).text()
		const stderr = new Response(child.stderr).text()
		const exit = await child.exited
		const output = await stdout
		const errors = await stderr
		if (exit !== 0) throw new Error(`Vite scope runner failed (${exit}):\n${output}\n${errors}`)
		expect(output).toContain('scoped Vite passed')
	} finally {
		child.kill()
		rmSync(directory, { recursive: true, force: true })
	}
}, 30000)
