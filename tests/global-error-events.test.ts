import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

// installUncaughtErrorHandlers() adds process handlers and replaces globals, so it runs in a child process.
const MODULE = resolve(import.meta.dir, '../src/worker-thread/uncaught-errors.ts')

async function run(script: string): Promise<{ exit: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([
		process.execPath,
		'--eval',
		`import { installUncaughtErrorHandlers } from ${JSON.stringify(MODULE)}\ninstallUncaughtErrorHandlers()\n${script}`,
	], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { exit, stdout, stderr }
}

test('a throwing queueMicrotask() callback dispatches a cancelable ErrorEvent and logs unless cancelled', async () => {
	const result = await run(`
const seen = []
addEventListener('error', event => {
	seen.push([event.message, event.error.message, event.cancelable])
	if (event.error.message === 'quiet') event.preventDefault()
})
queueMicrotask(() => { throw new Error('loud') })
queueMicrotask(() => { throw new Error('quiet') })
await Bun.sleep(20)
console.log(JSON.stringify(seen))
`)
	expect(result.exit).toBe(0)
	expect(JSON.parse(result.stdout)).toEqual([
		['Uncaught Error: loud', 'loud', true],
		['Uncaught Error: quiet', 'quiet', true],
	])
	expect(result.stderr).toContain('[lopata] Uncaught')
	expect(result.stderr).toContain('error: loud')
	expect(result.stderr).not.toContain('error: quiet')
})

test('reportError() dispatches the same event, and both functions validate their argument', async () => {
	const result = await run(`
const seen = []
addEventListener('error', event => { seen.push(event.message); event.preventDefault() })
reportError('plain value')
const thrown = []
for (const call of [() => reportError(), () => queueMicrotask('not a function')]) {
	try { call() } catch (error) { thrown.push(error.constructor.name) }
}
console.log(JSON.stringify({ seen, thrown }))
`)
	expect(result.exit).toBe(0)
	expect(JSON.parse(result.stdout)).toEqual({ seen: ['Uncaught plain value'], thrown: ['TypeError', 'TypeError'] })
	expect(result.stderr).toBe('')
})
