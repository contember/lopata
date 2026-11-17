import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

test('a dynamic worker thread survives unhandled rejections and task throws, which fail only the invocation that scheduled them', async () => {
	const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'fixtures/worker-loader-errors-runner.ts')], { stdout: 'pipe', stderr: 'pipe' })
	try {
		const [exitCode, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
		if (exitCode !== 0) throw new Error(`Worker loader errors runner failed (${exitCode}):\n${output}\n${errors}`)
		const line = output.split('\n').find(line => line.startsWith('REPORT '))
		if (!line) throw new Error(`Missing worker loader errors report:\n${output}\n${errors}`)
		expect(JSON.parse(line.slice('REPORT '.length))).toEqual({
			responses: ['rejections=0', 'rejections=1', 'error: from a timer', 'rejections=1'],
		})
	} finally {
		child.kill()
	}
}, 30000)
