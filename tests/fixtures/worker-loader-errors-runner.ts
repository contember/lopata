// Runs outside `bun test`: its runner swallows a Worker thread's process.on('unhandledRejection'/'uncaughtException')
// handlers, so a dynamic worker's error handling is only observable in a plain process.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerLoaderBinding } from '../../src/bindings/worker-loader'

const MAIN = `let rejections = 0
addEventListener('unhandledrejection', () => { rejections++ })
export default {
	async fetch(request) {
		const path = new URL(request.url).pathname
		if (path === '/reject') Promise.reject(new Error('unhandled'))
		if (path === '/throw') setTimeout(() => { throw new Error('from a timer') }, 0)
		if (path === '/throw-and-wait') {
			setTimeout(() => { throw new Error('from a timer') }, 0)
			await new Promise(resolve => setTimeout(resolve, 1000))
		}
		return new Response('rejections=' + rejections)
	},
}`

async function call(fetcher: { fetch(url: string): Promise<Response> }, path: string): Promise<string> {
	try {
		return await (await fetcher.fetch(`http://loader${path}`)).text()
	} catch (error) {
		return `error: ${error instanceof Error ? error.message : String(error)}`
	}
}

const directory = mkdtempSync(join(tmpdir(), 'lopata-loader-errors-'))
const loader = new WorkerLoaderBinding(directory)
try {
	const entrypoint = loader.load({ compatibilityDate: '2026-03-01', mainModule: 'main.js', modules: { 'main.js': MAIN } }).getEntrypoint()
	const responses: string[] = []
	responses.push(await call(entrypoint, '/reject'))
	await Bun.sleep(50)
	responses.push(await call(entrypoint, '/throw'))
	await Bun.sleep(50)
	responses.push(await call(entrypoint, '/throw-and-wait'))
	responses.push(await call(entrypoint, '/'))
	console.log(`REPORT ${JSON.stringify({ responses })}`)
} finally {
	loader.disposeAll()
	rmSync(directory, { recursive: true, force: true })
}
// A disposed loader's handles keep a plain process alive; the report is out, so end it.
process.exit(0)
