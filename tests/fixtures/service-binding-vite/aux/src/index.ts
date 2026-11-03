import { WorkerEntrypoint } from 'cloudflare:workers'

export default class extends WorkerEntrypoint {
	version = '1.2.3'

	get label(): string {
		return 'aux worker'
	}

	fetch(): Response {
		return new Response('aux')
	}

	double(n: number): number {
		return n * 2
	}
}
