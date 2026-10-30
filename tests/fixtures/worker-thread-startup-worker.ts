export default {
	fetch(request: Request, env: { WORKER_NAME: string }): Response {
		return Response.json({ worker: env.WORKER_NAME, path: new URL(request.url).pathname })
	},
}
