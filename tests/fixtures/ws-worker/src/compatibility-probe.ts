interface ProbeSocket {
	readonly readyState: number
	send(data: string): void
	close(code?: number, reason?: string): void
}

export async function compatibilityProbe(socket: ProbeSocket): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 10))
	const state = socket.readyState
	let error: unknown
	try {
		socket.close(1000, '€'.repeat(41) + 'a')
	} catch (caught) {
		error = caught
	}
	const nested = new WebSocketPair()
	let nestedError: unknown
	try {
		nested[0].close(1000, '€'.repeat(41) + 'a')
	} catch (caught) {
		nestedError = caught
	}
	socket.send(JSON.stringify({
		name: error instanceof DOMException ? error.name : null,
		unchanged: socket.readyState === state,
		nested: nestedError instanceof DOMException ? nestedError.name : null,
	}))
	socket.close(1000, '€'.repeat(41))
}
