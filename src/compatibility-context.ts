import { AsyncLocalStorage } from 'node:async_hooks'
import { type CompatibilitySelection, resolveCompatibility } from './compatibility'

export const legacyCompatibility = resolveCompatibility({})
const storage = new AsyncLocalStorage<CompatibilitySelection>()
let isolateCompatibility: CompatibilitySelection | undefined

export function initializeIsolateCompatibility(selection: CompatibilitySelection): void {
	if (isolateCompatibility) throw new Error('Isolate compatibility is already initialized')
	isolateCompatibility = resolveCompatibility({ date: selection.date ?? undefined, flags: selection.flags })
}

export function getActiveCompatibility(): CompatibilitySelection {
	return storage.getStore() ?? isolateCompatibility ?? legacyCompatibility
}

export function runWithCompatibility<T>(selection: CompatibilitySelection, callback: () => T): T {
	return storage.run(selection, callback)
}
