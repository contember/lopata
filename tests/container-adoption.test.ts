import { describe, expect, test } from 'bun:test'
import { ContainerRuntime } from '../src/bindings/container'
import type { DockerManager } from '../src/bindings/container-docker'

// Regression for the port-mapping adoption bug: ContainerRuntime.start() adopts
// an already-running container (after reload / eviction / crash) and recovers its
// port mappings from DockerManager.inspect(). inspect() returns the FLATTENED
// ports shape ({ "8080/tcp": "0.0.0.0:32768" }), so _recoverPortMappings must
// parse strings, not the raw docker [{HostPort}] array — otherwise _hostPorts
// stays empty and every subsequent fetch() throws "No port mapping".
describe('ContainerRuntime port-mapping adoption', () => {
	test('recovers host ports from a running container on start()', async () => {
		const fakeDocker = {
			inspect: async () => ({
				id: 'abc123',
				name: 'lopata-TestDO-deadbeefcafe',
				state: 'running' as const,
				exitCode: null,
				ports: { '8080/tcp': '0.0.0.0:32768', '9090/tcp': '127.0.0.1:32769' },
				// Own-process label so the adoption pid-check (CORR-23) adopts it.
				labels: { 'lopata.pid': String(process.pid) },
			}),
			registerExisting: () => {},
			remove: async () => {},
		} as unknown as DockerManager

		const runtime = new ContainerRuntime('TestDO', 'deadbeefcafe99', 'img:latest', fakeDocker)
		runtime.defaultPort = 8080
		runtime.requiredPorts = [9090]

		await runtime.start()
		try {
			expect(runtime.getHostPort(8080)).toBe(32768)
			expect(runtime.getHostPort(9090)).toBe(32769)
		} finally {
			await runtime.cleanup()
		}
	})
})
