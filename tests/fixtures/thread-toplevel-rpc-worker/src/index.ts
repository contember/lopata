import { env } from 'cloudflare:workers'

// Issue a stateful-binding RPC at module top level — this posts an rpc-call to
// main DURING the user-module import, before the worker installs its full
// message handler. If RPC replies aren't routed during init, this await hangs,
// `ready` never posts, and the dev server never comes up.
let bootSendOk = false
await (env as { WORK_QUEUE: { send(body: unknown): Promise<void> } }).WORK_QUEUE.send({ phase: 'module-top-level' })
bootSendOk = true

export default {
	async fetch(): Promise<Response> {
		return Response.json({ bootSendOk })
	},
}
