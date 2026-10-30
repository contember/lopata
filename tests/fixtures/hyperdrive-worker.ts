import { HyperdriveBinding } from '../../src/bindings/hyperdrive'

export function snapshot(env: Record<string, unknown>) {
	const bindings = Object.fromEntries(['PRIMARY', 'SECONDARY', 'MISSING'].map(name => {
		const binding = env[name]
		if (!(binding instanceof HyperdriveBinding)) throw new Error(`Missing Hyperdrive binding: ${name}`)
		return [name, { connectionString: binding.connectionString, port: binding.port, host: binding.host }]
	}))
	return { bindings, overrideExposed: 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_PRIMARY' in env }
}

export class HyperdriveDO {
	constructor(_state: unknown, private env: Record<string, unknown>) {}

	fetch() {
		return Response.json(snapshot(this.env))
	}
}

interface WorkerEnv extends Record<string, unknown> {
	PROBE: { getByName(name: string): { fetch(request: Request): Promise<Response> } }
}

export default {
	fetch(request: Request, env: WorkerEnv) {
		if (new URL(request.url).pathname === '/do') return env.PROBE.getByName('probe').fetch(request)
		return Response.json(snapshot(env))
	},
}
