import { registerSection } from '../registry'

registerSection({
	slug: 'analytics',
	title: 'Analytics Engine',
	html: `
  <div class="links">
    <a href="#" onclick="api('POST','/analytics/track',{index:'page-view',doubles:[1],blobs:['/home']});return false">Track page view</a>
    <a href="#" onclick="api('POST','/analytics/track',{index:'click',doubles:[Date.now()],blobs:['buy-button']});return false">Track click</a>
    <a href="#" onclick="api('POST','/analytics/track',{});return false">Track empty event</a>
  </div>
  <form onsubmit="api('POST','/analytics/track',{index:formVal('ae-idx'),doubles:formVal('ae-doubles')?JSON.parse('['+formVal('ae-doubles')+']'):[],blobs:formVal('ae-blobs')?formVal('ae-blobs').split(','):[]});return false">
    <label>Index <input id="ae-idx" value="custom-event"></label>
    <label>Doubles (comma-sep) <input id="ae-doubles" value="42,3.14"></label>
    <label>Blobs (comma-sep) <input id="ae-blobs" value="click,homepage"></label>
    <button type="submit">Write data point</button>
  </form>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (path === '/analytics/track' && method === 'POST') {
			const body = (await request.json()) as { index?: string; doubles?: number[]; blobs?: string[] }
			env.ANALYTICS.writeDataPoint({
				indexes: body.index ? [body.index] : undefined,
				doubles: body.doubles,
				blobs: body.blobs,
			})
			return Response.json({ success: true }, { status: 201 })
		}
		return null
	},
})
