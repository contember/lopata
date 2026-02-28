import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalD1Database } from '../bindings/d1'
import type { DurableObjectNamespaceImpl } from '../bindings/durable-object'
import { SqliteKVNamespace } from '../bindings/kv'
import { SqliteQueueProducer } from '../bindings/queue'
import { FileR2Bucket } from '../bindings/r2'
import { createServiceBinding } from '../bindings/service-binding'
import type { SqliteWorkflowBinding } from '../bindings/workflow'
import type { WranglerConfig } from '../config'
import { runMigrations } from '../db'
import type { BindingSpec } from './types'

interface ServiceBindingEntry {
	bindingName: string
	serviceName: string
	entrypoint?: string
	proxy: Record<string, unknown>
}

export interface TestClassRegistry {
	durableObjects: { bindingName: string; className: string; namespace: DurableObjectNamespaceImpl }[]
	workflows: { bindingName: string; className: string; binding: SqliteWorkflowBinding }[]
	serviceBindings: ServiceBindingEntry[]
}

export interface BuiltTestEnv {
	db: Database
	env: Record<string, unknown>
	registry: TestClassRegistry
	tmpDirs: string[]
}

export function buildTestEnv(
	bindings: Record<string, BindingSpec> | undefined,
	vars: Record<string, string> | undefined,
): BuiltTestEnv {
	const db = new Database(':memory:')
	runMigrations(db)

	const env: Record<string, unknown> = {}
	const registry: TestClassRegistry = { durableObjects: [], workflows: [], serviceBindings: [] }
	const tmpDirs: string[] = []

	if (vars) {
		for (const [key, value] of Object.entries(vars)) {
			env[key] = value
		}
	}

	if (!bindings) {
		return { db, env, registry, tmpDirs }
	}

	for (const [bindingName, spec] of Object.entries(bindings)) {
		if (spec === 'kv') {
			env[bindingName] = new SqliteKVNamespace(db, bindingName)
		} else if (spec === 'r2') {
			const tmpDir = mkdtempSync(join(tmpdir(), 'lopata-test-r2-'))
			tmpDirs.push(tmpDir)
			env[bindingName] = new FileR2Bucket(db, bindingName, tmpDir)
		} else if (spec === 'd1') {
			env[bindingName] = new LocalD1Database(new Database(':memory:'))
		} else if (spec === 'queue') {
			env[bindingName] = new SqliteQueueProducer(db, bindingName)
		} else if (typeof spec === 'object') {
			if (spec.type === 'durable-object') {
				// Lazy import to avoid pulling in the whole DO module at parse time
				const { DurableObjectNamespaceImpl } = require('../bindings/durable-object')
				const namespace = new DurableObjectNamespaceImpl(db, spec.className, undefined, { evictionTimeoutMs: 0 })
				env[bindingName] = namespace
				registry.durableObjects.push({ bindingName, className: spec.className, namespace })
			} else if (spec.type === 'workflow') {
				const { SqliteWorkflowBinding } = require('../bindings/workflow')
				const binding = new SqliteWorkflowBinding(db, bindingName, spec.className)
				env[bindingName] = binding
				registry.workflows.push({ bindingName, className: spec.className, binding })
			} else if (spec.type === 'service') {
				const proxy = createServiceBinding(spec.service, spec.entrypoint)
				env[bindingName] = proxy
				registry.serviceBindings.push({
					bindingName,
					serviceName: spec.service,
					entrypoint: spec.entrypoint,
					proxy,
				})
			}
		}
	}

	return { db, env, registry, tmpDirs }
}

/** Translate a WranglerConfig into a flat BindingSpec map + vars */
export function configToBindings(config: WranglerConfig): { bindings: Record<string, BindingSpec>; vars: Record<string, string> } {
	const bindings: Record<string, BindingSpec> = {}
	const vars: Record<string, string> = { ...config.vars }

	for (const kv of config.kv_namespaces ?? []) {
		bindings[kv.binding] = 'kv'
	}
	for (const r2 of config.r2_buckets ?? []) {
		bindings[r2.binding] = 'r2'
	}
	for (const d1 of config.d1_databases ?? []) {
		bindings[d1.binding] = 'd1'
	}
	for (const producer of config.queues?.producers ?? []) {
		bindings[producer.binding] = 'queue'
	}
	for (const doBinding of config.durable_objects?.bindings ?? []) {
		bindings[doBinding.name] = { type: 'durable-object', className: doBinding.class_name }
	}
	for (const wf of config.workflows ?? []) {
		bindings[wf.binding] = { type: 'workflow', className: wf.class_name }
	}
	for (const svc of config.services ?? []) {
		bindings[svc.binding] = { type: 'service', service: svc.service, entrypoint: svc.entrypoint }
	}

	return { bindings, vars }
}
