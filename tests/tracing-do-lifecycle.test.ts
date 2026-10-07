import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const mode of ['thread', 'inprocess']) {
	for (
		const scenario of [
			'body',
			'background',
			'cancel',
			'cancel-error',
			'concurrency',
			'terminate',
			'terminate-body',
			'handlers',
			'failures',
			'constructor-failure',
			'runtime-isolation',
			'parent-worker',
			...(mode === 'thread' ? ['crash', 'late-messages'] : []),
			...(mode === 'inprocess'
				? [
					'session-target',
					'session-function-get',
					'session-inflight',
					'session-terminate',
					'session-nested',
					'session-caller-finish',
					'session-caller-terminate',
					'session-initial-executor-scalar',
					'session-initial-executor-plain',
					'session-initial-executor-getter',
					'session-initial-caller-scalar',
					'session-initial-caller-plain',
					'session-initial-caller-getter',
				]
				: []),
		]
	) {
		test(`DO invocation lifecycle ${mode}: ${scenario}`, async () => {
			const directory = mkdtempSync(join(tmpdir(), 'lopata-tracing-do-'))
			const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'fixtures/tracing-do-runner.ts'), mode, scenario], {
				cwd: directory,
				stdout: 'pipe',
				stderr: 'pipe',
			})
			try {
				const [code, output, errors] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				])
				if (code !== 0) throw new Error(`DO lifecycle ${mode}/${scenario} failed (${code}):\n${output}\n${errors}`)
				expect(code).toBe(0)
			} finally {
				child.kill()
				rmSync(directory, { recursive: true, force: true })
			}
		}, 20000)
	}
}
