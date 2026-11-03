import { DurableObjectBase } from '../../src/bindings/durable-object'
import { WorkerLoaderBinding } from '../../src/bindings/worker-loader'

/** Start a dynamic worker that records its module directory in `<file>.dir` and appends to `file` every 10 ms while its thread lives. */
async function startTicker(env: unknown, file: string): Promise<string> {
	const loader: unknown = typeof env === 'object' && env !== null ? Reflect.get(env, 'LOADER') : undefined
	if (!(loader instanceof WorkerLoaderBinding)) throw new Error('env.LOADER is not a Worker Loader')
	const stub = loader.get('ticker', () => ({
		compatibilityDate: '2026-03-01',
		mainModule: 'main.js',
		modules: {
			'main.js': `import { appendFileSync, writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(`${file}.dir`)}, import.meta.dir)
setInterval(() => appendFileSync(${JSON.stringify(file)}, 'x'), 10)
export default { fetch() { return new Response('ticking') } }`,
		},
	}))
	return (await stub.getEntrypoint().fetch('http://loader/')).text()
}

export class LoaderOwner extends DurableObjectBase {
	startTicker(file: string): Promise<string> {
		return startTicker(this.env, file)
	}

	abortNow(): void {
		this.ctx.abort('requested abort')
	}
}

export default {
	async fetch(request: Request, env: unknown): Promise<Response> {
		const file = new URL(request.url).searchParams.get('file')
		if (!file) return new Response('missing file', { status: 400 })
		return new Response(await startTicker(env, file))
	},
}
