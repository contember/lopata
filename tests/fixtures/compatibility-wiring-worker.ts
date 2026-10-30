import { getActiveCompatibility } from '../../src/compatibility-context'

function limited(): boolean {
	return getActiveCompatibility().websocketCloseReasonByteLimit === 'enabled'
}

const topLevelLimited = limited()

export default {
	async fetch(request: Request, env: {
		TARGET?: { fetch(request: Request): Promise<Response> }
		DO?: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
	}) {
		const pathname = new URL(request.url).pathname
		if (pathname.startsWith('/do/') && env.DO) {
			return env.DO.get(env.DO.idFromName(pathname)).fetch(request)
		}
		if (new URL(request.url).pathname === '/target' && env.TARGET) {
			return env.TARGET.fetch(new Request('https://worker.test/'))
		}
		return Response.json({ topLevelLimited, limited: limited() })
	},
}

export class CompatibilityProbe {
	fetch() {
		return Response.json({ topLevelLimited, limited: limited() })
	}
}
