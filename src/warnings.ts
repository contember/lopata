export interface OptionalDep {
	id: string
	description: string
	install: string
	installed: boolean
}

function isAvailable(name: string): boolean {
	try {
		import.meta.resolve(name)
		return true
	} catch {
		return false
	}
}

const OPTIONAL_DEPS: { id: string; description: string; install: string }[] = [
	{ id: 'html-rewriter-wasm', description: 'HTMLRewriter API', install: 'bun add html-rewriter-wasm' },
	{ id: 'sharp', description: 'Image transformations', install: 'bun add sharp' },
	{ id: 'puppeteer-core', description: 'Browser rendering', install: 'bun add puppeteer-core' },
]

const resolved: OptionalDep[] = OPTIONAL_DEPS.map(dep => ({
	...dep,
	installed: isAvailable(dep.id),
}))

export function getOptionalDeps(): OptionalDep[] {
	return resolved
}
