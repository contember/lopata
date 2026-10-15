import { type BrowserRun, versionRoundTrip } from '../../cdp'

export default {
	async fetch(_request: Request, env: { BROWSER: BrowserRun }): Promise<Response> {
		return Response.json(await versionRoundTrip(env.BROWSER))
	},
}
