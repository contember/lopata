import { DurableObjectIdImpl, type DurableObjectNamespaceImpl, hashIdFromName, randomUniqueIdHex } from './durable-object'
import { makeBindingProxy } from './rpc-stub'

type HostStub = Record<string, unknown>

function callHostStub(stub: HostStub, method: string, args: unknown[]): unknown {
	const member = stub[method]
	if (typeof member !== 'function') throw new Error(`Durable Object stub has no method "${method}"`)
	return Reflect.apply(member, stub, args)
}

/**
 * Main-side namespace of a `durable_objects` binding with `script_name`.
 *
 * The worker named by `script_name` hosts the class, so calls go to stubs of that worker's
 * namespace: every worker reaches the same instances, and the hosting worker owns their
 * storage, alarms and executors. IDs are derived the same way in every worker, so an id
 * made here addresses the same instance as one made by the hosting worker.
 *
 * The host is resolved when a stub is first called, not when it is created: the hosting
 * worker may still be loading (two workers that bind each other's classes cannot both load first).
 */
export class CrossScriptDurableObjectNamespace {
	private resolveHost: (() => Promise<DurableObjectNamespaceImpl>) | null = null
	private stubs = new Map<string, HostStub>()

	constructor(
		private readonly bindingName: string,
		private readonly scriptName: string,
		private readonly className: string,
	) {}

	/** Point the binding at the hosting worker's namespace. It is resolved on every call, so a reload of that worker is picked up. */
	_wire(resolveHost: () => Promise<DurableObjectNamespaceImpl>): void {
		this.resolveHost = resolveHost
	}

	newUniqueId(_options?: { jurisdiction?: string }): DurableObjectIdImpl {
		return new DurableObjectIdImpl(randomUniqueIdHex())
	}

	idFromName(name: string): DurableObjectIdImpl {
		return new DurableObjectIdImpl(hashIdFromName(name), name)
	}

	idFromString(id: string): DurableObjectIdImpl {
		return new DurableObjectIdImpl(id)
	}

	get(id: DurableObjectIdImpl): HostStub {
		// Keyed like the host namespace's own stubs, so each keeps its caller's `id.name`.
		const key = `${id.toString()}:${id.name ?? ''}`
		const cached = this.stubs.get(key)
		if (cached) return cached
		const hostStub = async () => (await this.host()).get(id)
		const stub = makeBindingProxy(
			{
				fetch: async (input, init) => {
					const response = await callHostStub(await hostStub(), 'fetch', [input, init])
					if (!(response instanceof Response)) throw new Error(`Durable Object "${this.className}" fetch() did not return a Response`)
					return response
				},
				call: async (method, args) => callHostStub(await hostStub(), method, args),
				getProperty: async property => (await hostStub())[property],
			},
			{ id, name: id.name },
		)
		this.stubs.set(key, stub)
		return stub
	}

	getByName(name: string): HostStub {
		return this.get(this.idFromName(name))
	}

	private host(): Promise<DurableObjectNamespaceImpl> {
		if (!this.resolveHost) {
			throw new Error(
				`Durable Object binding "${this.bindingName}" uses class "${this.className}" of worker "${this.scriptName}", `
					+ 'but lopata does not run that worker. Add it to `workers` in lopata.config.ts or to `auxiliaryWorkers` of the Vite plugin.',
			)
		}
		return this.resolveHost()
	}
}
