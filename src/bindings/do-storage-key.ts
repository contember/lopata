import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { localDurableObjectBindings, type WranglerConfig } from '../config'

/**
 * The key a Durable Object class's data is stored under: the `namespace` of `do_instances`, `do_storage` and
 * `do_alarms`, the `do-sql/<key>/` directory and the class names of `renamed_classes` / `deleted_classes` migrations.
 * The main worker (or the only one) uses the bare class name, so a single-worker project keeps its data; an auxiliary
 * worker prefixes its name, so two workers declaring the same class keep apart.
 */
export function doStorageKey(className: string, auxiliaryWorker: string | undefined): string {
	return auxiliaryWorker === undefined ? className : `${auxiliaryWorker}/${className}`
}

/** The `do_migrations` tag of a migration; auxiliary workers apply their own `v1` independently of the main worker's. */
export function doMigrationTag(tag: string, auxiliaryWorker: string | undefined): string {
	return auxiliaryWorker === undefined ? tag : `${auxiliaryWorker}/${tag}`
}

/** Durable Object classes a worker hosts: its local bindings and its container classes. */
function hostedClasses(config: WranglerConfig): Set<string> {
	return new Set([
		...localDurableObjectBindings(config).map(binding => binding.class_name),
		...(config.containers ?? []).map(container => container.class_name),
	])
}

const DO_TABLES = ['do_instances', 'do_storage', 'do_alarms'] as const

function hasRows(db: Database, key: string): boolean {
	return DO_TABLES.some(table => db.query<{ one: number }, [string]>(`SELECT 1 AS one FROM ${table} WHERE namespace = ? LIMIT 1`).get(key) !== null)
}

/**
 * Before per-worker keys, every worker stored a class under its bare name. Data under a bare name belongs to the main
 * worker, except for a class the main worker does not host and exactly one auxiliary worker does: that data moves to
 * the auxiliary worker's key. The table rows and the `do-sql` directory move separately, each only while the target
 * is still empty, so an interrupted move completes on the next start.
 */
export function moveAuxiliaryDurableObjectData(
	db: Database,
	dataDir: string,
	mainConfig: WranglerConfig,
	auxiliaryWorkers: ReadonlyArray<{ name: string; config: WranglerConfig }>,
): void {
	const mainClasses = hostedClasses(mainConfig)
	const hosts = new Map<string, string[]>()
	for (const worker of auxiliaryWorkers) {
		for (const className of hostedClasses(worker.config)) {
			if (mainClasses.has(className)) continue
			hosts.set(className, [...(hosts.get(className) ?? []), worker.name])
		}
	}
	for (const [className, workers] of hosts) {
		const [worker] = workers
		// Two auxiliary workers hosting the class shared its data; neither can claim it
		if (workers.length !== 1 || worker === undefined) continue
		const target = doStorageKey(className, worker)
		if (hasRows(db, className) && !hasRows(db, target)) {
			db.transaction(() => {
				for (const table of DO_TABLES) db.run(`UPDATE ${table} SET namespace = ? WHERE namespace = ?`, [target, className])
			}).immediate()
			console.log(`[lopata] Durable Object class ${className}: data moved to worker "${worker}" (stored as ${target})`)
		}
		const fromDir = join(dataDir, 'do-sql', className)
		const toDir = join(dataDir, 'do-sql', target)
		if (existsSync(fromDir) && !existsSync(toDir)) {
			mkdirSync(dirname(toDir), { recursive: true })
			renameSync(fromDir, toDir)
		}
	}
}
