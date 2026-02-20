import { Container } from '@cloudflare/containers'

export class MyContainer extends Container<Env> {
	override defaultPort = 80
	override sleepAfter = '5m'

	override onStart() {
		console.log('[container] started')
	}

	override onStop() {
		console.log('[container] stopped')
	}

	override onError(error: Error) {
		console.error('[container] error:', error.message)
	}
}
