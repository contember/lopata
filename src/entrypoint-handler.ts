/**
 * Resolving a named handler off a worker's default export.
 *
 * Workers come in two shapes, and every dispatch path has to cope with both:
 *
 *   export default { fetch(request, env, ctx) {} }             // object literal
 *   export default class extends WorkerEntrypoint {            // class entrypoint
 *     async fetch(request) { … }                               //   prototype method
 *     scheduled = async (controller) => { … }                  //   or instance field
 *   }
 *
 * For a class, env and ctx arrive through the constructor rather than the argument
 * list, and the handler may live either on the prototype or on the instance — a field
 * initialiser only exists once the class has been constructed, which is why this
 * constructs first and inspects the instance afterwards. workerd does the same, so a
 * field-style handler is a legitimate worker that all three of our dispatch paths
 * (CLI worker thread, Vite dev server, test harness) used to miss.
 *
 * Class methods ignore any trailing (env, ctx) arguments, so callers can invoke the
 * returned function with one calling convention regardless of the shape it came from.
 */
export type EntrypointHandlerName = 'fetch' | 'scheduled' | 'email' | 'queue'

/** True when the default export is a class-style entrypoint rather than a handler object. */
export function isClassEntrypoint(defaultExport: unknown): boolean {
	return typeof defaultExport === 'function' && Boolean((defaultExport as { prototype?: unknown }).prototype)
}

/**
 * Resolve `name` off `defaultExport`, returning a callable bound to its owner, or null
 * when the worker has no such handler.
 *
 * Constructing a class entrypoint is itself observable (constructors can run user code),
 * so callers that resolve several handlers for one invocation should reuse the instance
 * via {@link constructEntrypoint} rather than calling this repeatedly.
 */
export function resolveEntrypointHandler(
	defaultExport: unknown,
	name: EntrypointHandlerName,
	ctx: unknown,
	env: unknown,
): ((...args: unknown[]) => unknown) | null {
	if (isClassEntrypoint(defaultExport)) {
		return handlerFromInstance(constructEntrypoint(defaultExport, ctx, env), name)
	}
	const obj = defaultExport as Record<string, unknown> | null | undefined
	const fn = obj?.[name]
	return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown).bind(obj) : null
}

/** Instantiate a class entrypoint the way workerd does — `new Entrypoint(ctx, env)`. */
export function constructEntrypoint(defaultExport: unknown, ctx: unknown, env: unknown): Record<string, unknown> {
	const Ctor = defaultExport as new(ctx: unknown, env: unknown) => Record<string, unknown>
	return new Ctor(ctx, env)
}

/** Pull a handler off an already-constructed entrypoint instance. */
export function handlerFromInstance(
	instance: Record<string, unknown>,
	name: EntrypointHandlerName,
): ((...args: unknown[]) => unknown) | null {
	const fn = instance[name]
	return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown).bind(instance) : null
}

/** A handler object: an exported object (not a function or an array) whose own methods are its handlers. */
export function isHandlerObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Look up and call an entrypoint's RPC method the way workerd does. A class instance's method gets the
 * caller's arguments, and `missing` reports a name that is not a method. A handler object (`target` is the
 * exported object itself) exposes only its own properties, checked before the property is read, and each
 * method is called as `(arg, env, ctx)`: it may declare at most those three parameters and the caller must
 * send exactly one argument.
 */
export function callEntrypointMethod(
	exported: unknown,
	target: Record<string, unknown>,
	name: string,
	args: unknown[],
	env: unknown,
	ctx: unknown,
	missing: () => Error,
): unknown {
	if (target !== exported || !isHandlerObject(exported)) {
		const method = target[name]
		if (typeof method !== 'function') throw missing()
		return Reflect.apply(method, target, args)
	}
	if (!Object.hasOwn(target, name)) throw new TypeError(`The RPC receiver does not implement the method "${name}".`)
	const method = target[name]
	if (typeof method !== 'function') throw new TypeError(`"${name}" is not a function.`)
	if (method.length > 3) {
		throw new TypeError(
			`Cannot call handler function "${name}" over RPC because it has the wrong number of arguments. A simple function handler can only be called over RPC if it has exactly the arguments (arg, env, ctx), where only the first argument comes from the client. To support multi-argument RPC functions, use class-based syntax (extending WorkerEntrypoint) instead.`,
		)
	}
	if (args.length !== 1) {
		throw new TypeError(
			`Attempted to call RPC function "${name}" with the wrong number of arguments. When calling a top-level handler function that is not declared as part of a class, you must always send exactly one argument. In order to support variable numbers of arguments, the server must use class-based syntax (extending WorkerEntrypoint) instead.`,
		)
	}
	return Reflect.apply(method, target, [args[0], env, ctx])
}
