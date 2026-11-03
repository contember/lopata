/**
 * Where Worker Loader stubs write their modules: one directory per owner thread,
 * `<dataDir>/worker-loader/<pid>-<uuid>/`, holding each stub's own random directory.
 *
 * An owner thread is terminated without running any cleanup in it, so the thread that
 * spawned the owner removes its directory once it closes. A process that dies leaves its
 * directories behind; the next start removes those, keyed by the dead pid, and keeps the
 * directories of other live runtimes sharing the data directory.
 */

import { randomUUIDv7 } from 'bun'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export function createOwnerLoaderDir(dataDir: string): string {
	return join(dataDir, 'worker-loader', `${process.pid}-${randomUUIDv7()}`)
}

export function removeLoaderDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true })
}

/** Remove owner directories of processes that are no longer running. */
export function removeOrphanedLoaderDirs(dataDir: string): void {
	const root = join(dataDir, 'worker-loader')
	let entries: string[]
	try {
		entries = readdirSync(root)
	} catch {
		return
	}
	for (const entry of entries) {
		const pid = /^(\d+)-/.exec(entry)?.[1]
		if (pid !== undefined && !isProcessAlive(Number(pid))) removeLoaderDir(join(root, entry))
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return error instanceof Error && 'code' in error && error.code === 'EPERM'
	}
}

let mainThreadLoaderDir: string | undefined

/** The main thread's directory, shared by every env this process builds; creating it first removes dead processes' directories. */
export function getMainThreadLoaderDir(dataDir: string): string {
	if (mainThreadLoaderDir === undefined) {
		removeOrphanedLoaderDirs(dataDir)
		mainThreadLoaderDir = createOwnerLoaderDir(dataDir)
	}
	return mainThreadLoaderDir
}
