// Answers 404 for everything, so any 200 proves the request never reached the worker.
export default {
	async fetch(): Promise<Response> {
		return new Response('worker-not-found', { status: 404 })
	},
}
