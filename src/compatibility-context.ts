import { AsyncLocalStorage } from 'node:async_hooks'
import { type CompatibilitySelection, resolveCompatibility } from './compatibility'

export const legacyCompatibility = resolveCompatibility({})
const storage = new AsyncLocalStorage<CompatibilitySelection>()

export function getActiveCompatibility(): CompatibilitySelection {
	return storage.getStore() ?? legacyCompatibility
}

export function runWithCompatibility<T>(selection: CompatibilitySelection, callback: () => T): T {
	return storage.run(selection, callback)
}
