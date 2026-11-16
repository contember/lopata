// Runs inside each generated conformance worker (a lopata worker thread).
// A workerd test module exports objects with a `test(ctrl, env, ctx)` handler and `workerd test`
// invokes every such export; this wrapper exposes the same through HTTP.

export interface RunResult {
	ok: boolean
	error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function testHandler(mod: Record<string, unknown>, name: string): ((ctrl: unknown, env: unknown, ctx: unknown) => unknown) | null {
	const entry = mod[name]
	if (!isRecord(entry) || typeof entry.test !== 'function') return null
	const test = entry.test
	return (ctrl, env, ctx) => test.call(entry, ctrl, env, ctx)
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
	return String(err)
}

async function handleConformance(mod: Record<string, unknown>, request: Request, env: unknown, ctx: unknown): Promise<Response | null> {
	const url = new URL(request.url)
	if (url.pathname === '/__conformance/list') {
		return Response.json(Object.keys(mod).filter(name => testHandler(mod, name) !== null))
	}
	if (url.pathname !== '/__conformance/run') return null
	const test = testHandler(mod, url.searchParams.get('test') ?? '')
	if (!test) return Response.json({ ok: false, error: 'no such test export' } satisfies RunResult)
	try {
		await test({}, env, ctx)
		return Response.json({ ok: true } satisfies RunResult)
	} catch (err) {
		return Response.json({ ok: false, error: describeError(err) } satisfies RunResult)
	}
}

/** Default export of the wrapper: serves `/__conformance/*` and forwards other requests to the module's own default handlers. */
export function wrapDefault(mod: Record<string, unknown>): Record<string, unknown> {
	const base = isRecord(mod.default) ? mod.default : {}
	const baseFetch = base.fetch
	return {
		...base,
		async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
			const handled = await handleConformance(mod, request, env, ctx)
			if (handled) return handled
			if (typeof baseFetch !== 'function') return new Response('no fetch handler', { status: 404 })
			return baseFetch.call(base, request, env, ctx)
		},
	}
}
