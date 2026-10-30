import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('direct worker executors initialize WAL before worker startup and serve concurrent requests', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-worker-startup-'))
	const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'fixtures/worker-thread-startup-runner.ts')], {
		cwd: directory,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	try {
		const [exitCode, output, errors] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		])
		if (exitCode !== 0) throw new Error(`Worker startup runner failed (${exitCode}):\n${output}\n${errors}`)
		const line = output.split('\n').find(line => line.startsWith('REPORT '))
		if (!line) throw new Error(`Missing worker startup report:\n${output}\n${errors}`)
		const report: unknown = JSON.parse(line.slice('REPORT '.length))
		expect(report).toEqual({
			journalModes: ['wal', 'wal'],
			responses: [
				{ worker: 'first', path: '/first' },
				{ worker: 'second', path: '/second' },
			],
		})
	} finally {
		child.kill()
		rmSync(directory, { recursive: true, force: true })
	}
}, 30000)
