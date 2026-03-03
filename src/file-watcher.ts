import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const WATCH_EXTENSIONS = new Set(['.ts', '.js', '.tsx', '.jsx', '.json'])
const IGNORE_DIRS = new Set(['.lopata', 'node_modules', '.git'])

export class FileWatcher {
	private dir: string
	private onChange: () => void
	private pollIntervalMs: number
	private pollTimer: ReturnType<typeof setInterval> | null = null
	private mtimeMap = new Map<string, number>()

	constructor(dir: string, onChange: () => void, pollIntervalMs = 500) {
		this.dir = dir
		this.onChange = onChange
		this.pollIntervalMs = pollIntervalMs
	}

	start(): void {
		if (this.pollTimer) return
		this.scanFiles(this.dir, this.mtimeMap)
		this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs)
	}

	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = null
		}
	}

	private poll(): void {
		const currentFiles = new Map<string, number>()
		this.scanFiles(this.dir, currentFiles)

		let changed = false
		for (const [file, mtime] of currentFiles) {
			const prev = this.mtimeMap.get(file)
			if (prev === undefined || prev !== mtime) {
				changed = true
				break
			}
		}
		if (!changed) {
			for (const file of this.mtimeMap.keys()) {
				if (!currentFiles.has(file)) {
					changed = true
					break
				}
			}
		}

		this.mtimeMap = currentFiles

		if (changed) {
			this.onChange()
		}
	}

	private scanFiles(dir: string, result: Map<string, number>): void {
		let entries: string[]
		try {
			entries = readdirSync(dir)
		} catch {
			return
		}
		for (const entry of entries) {
			if (IGNORE_DIRS.has(entry)) continue
			const fullPath = path.join(dir, entry)
			let stat
			try {
				stat = statSync(fullPath)
			} catch {
				continue
			}
			if (stat.isDirectory()) {
				this.scanFiles(fullPath, result)
			} else if (WATCH_EXTENSIONS.has(path.extname(entry))) {
				result.set(fullPath, stat.mtimeMs)
			}
		}
	}
}
