interface Env {
	AUX: { version: Promise<string>; label: Promise<string>; double(n: number): Promise<number> }
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (new URL(request.url).pathname !== '/aux') return new Response('main')
		// Awaiting a member of a service binding reads the property over RPC; calling it invokes the method.
		const [version, label, double] = await Promise.all([env.AUX.version, env.AUX.label, env.AUX.double(21)])
		return Response.json({ version, label, double })
	},
}
