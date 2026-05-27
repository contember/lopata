import { registerSection } from '../registry'

registerSection({
	slug: 'workflow',
	title: 'Workflow',
	html: `
  <p class="note">
    The fixture workflow runs step 1, then blocks on <code>step.waitForEvent('wait for approval', {type:'approval'})</code> — so a fresh instance stays at <code>waiting</code> until you send an approval event. Approving with <code>{approved:true}</code> finishes step 2 and the workflow goes to <code>complete</code>; <code>{approved:false}</code> short-circuits to <code>{status:'rejected'}</code>.
  </p>
  <form onsubmit="api('POST','/workflow',{input:formVal('wf-input')});return false">
    <label>Input <input id="wf-input" value="hello workflow"></label>
    <button type="submit">Create instance</button>
  </form>
  <form onsubmit="api('GET','/workflow/'+formVal('wf-id'));return false">
    <label>Instance ID <input id="wf-id" placeholder="paste instance id"></label>
    <button type="submit" class="secondary">Get status</button>
  </form>
  <div style="margin-top:0.5rem">
    <button onclick="api('POST','/workflow/'+formVal('wf-id')+'/event',{type:'approval',payload:{approved:true}})">Approve</button>
    <button onclick="api('POST','/workflow/'+formVal('wf-id')+'/event',{type:'approval',payload:{approved:false}})" class="secondary">Reject</button>
  </div>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (path === '/workflow' && method === 'POST') {
			const body = (await request.json()) as { input: string }
			const instance = await env.MY_WORKFLOW.create({ params: { input: body.input } })
			return Response.json({ id: instance.id })
		}
		const wfMatch = path.match(/^\/workflow\/([^/]+)$/)
		if (wfMatch && method === 'GET') {
			const instance = await env.MY_WORKFLOW.get(wfMatch[1]!)
			const status = await instance.status()
			return Response.json({ id: instance.id, status })
		}
		const wfEventMatch = path.match(/^\/workflow\/([^/]+)\/event$/)
		if (wfEventMatch && method === 'POST') {
			const instance = await env.MY_WORKFLOW.get(wfEventMatch[1]!)
			const body = (await request.json()) as { type: string; payload?: unknown }
			await instance.sendEvent({ type: body.type, payload: body.payload })
			return Response.json({ sent: true })
		}
		return null
	},
})
