/**
 * Raw TCP listeners from the wrangler `connect` config. Each accepted connection is served by the `connect()` handler
 * of the worker's active generation; a reload sends new connections to the new generation while open ones keep theirs.
 */

import { refuseConnection, relayTcpConnection, tcpListenerHandlers } from './bindings/sockets'
import type { GenerationManager } from './generation-manager'

/** `host:port`, IPv6 in brackets, as workerd reports socket addresses. */
function formatAddress(host: string, port: number): string {
	return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

export function startConnectListeners(manager: GenerationManager): { stop(): void } {
	const listeners: { stop(closeActiveConnections?: boolean): void }[] = []
	const workerName = manager.workerName ?? manager.config.name
	for (const entry of manager.config.connect ?? []) {
		if (entry.protocol !== 'tcp') {
			console.warn(
				`[lopata] Worker "${workerName}": connect listeners with protocol "${entry.protocol}" are not supported, port ${entry.port} is not opened`,
			)
			continue
		}
		const hostname = entry.address ?? '127.0.0.1'
		let localAddress = ''
		const listener = Bun.listen({
			hostname,
			port: entry.port,
			allowHalfOpen: true,
			socket: tcpListenerHandlers(socket => {
				const { port1, port2 } = new MessageChannel()
				void relayTcpConnection(socket, port1)
				const info = { remoteAddress: formatAddress(socket.remoteAddress, socket.remotePort), localAddress }
				const generation = manager.active
				if (!generation) refuseConnection(port2, `Worker "${workerName}" has no active generation`)
				else void generation.callConnect(port2, info)
			}),
		})
		localAddress = formatAddress(hostname, listener.port)
		listeners.push(listener)
		console.log(`[lopata] Worker "${workerName}" accepts TCP connections on ${localAddress}`)
	}
	return {
		stop() {
			for (const listener of listeners) listener.stop(true)
		},
	}
}
