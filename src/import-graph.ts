import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Import-graph watching for the dev server.
 *
 * The naive watcher polls a single directory (`dirname(config.main)`), which
 * misses edits to code the worker imports from OUTSIDE that directory — e.g. an
 * entry at `workers/app.ts` that imports handlers from `../app/**`. Because the
 * worker-thread executor re-imports the WHOLE module graph on every reload, the
 * only thing missing is the trigger: we just need to watch the files the worker
 * actually depends on.
 *
 * We resolve that set statically with Bun's transpiler (`scanImports`) +
 * `Bun.resolveSync`, following only project-local files (under `baseDir`, never
 * `node_modules`). This needs no internal runtime registry (`globalThis.Loader`
 * is gone in current Bun) and no bundler step.
 *
 * Caveat: a static scan cannot see fully-dynamic `import(variable)` targets. In
 * practice worker entrypoints import statically; a dynamic target only fails to
 * auto-reload until it is reached from a statically-imported file.
 */

/** Extensions we parse for further imports. Others (e.g. .json) are watched but not scanned. */
const SCANNABLE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/**
 * Walk the worker's transitive import graph from `entry`, returning the set of
 * absolute project-source paths it depends on (entry included). Anything that
 * resolves outside `baseDir` or into `node_modules` is treated as external and
 * not followed.
 */
export function collectImportGraph(entry: string, baseDir: string): Set<string> {
	const seen = new Set<string>()
	const transpiler = new Bun.Transpiler({ loader: 'tsx' })
	const root = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep
	const stack = [path.resolve(entry)]

	while (stack.length > 0) {
		const file = stack.pop()!
		if (seen.has(file)) continue
		seen.add(file)
		if (!SCANNABLE.has(path.extname(file))) continue

		let code: string
		try {
			code = readFileSync(file, 'utf8')
		} catch {
			continue
		}
		let imports: { path: string }[]
		try {
			imports = transpiler.scanImports(code)
		} catch {
			continue // unparseable file — skip its imports, still watch the file itself
		}

		const dir = path.dirname(file)
		for (const imp of imports) {
			let resolved: string
			try {
				resolved = Bun.resolveSync(imp.path, dir)
			} catch {
				continue // bare/builtin/unresolvable (node:*, external pkg) — not project source
			}
			// Follow only project-local files; never descend into dependencies.
			if (!resolved.startsWith(root) || resolved.includes(`${path.sep}node_modules${path.sep}`)) continue
			if (!seen.has(resolved)) stack.push(resolved)
		}
	}
	return seen
}

/**
 * Polls the worker's import graph for changes (mtime-based) and fires `onChange`.
 * After a reload the caller should `rescan()` so newly-added imports start being
 * watched (and deleted files stop being watched).
 */
export class ImportGraphWatcher {
	private mtimes = new Map<string, number>()
	private timer: ReturnType<typeof setInterval> | null = null

	constructor(
		private entry: string,
		private baseDir: string,
		private onChange: () => void,
		private pollIntervalMs = 500,
	) {}

	start(): void {
		if (this.timer) return
		this.rescan()
		this.timer = setInterval(() => this.poll(), this.pollIntervalMs)
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Recompute the watched set from the current import graph. */
	rescan(): void {
		const next = new Map<string, number>()
		for (const file of collectImportGraph(this.entry, this.baseDir)) {
			try {
				next.set(file, statSync(file).mtimeMs)
			} catch {
				// vanished between scan and stat — drop it
			}
		}
		this.mtimes = next
	}

	/** Number of files currently watched (for the startup log line). */
	get size(): number {
		return this.mtimes.size
	}

	private poll(): void {
		let changed = false
		for (const [file, prev] of this.mtimes) {
			let mtime: number
			try {
				mtime = statSync(file).mtimeMs
			} catch {
				// deleted — a real change; refreshed on the next rescan()
				this.mtimes.delete(file)
				changed = true
				continue
			}
			if (mtime !== prev) {
				this.mtimes.set(file, mtime)
				changed = true
			}
		}
		if (changed) this.onChange()
	}
}
