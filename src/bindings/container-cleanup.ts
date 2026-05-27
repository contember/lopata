/**
 * Main-side registry of active Docker containers spawned by lopata.
 *
 * Containers come from two places: the in-process path (dashboard API
 * handlers + the legacy/vite-plugin executor in `env.ts`) and the DO worker
 * threads. DO workers call `register` / `unregister` via postMessage
 * (`container-registered` / `container-removed` in `do-executor-worker.ts`);
 * the in-process callers invoke the helpers directly through the
 * `DockerManager` constructor callbacks.
 *
 * Two safety nets:
 *
 *   1. An `exit` listener `docker rm -f`s anything still tracked at process
 *      shutdown. Synchronous (`Bun.spawnSync`) since `exit` doesn't await.
 *
 *   2. `reapOrphanContainers()` scans for containers labeled `lopata=1`
 *      whose `lopata.pid` is no longer alive — cleans up leftovers from
 *      crashes / SIGKILL where (1) never ran. Invoked once at lopata
 *      startup from `cli/dev.ts`.
 */

import { $ } from 'bun'

/** Marker label on every lopata-managed container. */
export const LOPATA_LABEL_KEY = 'lopata'
export const LOPATA_LABEL_VALUE = '1'
/** Pid sub-label so the reaper can detect orphans of dead processes. */
export const LOPATA_PID_LABEL_KEY = 'lopata.pid'

/** Labels passed to `DockerManager` (constructor) for every `docker run`. */
export function containerLabels(): Record<string, string> {
	return {
		[LOPATA_LABEL_KEY]: LOPATA_LABEL_VALUE,
		[LOPATA_PID_LABEL_KEY]: String(process.pid),
	}
}

const activeContainers = new Set<string>()
let exitHandlerRegistered = false

function ensureExitHandlerRegistered(): void {
	if (exitHandlerRegistered) return
	exitHandlerRegistered = true
	process.on('exit', () => {
		if (activeContainers.size === 0) return
		// `exit` is synchronous-only; a single batched call keeps shutdown
		// snappy even with many containers. `docker rm -f` accepts a list.
		try {
			Bun.spawnSync(['docker', 'rm', '-f', ...activeContainers])
		} catch {
			// best-effort cleanup
		}
		activeContainers.clear()
	})
}

export function registerContainer(name: string): void {
	ensureExitHandlerRegistered()
	activeContainers.add(name)
}

export function unregisterContainer(name: string): void {
	activeContainers.delete(name)
}

/** @internal Test hook — current tracked container set. */
export function _activeContainersSnapshot(): string[] {
	return [...activeContainers]
}

/**
 * Reap containers labeled `lopata=1` whose `lopata.pid` is no longer alive.
 * Returns the number of orphans removed. Silently returns 0 if docker isn't
 * available so non-container users aren't penalised.
 */
export async function reapOrphanContainers(): Promise<number> {
	let listOut: string
	try {
		const format = `{{.Names}}|{{.Label "${LOPATA_PID_LABEL_KEY}"}}`
		const result = await $`docker ps -a --filter label=${LOPATA_LABEL_KEY}=${LOPATA_LABEL_VALUE} --format ${format}`.quiet().nothrow()
		if (result.exitCode !== 0) return 0
		listOut = result.stdout.toString()
	} catch {
		return 0
	}

	const orphans = _selectOrphanNames(listOut, isProcessAlive)
	if (orphans.length === 0) return 0
	await $`docker rm -f ${orphans}`.quiet().nothrow()
	return orphans.length
}

/**
 * @internal Pure-function core of {@link reapOrphanContainers}, exported for
 * tests. Parses the `docker ps` `{{.Names}}|{{.Label ...}}` table and returns
 * the container names whose owner pid is unknown, unparseable, or dead.
 */
export function _selectOrphanNames(listOut: string, alive: (pid: number) => boolean): string[] {
	const orphans: string[] = []
	for (const line of listOut.split('\n')) {
		if (!line) continue
		const sep = line.indexOf('|')
		const name = sep === -1 ? line : line.slice(0, sep)
		const pidStr = sep === -1 ? '' : line.slice(sep + 1)
		if (!name) continue
		const pid = pidStr ? Number.parseInt(pidStr, 10) : Number.NaN
		// Live pid → another lopata owns it. Missing/unparseable/dead/≤0 → orphan.
		if (Number.isFinite(pid) && pid > 0 && alive(pid)) continue
		orphans.push(name)
	}
	return orphans
}

function isProcessAlive(pid: number): boolean {
	// `process.kill(0, 0)` on POSIX signals the whole process group, which
	// succeeds whenever the caller has a group — so pid 0 must NOT be treated
	// as "alive". Negative pids are invalid; treat both as dead.
	if (pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}
