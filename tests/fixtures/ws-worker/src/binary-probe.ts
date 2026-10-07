interface BinaryProbeSocket {
	binaryType: string
	send(data: string | ArrayBuffer): void
}

export async function binaryProbe(socket: BinaryProbeSocket, data: unknown): Promise<void> {
	if (typeof data === 'string') {
		if (data.startsWith('type:')) socket.binaryType = data.slice(5)
		socket.send(JSON.stringify({ text: data, binaryType: socket.binaryType }))
		return
	}
	if (!(data instanceof Blob) && !(data instanceof ArrayBuffer)) throw new Error('Expected binary message')
	const bytes = data instanceof Blob ? await data.arrayBuffer() : data
	socket.send(JSON.stringify({
		kind: data instanceof Blob ? 'blob' : 'arraybuffer',
		binaryType: socket.binaryType,
		mime: data instanceof Blob ? data.type : null,
		bytes: [...new Uint8Array(bytes)],
	}))
	socket.send(bytes)
}
