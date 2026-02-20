import { type FSWatcher, watch } from 'node:fs'
import path from 'node:path'

const WATCH_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.json'])
const IGNORE_DIRS = new Set(['.bunflare', 'node_modules', '.git'])

export class FileWatcher {
	private dir: string
	private onChange: () => void
	private debounceMs: number
	private watcher: FSWatcher | null = null
	private debounceTimer: ReturnType<typeof setTimeout> | null = null

	constructor(dir: string, onChange: () => void, debounceMs = 150) {
		this.dir = dir
		this.onChange = onChange
		this.debounceMs = debounceMs
	}

	start(): void {
		if (this.watcher) return
		this.watcher = watch(this.dir, { recursive: true }, (_event, filename) => {
			if (!filename) return
			if (!this.shouldWatch(filename)) return
			this.scheduleChange()
		})
	}

	stop(): void {
		if (this.watcher) {
			this.watcher.close()
			this.watcher = null
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = null
		}
	}

	private shouldWatch(filename: string): boolean {
		const ext = path.extname(filename)
		if (!WATCH_EXTENSIONS.has(ext)) return false
		const parts = filename.split(path.sep)
		for (const part of parts) {
			if (IGNORE_DIRS.has(part)) return false
		}
		return true
	}

	private scheduleChange(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer)
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null
			this.onChange()
		}, this.debounceMs)
	}
}
