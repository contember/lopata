import { DurableObject, exports, WorkerEntrypoint } from 'cloudflare:workers'

/** Stateless entrypoint reached through `ctx.exports` loopbacks. */
export class Renderer extends WorkerEntrypoint {
	greet(name: string): string {
		return `${this.ctx.props.tenant ?? 'none'}:${name}`
	}

	async fetch(request: Request): Promise<Response> {
		return new Response(`${this.ctx.props.tenant ?? 'none'}:${new URL(request.url).pathname}`)
	}
}

const DYNAMIC_MAIN = `
export default {
	async fetch(request, env) {
		const greeting = await env.RENDERER.greet('dynamic')
		const fetched = await (await env.RENDERER.fetch('http://renderer/page')).text()
		return Response.json({ greeting, fetched, config: env.CONFIG, isMap: env.CONFIG.tags instanceof Map })
	},
}
`

/** A Durable Object that hosts a renderer in Worker Loader isolates and keeps state in SQLite. */
export class Host extends DurableObject {
	async renderDynamic(): Promise<unknown> {
		const worker = this.env.LOADER.load({
			compatibilityDate: '2026-02-12',
			mainModule: 'main.js',
			modules: { 'main.js': DYNAMIC_MAIN },
			env: {
				RENDERER: this.ctx.exports.Renderer({ props: { tenant: 'from-do' } }),
				CONFIG: { tags: new Map([['a', 1]]) },
			},
		})
		const response = await worker.getEntrypoint().fetch('http://dynamic/')
		return response.json()
	}

	async loopbackFromDo(): Promise<string> {
		return this.ctx.exports.Renderer({ props: { tenant: 'do' } }).greet('x')
	}

	writeInNestedTransactions(): unknown {
		const sql = this.ctx.storage.sql
		sql.exec('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY)')
		this.ctx.storage.transactionSync(() => {
			sql.exec('INSERT INTO files VALUES (?)', 'kept.txt')
			try {
				this.ctx.storage.transactionSync(() => {
					sql.exec('INSERT INTO files VALUES (?)', 'dropped.txt')
					throw new Error('inner failure')
				})
			} catch {}
		})
		try {
			this.ctx.storage.transactionSync(() => {
				sql.exec('INSERT INTO files VALUES (?)', 'outer-dropped.txt')
				throw new Error('outer failure')
			})
		} catch {}
		return sql.exec('SELECT path FROM files ORDER BY path').toArray().map(row => row.path)
	}
}

export default {
	async fetch(request: Request, env: any, ctx: any): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/exports') {
			return Response.json({
				viaCtx: await ctx.exports.Renderer({ props: { tenant: 'ctx' } }).greet('a'),
				viaImport: await exports.Renderer({ props: { tenant: 'import' } }).greet('b'),
				withoutProps: await (await ctx.exports.Renderer.fetch('http://renderer/plain')).text(),
				defaultIsLoopback: typeof ctx.exports.default.fetch === 'function',
				hostIsNamespace: typeof ctx.exports.Host.idFromName === 'function',
			})
		}
		if (url.pathname === '/do-loopback') {
			return Response.json(await env.HOST.getByName('loopback').loopbackFromDo())
		}
		if (url.pathname === '/do-loader') {
			return Response.json(await env.HOST.getByName('loader').renderDynamic())
		}
		if (url.pathname === '/do-transactions') {
			return Response.json(await env.HOST.getByName('transactions').writeInNestedTransactions())
		}
		return new Response('ok')
	},
}
