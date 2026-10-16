/**
 * `ctx.exports`: loopback bindings to a worker's own exports, built the way workerd
 * builds them (`server.c++` after `validateHandlers()`):
 *
 * - the default export and each named `WorkerEntrypoint` class or handler object →
 *   a loopback service stub: a Fetcher with empty props that can be called as
 *   `exports.Name({ props })` to get a Fetcher whose entrypoint sees `ctx.props`;
 * - each exported Durable Object class with storage configured → its namespace.
 *
 * Workflow classes are left out, as in workerd. Durable Object classes without
 * storage are too: workerd exposes them as facet classes, which lopata does not support.
 */

import { localDurableObjectBindings, type WranglerConfig } from '../config'
import { FETCHER_BRAND, WORKER_ENTRYPOINT_BRAND } from './rpc-stub'
import { ServiceBinding } from './service-binding'

/** Marks the unspecialized stub, which workerd refuses to serialize until it is given props. */
export const LOOPBACK_SERVICE_STUB_BRAND = Symbol.for('lopata.LoopbackServiceStub')

export function isLoopbackServiceStub(value: unknown): boolean {
	return typeof value === 'function' && Reflect.get(value, LOOPBACK_SERVICE_STUB_BRAND) === true
}

/** A Durable Object class with storage configured, and the env binding of its namespace. */
export interface DurableObjectNamespaceBinding {
	className: string
	bindingName: string
}

/** The namespaces a worker hosts: its own `durable_objects` bindings plus container classes. */
export function durableObjectNamespaceBindings(config: WranglerConfig): DurableObjectNamespaceBinding[] {
	const bindings = localDurableObjectBindings(config).map(b => ({ className: b.class_name, bindingName: b.name }))
	for (const container of config.containers ?? []) {
		if (bindings.some(b => b.className === container.class_name)) continue
		bindings.push({ className: container.class_name, bindingName: container.name ?? container.class_name })
	}
	return bindings
}

export function buildLoopbackExports(
	workerModule: Record<string, unknown>,
	env: Record<string, unknown>,
	namespaces: DurableObjectNamespaceBinding[],
): Record<string, unknown> {
	const exports: Record<string, unknown> = {}
	for (const [name, value] of Object.entries(workerModule)) {
		const entrypoint = name === 'default' ? undefined : name
		if (isWorkerEntrypointClass(value) || isHandlerObject(value)) {
			exports[name] = createLoopbackServiceStub(name, entrypoint, workerModule, env)
			continue
		}
		const namespace = typeof value === 'function' && entrypoint ? namespaces.find(n => n.className === name) : undefined
		if (namespace) exports[name] = env[namespace.bindingName]
	}
	return exports
}

function isWorkerEntrypointClass(value: unknown): boolean {
	return typeof value === 'function' && Reflect.get(value, WORKER_ENTRYPOINT_BRAND) === true
}

function isHandlerObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null
}

function createLoopbackServiceStub(
	name: string,
	entrypoint: string | undefined,
	workerModule: Record<string, unknown>,
	env: Record<string, unknown>,
): (options?: { props?: Record<string, unknown> }) => Record<string, unknown> {
	const specialize = (props?: Record<string, unknown>): Record<string, unknown> => {
		// Props cross a serialization boundary in workerd; cloning keeps the caller's object out of the callee's ctx.
		const binding = new ServiceBinding(`ctx.exports.${name}`, entrypoint, undefined, props === undefined ? undefined : structuredClone(props))
		binding._wire(workerModule, env)
		return binding.toProxy()
	}
	const withoutProps = specialize()
	const call = (options?: { props?: Record<string, unknown> }) => specialize(options?.props)
	return new Proxy(call, {
		get(_target, prop) {
			if (prop === LOOPBACK_SERVICE_STUB_BRAND) return true
			if (prop === FETCHER_BRAND) return false
			return Reflect.get(withoutProps, prop)
		},
	})
}
