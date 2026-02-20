/**
 * Lightweight env builder for DO worker threads.
 *
 * Each worker thread opens its own Database connection to the same
 * .bunflare/data.sqlite (WAL mode ensures safe concurrent access).
 * It builds binding instances (KV, R2, D1, queues) that wrap the
 * shared DB/filesystem — these are stateless wrappers safe to duplicate.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WranglerConfig } from '../config'
import { runMigrations } from '../db'
import { openD1Database } from './d1'
import { DurableObjectNamespaceImpl } from './durable-object'
import { SqliteKVNamespace } from './kv'
import { SqliteQueueProducer } from './queue'
import { FileR2Bucket } from './r2'

/**
 * Build a minimal env for use inside a DO worker thread.
 * DOs created here use InProcessExecutor (nested DOs run in the worker thread).
 */
export function buildWorkerEnv(
	config: WranglerConfig,
	dataDir: string,
): { db: Database; env: Record<string, unknown>; doNamespaces: { className: string; namespace: DurableObjectNamespaceImpl }[] } {
	// Open own DB connection (WAL mode for safe concurrency)
	const dbPath = join(dataDir, 'data.sqlite')
	mkdirSync(dataDir, { recursive: true })
	const db = new Database(dbPath, { create: true })
	db.run('PRAGMA journal_mode=WAL')
	runMigrations(db)

	const env: Record<string, unknown> = {}
	const doNamespaces: { className: string; namespace: DurableObjectNamespaceImpl }[] = []

	// Environment variables
	if (config.vars) {
		for (const [key, value] of Object.entries(config.vars)) {
			env[key] = value
		}
	}

	// KV namespaces
	for (const kv of config.kv_namespaces ?? []) {
		env[kv.binding] = new SqliteKVNamespace(db, kv.id)
	}

	// R2 buckets
	for (const r2 of config.r2_buckets ?? []) {
		env[r2.binding] = new FileR2Bucket(db, r2.bucket_name, dataDir)
	}

	// Durable Objects — each runs in-process within this worker thread
	for (const doBinding of config.durable_objects?.bindings ?? []) {
		const namespace = new DurableObjectNamespaceImpl(db, doBinding.class_name, dataDir)
		env[doBinding.name] = namespace
		doNamespaces.push({ className: doBinding.class_name, namespace })
	}

	// D1 databases
	for (const d1 of config.d1_databases ?? []) {
		env[d1.binding] = openD1Database(dataDir, d1.database_name)
	}

	// Queue producers
	for (const producer of config.queues?.producers ?? []) {
		env[producer.binding] = new SqliteQueueProducer(db, producer.queue, producer.delivery_delay ?? 0)
	}

	return { db, env, doNamespaces }
}
