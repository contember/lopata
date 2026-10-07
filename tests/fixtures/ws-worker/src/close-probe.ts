interface CloseObservation {
	kind: 'listener' | 'property' | 'hibernation'
	state: number
	code: number
	reason: string
	modern: boolean
	afterModern: boolean | null
	sameEvent: boolean
}

interface CloseProbeSocket extends EventTarget {
	readonly readyState: number
	onclose: ((event: CloseEvent) => void) | null
	close(code?: number, reason?: string): void
}

const observations = new Map<string, CloseObservation[]>()

export function closeObservations(token: string): Response {
	return Response.json(observations.get(token) ?? [])
}

export async function recordClose(
	token: string,
	kind: CloseObservation['kind'],
	state: number,
	code: number,
	reason: string,
	sameEvent = true,
): Promise<void> {
	const observation: CloseObservation = {
		kind,
		state,
		code,
		reason,
		modern: typeof crypto.subtle.encapsulateBits === 'function',
		afterModern: null,
		sameEvent,
	}
	const records = observations.get(token) ?? []
	records.push(observation)
	observations.set(token, records)
	await Promise.resolve()
	observation.afterModern = typeof crypto.subtle.encapsulateBits === 'function'
}

export function attachCloseProbe(socket: CloseProbeSocket, token: string): void {
	let listenerEvent: Event | undefined
	socket.addEventListener('close', event => {
		if (!(event instanceof CloseEvent)) throw new Error('Expected CloseEvent')
		listenerEvent = event
		void recordClose(token, 'listener', socket.readyState, event.code, event.reason)
		socket.close(event.code, event.reason)
	})
	socket.onclose = event => {
		void recordClose(token, 'property', socket.readyState, event.code, event.reason, event === listenerEvent)
	}
}
